/**
 * Disk book for cold bootstrap then warm poll resume.
 * Layout (docs/BOOTSTRAP_FULL_BOOK.md):
 *   data/books/<scope>/snapshot.json + meta.json
 *
 * ListingStore is in-memory truth; disk is resume cache only.
 * Do not overwrite a good snapshot with soft-fail empty (caller must gate).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { querySignature } from "./querySignature.js";
import type { ListingStore } from "./store.js";
import type { Listing, ProviderWatermark, SnapshotMeta } from "./types.js";
import type { PullQuery } from "./providers/types.js";

/** Default root for books relative to process cwd (operators usually set --out). */
export const DEFAULT_BOOKS_ROOT = "data/books";

/** Default resume freshness: 15 minutes. */
export const DEFAULT_BOOK_MAX_AGE_MS = 15 * 60 * 1000;

export interface BookProviderMeta {
  snapshotMeta?: SnapshotMeta;
  watermark?: ProviderWatermark;
  rowCount: number;
}

/**
 * Book-level meta next to snapshot.json.
 * `filter` is the decision PullQuery shared by cold + warm (no bootstrap/maxPages).
 */
export interface BookMeta {
  filter: PullQuery;
  querySignature: string;
  providers: string[];
  savedAt: string;
  rowCount: number;
  /** Policy stamped at save time (informational). */
  maxAgeMs?: number;
  byProvider: Record<string, BookProviderMeta>;
}

export interface SaveBookOptions {
  store: ListingStore;
  /** Decision filter (cold/warm identity). bootstrap/maxPages stripped. */
  filter: PullQuery;
  /** Provider ids included in this book. */
  providers: string[];
  /** Book directory (snapshot.json + meta.json). Absolute or relative. */
  outDir: string;
  maxAgeMs?: number;
}

export interface LoadBookOptions {
  store: ListingStore;
  outDir: string;
  /**
   * Expected decision filter. If set, signature must match meta or load fails.
   * When omitted, meta.filter is used for scope restore.
   */
  filter?: PullQuery;
  /** Skip cold when now - savedAt < maxAgeMs. Default DEFAULT_BOOK_MAX_AGE_MS. */
  maxAgeMs?: number;
  /** Require non-empty snapshot to count as loadable. Default true. */
  requireRows?: boolean;
}

export interface LoadBookResult {
  loaded: boolean;
  /** True when loaded and age ≤ maxAgeMs (skip cold). */
  fresh: boolean;
  meta?: BookMeta;
  reason?: string;
  ageMs?: number;
}

/** Strip transport / bootstrap-only flags from PullQuery for decision identity. */
export function decisionFilter(query: PullQuery = {}): PullQuery {
  const {
    bootstrap: _b,
    maxPages: _m,
    ifNoneMatch: _i,
    fixturePath: _f,
    offline: _o,
    ...rest
  } = query;
  return { ...rest };
}

/** FNV-1a 32-bit hex for compact scope directory names. */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function sanitizeSegment(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9._=-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

/**
 * Stable book directory id from provider set + decision querySignature.
 * Example: `collectorcrypt+magiceden__a1b2c3d4`
 */
export function bookScopeId(
  filter: PullQuery,
  providerIds: string[],
): string {
  const qsig = querySignature(decisionFilter(filter));
  const prov = [...providerIds].sort().join("+") || "none";
  const hash = fnv1aHex(qsig || "default");
  const hint = qsig
    ? sanitizeSegment(qsig.replace(/&/g, "_").replace(/=/g, "-"))
    : "default";
  const short = hint.length > 48 ? hint.slice(0, 48) : hint;
  return `${sanitizeSegment(prov)}__${short}__${hash}`;
}

/** Resolve book dir: explicit outDir, or booksRoot/scopeId. */
export function resolveBookDir(opts: {
  filter: PullQuery;
  providers: string[];
  /** Full book directory (overrides booksRoot + scope). */
  outDir?: string;
  /** Root for auto scope dirs (default data/books). */
  booksRoot?: string;
}): string {
  if (opts.outDir) return resolve(opts.outDir);
  const root = resolve(opts.booksRoot ?? DEFAULT_BOOKS_ROOT);
  return join(root, bookScopeId(opts.filter, opts.providers));
}

export function bookPaths(outDir: string): {
  dir: string;
  snapshot: string;
  meta: string;
} {
  const dir = resolve(outDir);
  return {
    dir,
    snapshot: join(dir, "snapshot.json"),
    meta: join(dir, "meta.json"),
  };
}

/**
 * Persist last-good full apply. Call only after a successful cold (or warm)
 * apply with rows (or intentional empty). Soft-fail empty must not overwrite
 * a large book.
 */
export function saveBook(opts: SaveBookOptions): BookMeta {
  const filter = decisionFilter(opts.filter);
  const qsig = querySignature(filter);
  const providerIds = [...opts.providers];
  const paths = bookPaths(opts.outDir);

  const listings: Listing[] = [];
  const byProvider: Record<string, BookProviderMeta> = {};

  for (const id of providerIds) {
    const scopeRows = opts.store.listScope(id, qsig);
    listings.push(...scopeRows);
    byProvider[id] = {
      snapshotMeta: opts.store.getMeta(id, qsig),
      watermark: opts.store.getWatermark(id),
      rowCount: scopeRows.length,
    };
  }

  // Include any listings for known providers that might sit outside scope
  // (defensive); prefer scope rows when present.
  if (listings.length === 0) {
    for (const id of providerIds) {
      listings.push(...opts.store.list(id));
    }
  }

  const meta: BookMeta = {
    filter,
    querySignature: qsig,
    providers: providerIds,
    savedAt: new Date().toISOString(),
    rowCount: listings.length,
    maxAgeMs: opts.maxAgeMs,
    byProvider,
  };

  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.snapshot, JSON.stringify(listings) + "\n", "utf8");
  writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

/**
 * Hydrate ListingStore from data/books/<scope>/.
 * Restores per-provider scopes, SnapshotMeta, and watermarks.
 */
export function loadBook(opts: LoadBookOptions): LoadBookResult {
  const paths = bookPaths(opts.outDir);
  if (!existsSync(paths.meta) || !existsSync(paths.snapshot)) {
    return {
      loaded: false,
      fresh: false,
      reason: `missing snapshot or meta under ${paths.dir}`,
    };
  }

  let meta: BookMeta;
  let listings: Listing[];
  try {
    meta = JSON.parse(readFileSync(paths.meta, "utf8")) as BookMeta;
    listings = JSON.parse(readFileSync(paths.snapshot, "utf8")) as Listing[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { loaded: false, fresh: false, reason: `parse error: ${msg}` };
  }

  const expectedFilter = opts.filter
    ? decisionFilter(opts.filter)
    : decisionFilter(meta.filter ?? {});
  const expectedQsig = querySignature(expectedFilter);
  const metaQsig = meta.querySignature ?? querySignature(meta.filter ?? {});

  if (opts.filter && expectedQsig !== metaQsig) {
    return {
      loaded: false,
      fresh: false,
      meta,
      reason: `querySignature mismatch: disk=${metaQsig} current=${expectedQsig}`,
    };
  }

  const requireRows = opts.requireRows !== false;
  if (requireRows && (!Array.isArray(listings) || listings.length === 0)) {
    return {
      loaded: false,
      fresh: false,
      meta,
      reason: "snapshot has zero rows",
    };
  }

  const qsig = metaQsig;
  const byProvider = new Map<string, Listing[]>();
  for (const row of listings) {
    if (!row?.id || !row.provider) continue;
    let arr = byProvider.get(row.provider);
    if (!arr) {
      arr = [];
      byProvider.set(row.provider, arr);
    }
    arr.push(row);
  }

  const providerIds =
    meta.providers?.length > 0
      ? meta.providers
      : [...byProvider.keys()];

  for (const id of providerIds) {
    const rows = byProvider.get(id) ?? [];
    opts.store.replaceScopeSnapshot(id, qsig, rows);
    const pm = meta.byProvider?.[id];
    if (pm?.snapshotMeta) {
      opts.store.setMeta({
        ...pm.snapshotMeta,
        provider: id,
        querySignature: qsig,
      });
    } else {
      opts.store.setMeta({
        provider: id,
        querySignature: qsig,
        builtAt: null,
        total: rows.length,
        universe: null,
        fetchedAt: meta.savedAt,
      });
    }
    if (pm?.watermark) {
      opts.store.setWatermark({ ...pm.watermark, provider: id });
    } else {
      opts.store.markProviderSuccess(id, {
        builtAt: pm?.snapshotMeta?.builtAt ?? null,
        rowCount: rows.length,
        at: meta.savedAt,
      });
    }
  }

  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_BOOK_MAX_AGE_MS;
  const savedAtMs = Date.parse(meta.savedAt);
  const ageMs = Number.isFinite(savedAtMs)
    ? Date.now() - savedAtMs
    : Number.POSITIVE_INFINITY;
  const fresh = ageMs <= maxAgeMs;

  return {
    loaded: true,
    fresh,
    meta,
    ageMs,
    reason: fresh ? undefined : `stale ageMs=${ageMs} maxAgeMs=${maxAgeMs}`,
  };
}

/** True when both snapshot.json and meta.json exist. */
export function bookExists(outDir: string): boolean {
  const p = bookPaths(outDir);
  return existsSync(p.meta) && existsSync(p.snapshot);
}
