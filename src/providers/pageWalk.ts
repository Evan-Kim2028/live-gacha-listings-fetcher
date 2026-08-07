/**
 * Shared sequential page-walk for paged marketplace APIs.
 *
 * Used by: Courtyard pullAll (0-based Algolia pages), Beezie pullBeeziePages
 * (0-based Solana / 1-based EVM). Phygitals keeps its concurrent walk.
 *
 * Why a shared helper: every paged venue had its own copy of maxPages clamps,
 * offset stepping, empty-page handling, and soft-fail bookkeeping — and each
 * copy had subtly different behavior on the ambiguous "first page empty"
 * case (transient hiccup vs legitimately empty book). The tri-state result
 * below makes that ambiguity explicit so callers decide per context.
 */
import { contentFingerprint } from "../contentFingerprint.js";
import type { Listing } from "../types.js";
import type { PullPage } from "./types.js";

/** One page produced by the caller's fetch function. */
export interface WalkPage {
  listings: Listing[];
  hasMore: boolean;
  /** Origin-reported total for the walk (nbHits / json.total), if any. */
  total: number | null;
}

export interface SequentialWalkOptions {
  /** Page ceiling; walk stops when reached (1-based venues: +1 inclusive). */
  maxPages: number;
  /** Rows per page. */
  pageSize: number;
  /** 0 for 0-based APIs (Algolia, Beezie Solana), 1 for 1-based (Beezie EVM). */
  firstPage: 0 | 1;
  /** Optional client-side row cap; walk stops once reached. */
  limit?: number | null;
}

export interface WalkResult {
  listings: Listing[];
  total: number | null;
  hasMore: boolean;
  /** Number of pages actually fetched (diagnostics: lastBeezieMeta.page). */
  pagesFetched: number;
  /**
   * Walk terminated on an empty page AFTER collecting rows (deep-pagination
   * cap / index end). Callers may reset `total` to walked rows here (Algolia
   * nbHits is inflated beyond the retrievable book).
   */
  stoppedAtCap: boolean;
  /**
   * First page came back EMPTY with no exception thrown. This is ambiguous:
   * a transient hiccup (200 + 0 hits) or a legitimately empty book/category.
   * Callers decide: single-scope walks treat it as a soft-fail (never prune a
   * prior populated scope); multi-category walks treat it as legitimately
   * empty (most categories have 0 active listings).
   */
  firstPageEmpty: boolean;
  /**
   * Message when a page threw after rows were already collected (rows kept,
   * walk marked incomplete). Null when no mid-walk failure.
   */
  partialError: string | null;
}

/**
 * Walk pages sequentially: offset = (page - firstPage) * pageSize.
 * Stops on: !hasMore, an empty page, client limit, maxPages, or a thrown page.
 */
export async function walkSequentialPages(
  fetchPage: (offset: number, page: number) => Promise<WalkPage>,
  opts: SequentialWalkOptions,
): Promise<WalkResult> {
  const all: Listing[] = [];
  let total: number | null = null;
  let hasMore = false;
  let partialError: string | null = null;
  let firstPageEmpty = false;
  let pagesFetched = 0;
  let stoppedAtCap = false;
  let page = opts.firstPage;
  // 1-based venues include the cap page (pages 1..maxPages); 0-based are
  // exclusive (0..maxPages-1).
  const pageCap = opts.firstPage === 0 ? opts.maxPages : opts.maxPages + 1;

  for (; page < pageCap; page++) {
    try {
      const offset =
        opts.firstPage === 0 ? page * opts.pageSize : (page - 1) * opts.pageSize;
      const one = await fetchPage(offset, page);
      pagesFetched += 1;
      if (one.listings.length === 0) {
        if (all.length === 0) {
          // Ambiguous empty (200 + 0 hits): never claim a completed book.
          hasMore = false;
          firstPageEmpty = true;
        } else {
          // Deep-pagination cap / index end after a real walk: complete.
          hasMore = false;
          stoppedAtCap = true;
        }
        break;
      }
      total = one.total ?? total;
      all.push(...one.listings);
      hasMore = one.hasMore;
      if (!one.hasMore) break;
      if (opts.limit != null && all.length >= opts.limit) break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (all.length === 0) {
        // Hard failure on the first page: same ambiguous-empty shape, but the
        // caller can distinguish via partialError !== null.
        firstPageEmpty = true;
        partialError = msg;
        hasMore = false;
      } else {
        // Mid-walk failure: keep prior rows, mark incomplete (no prune).
        partialError = msg;
        hasMore = true;
      }
      break;
    }
  }

  return { listings: all, total, hasMore, pagesFetched, stoppedAtCap, firstPageEmpty, partialError };
}

/**
 * Build an empty PullPage. `softFail: true` zeroes builtAt and omits the
 * content fingerprint so sync treats it as "cannot confirm" (never prunes).
 */
export function emptyPage(
  provider: string,
  opts: {
    softFail?: boolean;
    total?: number | null;
    etag?: string | null;
  } = {},
): PullPage {
  const soft = opts.softFail ?? false;
  return {
    listings: [],
    hasMore: false,
    meta: {
      provider,
      builtAt: soft ? null : new Date().toISOString(),
      total: opts.total ?? 0,
      universe: opts.total ?? 0,
      fetchedAt: new Date().toISOString(),
      querySignature: "",
      etag: opts.etag ?? null,
      contentFingerprint: soft ? undefined : contentFingerprint([]),
    },
  };
}
