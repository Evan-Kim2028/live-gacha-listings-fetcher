import { listingMatchesFilter } from "../filter.js";
import { scopeKey } from "../querySignature.js";
import type { PullQuery } from "../providers/types.js";
import type { Listing, SyncResult } from "../types.js";
import type {
  Alert,
  AlertScopeRef,
  AlertsFromSyncExtra,
  SoftFailAlert,
  SoftFailAlertInput,
  UnderFmvAlert,
} from "./types.js";

/**
 * True when origin normalize already set both `fmv` and `delta` and price is
 * under FMV (`delta < 0`). Does not invent FMV or call price oracles.
 */
export function hasOriginUnderFmv(listing: Listing): boolean {
  return (
    listing.fmv != null &&
    Number.isFinite(listing.fmv) &&
    listing.fmv > 0 &&
    listing.delta != null &&
    Number.isFinite(listing.delta) &&
    listing.delta < 0
  );
}

/** Build an under_fmv alert only when origin fmv/delta are present and under FMV. */
export function underFmvAlertIfAny(
  listing: Listing,
  base: { ts: string; provider: string; qsig?: string },
): UnderFmvAlert | null {
  if (!hasOriginUnderFmv(listing)) return null;
  return {
    ts: base.ts,
    kind: "under_fmv",
    provider: listing.provider || base.provider,
    listing,
    fmv: listing.fmv as number,
    delta: listing.delta as number,
    qsig: base.qsig,
  };
}

/**
 * Whether an alert matches a decision filter.
 * Soft-fail has no listing — always passes (provider ops surface).
 * Closed uses last-known listing when available; otherwise passes.
 * All listing alerts (including under_fmv) use {@link listingMatchesFilter}
 * so `maxDelta` / `requireFmv` / tcg / platform / price bands apply.
 */
export function alertMatches(alert: Alert, filter: PullQuery = {}): boolean {
  if (alert.kind === "soft_fail") return true;
  if (alert.kind === "closed") {
    if (!alert.listing) return true;
    return listingMatchesFilter(alert.listing, filter);
  }
  return listingMatchesFilter(alert.listing, filter);
}

export function filterAlerts(
  alerts: Alert[],
  filter: PullQuery = {},
): Alert[] {
  return alerts.filter((a) => alertMatches(a, filter));
}

/**
 * Stateful listing diff → trader Alert events.
 * Tracks last-known listings per scope for new_listing / reprice / closed
 * and emits optional under_fmv when origin fmv+delta are already set.
 */
export class AlertEngine {
  /** id → last observed listing */
  private readonly known = new Map<string, Listing>();
  /** scopeKey → active ids */
  private readonly scopeIds = new Map<string, Set<string>>();

  getKnown(id: string): Listing | undefined {
    const v = this.known.get(id);
    return v ? { ...v } : undefined;
  }

  size(): number {
    return this.known.size;
  }

  /**
   * Diff listings against last known for this scope.
   * Emits new_listing / reprice / closed; under_fmv when origin fields allow.
   */
  onListingsDiff(
    listings: Listing[],
    scope: AlertScopeRef,
    ts: string = new Date().toISOString(),
  ): Alert[] {
    const provider = scope.provider;
    const qsig = scope.querySignature ?? "";
    const sk = scopeKey(provider, qsig);
    const prevIds = this.scopeIds.get(sk) ?? new Set<string>();
    const nextIds = new Set<string>();
    const events: Alert[] = [];
    const base = { ts, provider, qsig: qsig || undefined };

    for (const listing of listings) {
      const id = listing.id;
      nextIds.add(id);
      const prev = this.known.get(id);
      if (!prev) {
        events.push({
          ...base,
          kind: "new_listing",
          provider: listing.provider || provider,
          listing,
        });
        const uf = underFmvAlertIfAny(listing, {
          ...base,
          provider: listing.provider || provider,
        });
        if (uf) events.push(uf);
      } else if (prev.price !== listing.price) {
        events.push({
          ...base,
          kind: "reprice",
          provider: listing.provider || provider,
          listing,
          prevPrice: prev.price,
        });
        const uf = underFmvAlertIfAny(listing, {
          ...base,
          provider: listing.provider || provider,
        });
        if (uf) events.push(uf);
      } else {
        // Same price: still emit under_fmv if origin fields newly appear and under FMV
        // and we did not already fire for this id at same fmv/delta (avoid spam on
        // quiet re-pulls of unchanged under-FMV rows).
        const prevHad =
          prev.fmv != null &&
          prev.delta != null &&
          prev.fmv === listing.fmv &&
          prev.delta === listing.delta;
        if (!prevHad) {
          const uf = underFmvAlertIfAny(listing, {
            ...base,
            provider: listing.provider || provider,
          });
          if (uf) events.push(uf);
        }
      }
      this.known.set(id, { ...listing });
    }

    for (const id of prevIds) {
      if (nextIds.has(id)) continue;
      const last = this.known.get(id);
      events.push({
        ...base,
        kind: "closed",
        id,
        listing: last ? { ...last } : undefined,
      });
      let heldElsewhere = false;
      for (const [otherKey, ids] of this.scopeIds) {
        if (otherKey === sk) continue;
        if (ids.has(id)) {
          heldElsewhere = true;
          break;
        }
      }
      if (!heldElsewhere) this.known.delete(id);
    }

    this.scopeIds.set(sk, nextIds);
    return events;
  }

  /**
   * Apply SyncResult: short-circuit → no listing alerts; else diff result.listings.
   * Soft-fail (extra.softFail or empty short-circuit with lastError) → soft_fail only.
   */
  onSyncResult(
    result: SyncResult,
    extra: AlertsFromSyncExtra = {},
  ): Alert[] {
    const ts = extra.ts ?? new Date().toISOString();
    if (extra.softFail || extra.lastError) {
      return [
        softFailAlert({
          provider: result.provider,
          error: String(extra.lastError ?? "soft_fail"),
          lastSuccessfulPullAt: extra.watermark?.lastSuccessfulPullAt,
          lastRowCount: extra.watermark?.lastRowCount,
          qsig: result.querySignature || undefined,
          ts,
          watermark: extra.watermark,
        }),
      ];
    }
    if (result.shortCircuited) return [];
    return this.onListingsDiff(
      result.listings,
      { provider: result.provider, querySignature: result.querySignature },
      ts,
    );
  }

  softFail(input: SoftFailAlertInput): SoftFailAlert {
    return softFailAlert(input);
  }
}

export function softFailAlert(input: SoftFailAlertInput): SoftFailAlert {
  const wm = input.watermark;
  return {
    ts: input.ts ?? new Date().toISOString(),
    kind: "soft_fail",
    provider: input.provider,
    error: input.error,
    lastSuccessfulPullAt:
      input.lastSuccessfulPullAt ?? wm?.lastSuccessfulPullAt ?? null,
    lastRowCount: input.lastRowCount ?? wm?.lastRowCount,
    qsig: input.qsig,
  };
}

/**
 * Stateless one-shot: diff two listing arrays for a scope (no engine state).
 * Useful for pure unit tests / external maps.
 */
export function alertsFromListingDiff(
  previous: Listing[],
  next: Listing[],
  scope: AlertScopeRef,
  ts: string = new Date().toISOString(),
): Alert[] {
  const engine = new AlertEngine();
  if (previous.length > 0) {
    engine.onListingsDiff(previous, scope, ts);
  }
  return engine.onListingsDiff(next, scope, ts);
}
