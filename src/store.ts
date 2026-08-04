import { listingId } from "./identity.js";
import { withLastSeenAt } from "./listingAge.js";
import { scopeKey } from "./querySignature.js";
import type {
  CanonicalCard,
  Listing,
  ProviderWatermark,
  SnapshotMeta,
} from "./types.js";

export interface UpsertStats {
  upserted: number;
  unchanged: number;
  pruned: number;
  /** Listing ids actually deleted from the store this apply (left all scopes). */
  prunedIds: string[];
  total: number;
}

/**
 * Drop heavy / debug-only fields before keeping a row in {@link ListingStore}.
 * Strips `raw` and `searchBlob`, and slims `canonical` to identity display keys.
 * Trading fields (id, price, urls, grades, …) are preserved.
 */
export function trimListing(listing: Listing): Listing {
  let canonical: CanonicalCard | null = listing.canonical ?? null;
  if (canonical != null && typeof canonical === "object") {
    const slim: CanonicalCard = {};
    if (canonical.name != null) slim.name = canonical.name;
    if (canonical.number != null) slim.number = canonical.number;
    if (canonical.scrydex_id != null) slim.scrydex_id = canonical.scrydex_id;
    if (canonical.image != null) slim.image = canonical.image;
    canonical = Object.keys(slim).length > 0 ? slim : null;
  }
  // Explicit field copy so `raw` / `searchBlob` / extra canonical keys never stick.
  const out: Listing = {
    id: listing.id,
    provider: listing.provider,
    platform: listing.platform,
    nativeId: listing.nativeId,
    tokenId: listing.tokenId,
    name: listing.name,
    price: listing.price,
    currency: listing.currency,
    fmv: listing.fmv,
    delta: listing.delta,
    market: listing.market,
    seller: listing.seller,
    externalUrl: listing.externalUrl,
    imageUrl: listing.imageUrl,
    listedAt: listing.listedAt,
    firstListedAt: listing.firstListedAt,
    lastEvent: listing.lastEvent,
    tcg: listing.tcg,
    itemType: listing.itemType,
    grader: listing.grader,
    grade: listing.grade,
    gradeNum: listing.gradeNum,
    language: listing.language,
    setRaw: listing.setRaw,
    cardNumber: listing.cardNumber,
    year: listing.year,
    confidence: listing.confidence,
    canonical,
    contractAddress: listing.contractAddress,
  };
  if (listing.lastSeenAt !== undefined) {
    out.lastSeenAt = listing.lastSeenAt;
  }
  return out;
}

/**
 * In-memory snapshot store. Idempotent upsert by listing.id.
 * Snapshots scoped by (provider, querySignature): filters do not wipe each
 * other; re-sync of the same query prunes sold/stale ids.
 * Per-provider watermarks: lastSuccessfulPullAt, lastBuiltAt, lastRowCount,
 * lastError (not tied to a single query scope).
 */
export class ListingStore {
  private readonly byId = new Map<string, Listing>();
  /** scopeKey → active listing ids for that pull query. */
  private readonly scopeIds = new Map<string, Set<string>>();
  /** listing id → scopes that currently include it. */
  private readonly idScopes = new Map<string, Set<string>>();
  /** scopeKey → snapshot meta. */
  private readonly metaByScope = new Map<string, SnapshotMeta>();
  /** provider id → ops watermark (independent of query signature). */
  private readonly watermarkByProvider = new Map<string, ProviderWatermark>();

  clear(): void {
    this.byId.clear();
    this.scopeIds.clear();
    this.idScopes.clear();
    this.metaByScope.clear();
    this.watermarkByProvider.clear();
  }

  get(id: string): Listing | undefined {
    return this.byId.get(id);
  }

  /** All active listings (optionally filter by provider). */
  list(provider?: string): Listing[] {
    const all = [...this.byId.values()];
    if (!provider) return all;
    return all.filter((l) => l.provider === provider);
  }

  /** Listings currently in a provider+query snapshot scope. */
  listScope(provider: string, querySignature = ""): Listing[] {
    const key = scopeKey(provider, querySignature);
    const ids = this.scopeIds.get(key);
    if (!ids) return [];
    const out: Listing[] = [];
    for (const id of ids) {
      const row = this.byId.get(id);
      if (row) out.push(row);
    }
    return out;
  }

  size(provider?: string): number {
    if (!provider) return this.byId.size;
    let n = 0;
    for (const l of this.byId.values()) {
      if (l.provider === provider) n += 1;
    }
    return n;
  }

  scopeSize(provider: string, querySignature = ""): number {
    return this.scopeIds.get(scopeKey(provider, querySignature))?.size ?? 0;
  }

  getMeta(provider: string, querySignature = ""): SnapshotMeta | undefined {
    return this.metaByScope.get(scopeKey(provider, querySignature));
  }

  setMeta(meta: SnapshotMeta): void {
    const qsig = meta.querySignature ?? "";
    this.metaByScope.set(scopeKey(meta.provider, qsig), meta);
  }

  /** Per-provider watermark (lastSuccessfulPullAt, lastBuiltAt, lastRowCount, lastError). */
  getWatermark(provider: string): ProviderWatermark | undefined {
    return this.watermarkByProvider.get(provider);
  }

  /** All provider watermarks currently tracked. */
  listWatermarks(): ProviderWatermark[] {
    return [...this.watermarkByProvider.values()];
  }

  setWatermark(wm: ProviderWatermark): void {
    this.watermarkByProvider.set(wm.provider, { ...wm });
  }

  /**
   * Mark a successful pull/apply. Clears lastError; keeps prior fields when
   * callers omit optional args (e.g. short-circuit).
   */
  markProviderSuccess(
    provider: string,
    opts: {
      builtAt?: string | null;
      rowCount?: number;
      at?: string;
    } = {},
  ): ProviderWatermark {
    const prev = this.watermarkByProvider.get(provider);
    const at = opts.at ?? new Date().toISOString();
    const next: ProviderWatermark = {
      provider,
      lastSuccessfulPullAt: at,
      lastBuiltAt:
        opts.builtAt !== undefined
          ? opts.builtAt
          : (prev?.lastBuiltAt ?? null),
      lastRowCount:
        opts.rowCount !== undefined
          ? opts.rowCount
          : (prev?.lastRowCount ?? 0),
      lastError: null,
    };
    this.watermarkByProvider.set(provider, next);
    return next;
  }

  /**
   * Record soft or hard provider failure. Does not touch other providers'
   * rows or watermarks. Keeps lastSuccessfulPullAt / lastBuiltAt / lastRowCount
   * from the previous good pull.
   */
  markProviderError(
    provider: string,
    error: string,
    at?: string,
  ): ProviderWatermark {
    const prev = this.watermarkByProvider.get(provider);
    const next: ProviderWatermark = {
      provider,
      lastSuccessfulPullAt: prev?.lastSuccessfulPullAt ?? null,
      lastBuiltAt: prev?.lastBuiltAt ?? null,
      lastRowCount: prev?.lastRowCount ?? 0,
      lastError: error,
    };
    // `at` reserved for future lastAttemptAt; error path keeps success stamps
    void at;
    this.watermarkByProvider.set(provider, next);
    return next;
  }

  /**
   * Idempotent upsert only (no prune). Prefer replaceScopeSnapshot for sync.
   * Stamps lastSeenAt from seenAt (or now) when missing.
   */
  upsertMany(listings: Listing[], seenAt?: string): UpsertStats {
    const at = seenAt ?? new Date().toISOString();
    let upserted = 0;
    let unchanged = 0;
    for (const raw of listings) {
      if (!raw.id) throw new Error("Listing missing id");
      // Prefer existing lastSeenAt only when caller already set it; else fetchedAt.
      // Always write apply-time lastSeenAt so re-observe refreshes age.
      const listing = {
        ...withLastSeenAt(trimListing(raw), at),
        lastSeenAt: at,
      };
      const prev = this.byId.get(listing.id);
      if (prev && listingsEqual(prev, listing)) {
        unchanged += 1;
        this.byId.set(listing.id, listing);
        continue;
      }
      this.byId.set(listing.id, listing);
      upserted += 1;
    }
    return { upserted, unchanged, pruned: 0, prunedIds: [], total: this.byId.size };
  }

  /**
   * Replace the active snapshot for (provider, querySignature): upsert page
   * rows; prune ids that left this scope (delete globally when no other scope
   * still references them). Stamps lastSeenAt from seenAt / page apply time.
   */
  replaceScopeSnapshot(
    provider: string,
    querySignature: string,
    listings: Listing[],
    seenAt?: string,
  ): UpsertStats {
    const key = scopeKey(provider, querySignature);
    const prevScope = this.scopeIds.get(key) ?? new Set<string>();
    const nextScope = new Set<string>();
    const at = seenAt ?? new Date().toISOString();

    let upserted = 0;
    let unchanged = 0;

    for (const raw of listings) {
      if (!raw.id) throw new Error("Listing missing id");
      if (raw.provider !== provider) {
        throw new Error(
          `listing provider ${raw.provider} != snapshot provider ${provider}`,
        );
      }
      const listing = withLastSeenAt(trimListing(raw), at);
      nextScope.add(listing.id);
      const prev = this.byId.get(listing.id);
      if (prev && listingsEqual(prev, listing)) {
        unchanged += 1;
        // Always refresh lastSeenAt on re-observe (apply confirmation).
        this.byId.set(listing.id, {
          ...listing,
          lastSeenAt: at,
        });
      } else {
        this.byId.set(listing.id, { ...listing, lastSeenAt: at });
        upserted += 1;
      }
      let scopes = this.idScopes.get(listing.id);
      if (!scopes) {
        scopes = new Set();
        this.idScopes.set(listing.id, scopes);
      }
      scopes.add(key);
    }

    const prunedIds: string[] = [];
    for (const id of prevScope) {
      if (nextScope.has(id)) continue;
      const scopes = this.idScopes.get(id);
      if (scopes) {
        scopes.delete(key);
        if (scopes.size === 0) {
          this.idScopes.delete(id);
          this.byId.delete(id);
          prunedIds.push(id);
        }
      } else {
        this.byId.delete(id);
        prunedIds.push(id);
      }
    }

    this.scopeIds.set(key, nextScope);
    return {
      upserted,
      unchanged,
      pruned: prunedIds.length,
      prunedIds,
      total: this.byId.size,
    };
  }

  /** Ids currently held in a scope (for short-circuit id-set compare). */
  scopeIdSet(provider: string, querySignature = ""): Set<string> {
    return new Set(this.scopeIds.get(scopeKey(provider, querySignature)) ?? []);
  }

  /**
   * True when every page listing matches the stored row for that id via
   * listingsEqual (same as replaceScopeSnapshot unchanged path).
   * Does not check id-set membership of extras; callers compare sets.
   */
  scopeListingsEqual(
    _provider: string,
    _querySignature: string,
    listings: Listing[],
  ): boolean {
    // Id equality is global; callers already gate on scope id-set membership.
    for (const listing of listings) {
      const prev = this.byId.get(listing.id);
      if (!prev || !listingsEqual(prev, listing)) return false;
    }
    return true;
  }

  /**
   * Streaming upsert into store and attach to a live scope. Does not prune
   * other scope members (deltas are incremental). Stamps lastSeenAt from
   * seenAt (or now); always refreshes lastSeenAt on write.
   */
  upsertOne(
    listing: Listing,
    scope?: { provider: string; querySignature?: string },
    seenAt?: string,
  ): { changed: boolean } {
    if (!listing.id) throw new Error("Listing missing id");
    const at = seenAt ?? new Date().toISOString();
    const row = {
      ...withLastSeenAt(trimListing(listing), at),
      lastSeenAt: at,
    };
    const prev = this.byId.get(listing.id);
    const changed = !(prev && listingsEqual(prev, row));
    this.byId.set(listing.id, row);

    if (scope) {
      const key = scopeKey(scope.provider, scope.querySignature ?? "");
      let set = this.scopeIds.get(key);
      if (!set) {
        set = new Set();
        this.scopeIds.set(key, set);
      }
      set.add(listing.id);
      let scopes = this.idScopes.get(listing.id);
      if (!scopes) {
        scopes = new Set();
        this.idScopes.set(listing.id, scopes);
      }
      scopes.add(key);
    }
    return { changed };
  }

  /**
   * Refresh lastSeenAt on every row in a scope (no identity/price change).
   * Used on short-circuit success (304 / generation hit) so healthy polls
   * do not grey-out. Soft-fail must not call this.
   */
  touchLastSeenAt(
    provider: string,
    querySignature: string,
    seenAt: string,
  ): number {
    const key = scopeKey(provider, querySignature);
    const ids = this.scopeIds.get(key);
    if (!ids || ids.size === 0) return 0;
    let n = 0;
    for (const id of ids) {
      const row = this.byId.get(id);
      if (!row) continue;
      this.byId.set(id, { ...row, lastSeenAt: seenAt });
      n += 1;
    }
    return n;
  }

  /**
   * Hard-remove a listing from all scopes (SSE closed / sold / burn).
   * Returns true if it was present.
   */
  removeOne(id: string): boolean {
    if (!this.byId.has(id)) {
      // still scrub scopes if orphaned
      const scopes = this.idScopes.get(id);
      if (!scopes) return false;
      for (const key of scopes) this.scopeIds.get(key)?.delete(id);
      this.idScopes.delete(id);
      return false;
    }
    const scopes = this.idScopes.get(id);
    if (scopes) {
      for (const key of scopes) this.scopeIds.get(key)?.delete(id);
      this.idScopes.delete(id);
    }
    this.byId.delete(id);
    return true;
  }

  removeByParts(provider: string, platform: string, nativeId: string): boolean {
    return this.removeOne(listingId({ provider, platform, nativeId }));
  }

  updatedSince(iso: string, provider?: string): Listing[] {
    return this.list(provider).filter((l) => {
      const t = l.listedAt ?? l.firstListedAt;
      return t != null && t > iso;
    });
  }
}

function listingsEqual(a: Listing, b: Listing): boolean {
  return (
    a.id === b.id &&
    a.price === b.price &&
    a.currency === b.currency &&
    a.fmv === b.fmv &&
    a.delta === b.delta &&
    a.listedAt === b.listedAt &&
    a.lastEvent === b.lastEvent &&
    a.externalUrl === b.externalUrl &&
    a.name === b.name
  );
}
