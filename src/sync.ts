import { querySignature } from "./querySignature.js";
import { recordPull } from "./http/metrics.js";
import type { ListingsProvider, PullQuery } from "./providers/types.js";
import type { ListingStore } from "./store.js";
import type { SnapshotMeta, SyncResult } from "./types.js";

export interface SyncOptions extends PullQuery {
  /**
   * When true (default), skip re-apply if content is unchanged for the same
   * provider+query: matching etag/contentFingerprint, or same id-set with
   * every row listingsEqual (even when builtAt is fetch-time and differs).
   */
  shortCircuitOnBuiltAt?: boolean;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

/** Truthy etag/fingerprint on page matches prior scope meta. */
function metaGenerationMatch(
  pageMeta: SnapshotMeta,
  previousMeta: SnapshotMeta | undefined,
): boolean {
  if (!previousMeta) return false;
  const etag = pageMeta.etag;
  if (etag && previousMeta.etag && etag === previousMeta.etag) return true;
  const fp = pageMeta.contentFingerprint;
  if (fp && previousMeta.contentFingerprint && fp === previousMeta.contentFingerprint) {
    return true;
  }
  return false;
}

/**
 * Pull from a provider into the store. Idempotent for the same query snapshot;
 * re-sync of the same query prunes rows that left the page (sold/stale).
 *
 * Upsert + prune per (provider, querySignature) only. Other providers and
 * other query scopes are never wiped. Soft-fail empty pages (provider
 * lastError) and thrown pulls set watermark lastError without replacing the
 * prior scope. See {@link syncIncremental} (alias).
 */
export async function syncOnce(
  store: ListingStore,
  provider: ListingsProvider,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const t0 = performance.now();
  try {
    const shortCircuit = options.shortCircuitOnBuiltAt !== false;
    const qsig = querySignature(options);
    const previousMeta = store.getMeta(provider.id, qsig);
    const previousBuiltAt = previousMeta?.builtAt ?? null;

    // Pass prior ETag so providers can send If-None-Match (CDN 304 path).
    const pullQuery = {
      ...options,
      ifNoneMatch: options.ifNoneMatch ?? previousMeta?.etag ?? undefined,
    };

    const page = provider.pullAll
      ? await provider.pullAll(pullQuery)
      : await provider.pull(pullQuery);

    const scopeIds = store.scopeIdSet(provider.id, qsig);

    // (A) HTTP 304 / empty-unchanged: never replace scope (would wipe).
    // Always honor, independent of shortCircuitOnBuiltAt.
    if (page.notModified) {
      const builtAt = previousBuiltAt;
      const seenAt =
        page.meta.fetchedAt || previousMeta?.fetchedAt || new Date().toISOString();
      if (previousMeta) {
        store.setMeta({
          ...previousMeta,
          fetchedAt: page.meta.fetchedAt || previousMeta.fetchedAt,
          etag: page.meta.etag ?? previousMeta.etag,
        });
      }
      // Confirmed present: refresh age; soft-fail path does not touch lastSeenAt.
      store.touchLastSeenAt(provider.id, qsig, seenAt);
      store.markProviderSuccess(provider.id, {
        builtAt,
        rowCount: scopeIds.size,
      });
      const result: SyncResult = {
        provider: provider.id,
        shortCircuited: true,
        builtAt,
        previousBuiltAt,
        querySignature: qsig,
        fetched: 0,
        upserted: 0,
        unchanged: scopeIds.size,
        pruned: 0,
        activeCount: store.size(provider.id),
        durationMs: Math.round(performance.now() - t0),
        listings: store.listScope(provider.id, qsig),
      };
      recordPull(provider.id, result.durationMs, false);
      return result;
    }

    const builtAt = page.meta.builtAt;
    const pageIds = new Set(page.listings.map((l) => l.id));
    const scopeNonEmpty = store.scopeSize(provider.id, qsig) > 0;
    const sameQuery = (previousMeta?.querySignature ?? "") === qsig;
    const sameIds = setsEqual(pageIds, scopeIds);

    // (A/B) Transport / content generation: etag or contentFingerprint match
    const generationHit = metaGenerationMatch(page.meta, previousMeta);

    // (C) Content equality safety net (gated by shortCircuitOnBuiltAt):
    // prior scope non-empty, same query, same id-set, every row listingsEqual,
    // even when builtAt is fetch-time and differs between pulls.
    const contentHit =
      shortCircuit &&
      scopeNonEmpty &&
      sameQuery &&
      sameIds &&
      store.scopeListingsEqual(provider.id, qsig, page.listings);

    const canShortCircuit = generationHit || contentHit;

    if (canShortCircuit) {
      const seenAt =
        page.meta.fetchedAt || previousMeta?.fetchedAt || new Date().toISOString();
      // Content confirmed without replace; still refresh lastSeenAt (not soft-fail).
      store.touchLastSeenAt(provider.id, qsig, seenAt);
      store.markProviderSuccess(provider.id, {
        builtAt,
        rowCount: scopeIds.size,
      });
      const result: SyncResult = {
        provider: provider.id,
        shortCircuited: true,
        builtAt,
        previousBuiltAt,
        querySignature: qsig,
        fetched: page.listings.length,
        upserted: 0,
        unchanged: scopeIds.size,
        pruned: 0,
        activeCount: store.size(provider.id),
        durationMs: Math.round(performance.now() - t0),
        listings: store.listScope(provider.id, qsig),
      };
      recordPull(provider.id, result.durationMs, false);
      return result;
    }

    // Soft-fail empty page (e.g. Phygitals 500 + lastError): do not prune prior scope
    // and do not refresh lastSeenAt. Host UIs grey-out via isStale(listing, maxAgeMs).
    const softErr = provider.lastError ?? null;
    if (softErr && page.listings.length === 0) {
      store.markProviderError(provider.id, softErr);
      const result: SyncResult = {
        provider: provider.id,
        shortCircuited: true,
        builtAt: previousBuiltAt,
        previousBuiltAt,
        querySignature: qsig,
        fetched: 0,
        upserted: 0,
        unchanged: scopeIds.size,
        pruned: 0,
        activeCount: store.size(provider.id),
        durationMs: Math.round(performance.now() - t0),
        listings: store.listScope(provider.id, qsig),
      };
      // Soft origin failure counts as error for ops counters
      recordPull(provider.id, result.durationMs, true);
      return result;
    }

    const seenAt =
      page.meta.fetchedAt || new Date().toISOString();

    // Incomplete page safety: never full-replace+prune a large book with a
    // partial page (e.g. warm poll without bootstrap/maxPages). Upsert only.
    const incompletePage =
      scopeNonEmpty &&
      (page.hasMore === true ||
        (page.listings.length > 0 &&
          page.listings.length < scopeIds.size &&
          pageIds.size < scopeIds.size));
    if (incompletePage) {
      let upserted = 0;
      let unchanged = 0;
      for (const row of page.listings) {
        const r = store.upsertOne(
          row,
          { provider: provider.id, querySignature: qsig },
          seenAt,
        );
        if (r.changed) upserted += 1;
        else unchanged += 1;
      }
      if (previousMeta) {
        store.setMeta({
          ...previousMeta,
          fetchedAt: page.meta.fetchedAt || previousMeta.fetchedAt,
          etag: page.meta.etag ?? previousMeta.etag,
          contentFingerprint:
            page.meta.contentFingerprint ?? previousMeta.contentFingerprint,
        });
      }
      store.markProviderSuccess(provider.id, {
        builtAt,
        rowCount: store.scopeSize(provider.id, qsig),
      });
      const result: SyncResult = {
        provider: provider.id,
        shortCircuited: false,
        builtAt,
        previousBuiltAt,
        querySignature: qsig,
        fetched: page.listings.length,
        upserted,
        unchanged,
        pruned: 0,
        activeCount: store.size(provider.id),
        durationMs: Math.round(performance.now() - t0),
        listings: store.listScope(provider.id, qsig),
      };
      recordPull(provider.id, result.durationMs, false);
      return result;
    }

    const stats = store.replaceScopeSnapshot(
      provider.id,
      qsig,
      page.listings,
      seenAt,
    );

    const meta: SnapshotMeta = {
      ...page.meta,
      provider: provider.id,
      querySignature: qsig,
    };
    store.setMeta(meta);

    const activeInScope = store.scopeSize(provider.id, qsig);
    store.markProviderSuccess(provider.id, {
      builtAt,
      rowCount: activeInScope,
    });

    const result: SyncResult = {
      provider: provider.id,
      shortCircuited: false,
      builtAt,
      previousBuiltAt,
      querySignature: qsig,
      fetched: page.listings.length,
      upserted: stats.upserted,
      unchanged: stats.unchanged,
      pruned: stats.pruned,
      activeCount: store.size(provider.id),
      durationMs: Math.round(performance.now() - t0),
      listings: store.listScope(provider.id, qsig),
    };
    recordPull(provider.id, result.durationMs, false);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    store.markProviderError(provider.id, msg);
    recordPull(provider.id, Math.round(performance.now() - t0), true);
    throw e;
  }
}

/**
 * Alias of {@link syncOnce}. Multi-source incremental snapshot is scoped
 * upsert + prune (one provider/query at a time). Failures do not wipe other
 * providers (scope keys + soft-fail paths).
 */
export async function syncIncremental(
  store: ListingStore,
  provider: ListingsProvider,
  options: SyncOptions = {},
): Promise<SyncResult> {
  return syncOnce(store, provider, options);
}

/** Sync and return listings sorted by price ascending. */
export async function pullListings(
  store: ListingStore,
  provider: ListingsProvider,
  options: SyncOptions = {},
): Promise<{ result: SyncResult; listings: import("./types.js").Listing[] }> {
  const result = await syncOnce(store, provider, options);
  const listings = [...result.listings].sort((a, b) => a.price - b.price);
  return { result, listings };
}
