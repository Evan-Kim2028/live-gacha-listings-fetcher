import { scopeKey } from "../querySignature.js";
import type { Listing, SyncResult } from "../types.js";
import type {
  ListingChangeEvent,
  ListingDeltaFields,
  ScopeRef,
  SoftFailEvent,
} from "./types.js";

function deltaFields(l: Listing): ListingDeltaFields {
  return {
    price: l.price,
    listedAt: l.listedAt ?? null,
    seller: l.seller ?? null,
  };
}

function fieldsEqual(a: ListingDeltaFields, b: ListingDeltaFields): boolean {
  return (
    a.price === b.price &&
    a.listedAt === b.listedAt &&
    a.seller === b.seller
  );
}

export interface ListingChangeLogOptions {
  /**
   * When true (default), keep full last page per scope for run snapshots.
   * Set false in lean capture to avoid a second full book in RAM.
   */
  retainScopeListings?: boolean;
}

/**
 * In-memory last-known listing map + scope id-sets.
 * Diffs by id on price / listedAt / seller only — no full-row dumps unless
 * {@link ListingChangeLogOptions.retainScopeListings} is enabled.
 */
export class ListingChangeLog {
  /** id → last observed delta fields + provider */
  private readonly known = new Map<
    string,
    ListingDeltaFields & { provider: string }
  >();
  /** scopeKey → active ids for that provider+query */
  private readonly scopeIds = new Map<string, Set<string>>();
  /** scopeKey → full last page (for sparse snapshots); optional */
  private readonly scopeListings = new Map<string, Listing[]>();
  /** scopeKey → dirty since last checkpoint */
  private readonly dirtyScopes = new Set<string>();
  private readonly retainScopeListings: boolean;

  constructor(opts: ListingChangeLogOptions = {}) {
    this.retainScopeListings = opts.retainScopeListings !== false;
  }

  /** Last known fields for id, if any. */
  getKnown(id: string): (ListingDeltaFields & { provider: string }) | undefined {
    const v = this.known.get(id);
    return v ? { ...v } : undefined;
  }

  size(): number {
    return this.known.size;
  }

  listScope(provider: string, querySignature = ""): Listing[] {
    const key = scopeKey(provider, querySignature);
    return [...(this.scopeListings.get(key) ?? [])];
  }

  isDirty(provider: string, querySignature = ""): boolean {
    return this.dirtyScopes.has(scopeKey(provider, querySignature));
  }

  clearDirty(provider: string, querySignature = ""): void {
    this.dirtyScopes.delete(scopeKey(provider, querySignature));
  }

  dirtyScopeKeys(): string[] {
    return [...this.dirtyScopes];
  }

  /**
   * Diff `listings` against last known by id for this scope.
   * Emits new / reprice / closed only. Updates internal maps.
   */
  onListingsDiff(
    listings: Listing[],
    scope: ScopeRef,
    ts: string = new Date().toISOString(),
  ): ListingChangeEvent[] {
    const provider = scope.provider;
    const qsig = scope.querySignature ?? "";
    const sk = scopeKey(provider, qsig);
    const prevIds = this.scopeIds.get(sk) ?? new Set<string>();
    const nextIds = new Set<string>();
    const events: ListingChangeEvent[] = [];

    for (const listing of listings) {
      const id = listing.id;
      nextIds.add(id);
      const next = deltaFields(listing);
      const prev = this.known.get(id);
      if (!prev) {
        events.push({
          ts,
          kind: "new",
          provider: listing.provider || provider,
          id,
          price: next.price,
          currency: listing.currency,
          listedAt: next.listedAt,
          seller: next.seller,
          qsig: qsig || undefined,
        });
      } else if (!fieldsEqual(prev, next)) {
        events.push({
          ts,
          kind: "reprice",
          provider: listing.provider || provider,
          id,
          price: next.price,
          prevPrice: prev.price,
          listedAt: next.listedAt,
          prevListedAt: prev.listedAt,
          seller: next.seller,
          prevSeller: prev.seller,
          currency: listing.currency,
          qsig: qsig || undefined,
        });
      }
      this.known.set(id, { ...next, provider: listing.provider || provider });
    }

    for (const id of prevIds) {
      if (nextIds.has(id)) continue;
      events.push({
        ts,
        kind: "closed",
        provider,
        id,
        qsig: qsig || undefined,
      });
      // Drop known only if no other scope still holds the id
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
    if (this.retainScopeListings) {
      // Shallow copies only — store already trims raw/searchBlob at upsert.
      this.scopeListings.set(sk, listings.map((l) => ({ ...l })));
    } else {
      this.scopeListings.delete(sk);
    }
    if (events.length > 0) this.dirtyScopes.add(sk);
    // First successful page for a scope is also a snapshot candidate even with
    // zero events only if we never checkpointed — handled by RunCapture via
    // hasSnapshotted set. Mark dirty on first non-empty apply when scope was new.
    if (!prevIds.size && listings.length > 0) this.dirtyScopes.add(sk);

    return events;
  }

  /**
   * Apply SyncResult: short-circuit → no events; else diff result.listings.
   */
  onSyncResult(
    result: SyncResult,
    ts: string = new Date().toISOString(),
  ): ListingChangeEvent[] {
    if (result.shortCircuited) return [];
    return this.onListingsDiff(
      result.listings,
      { provider: result.provider, querySignature: result.querySignature },
      ts,
    );
  }

  softFail(
    provider: string,
    error: string,
    extra?: {
      lastSuccessfulPullAt?: string | null;
      lastRowCount?: number;
      qsig?: string;
      ts?: string;
    },
  ): SoftFailEvent {
    return {
      ts: extra?.ts ?? new Date().toISOString(),
      kind: "soft_fail",
      provider,
      error,
      lastSuccessfulPullAt: extra?.lastSuccessfulPullAt ?? null,
      lastRowCount: extra?.lastRowCount,
      qsig: extra?.qsig,
    };
  }

  /** Parse scopeKey back to provider + qsig (provider may not contain "::"). */
  static parseScopeKey(sk: string): { provider: string; querySignature: string } {
    const idx = sk.indexOf("::");
    if (idx < 0) return { provider: sk, querySignature: "" };
    return { provider: sk.slice(0, idx), querySignature: sk.slice(idx + 2) };
  }
}
