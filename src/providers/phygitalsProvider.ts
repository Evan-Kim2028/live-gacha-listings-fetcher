/**
 * Phygitals venue provider (api.phygitals.com). Concurrent multi-page walk
 * (adaptive concurrency) — kept concurrent on purpose: cold pulls of a few
 * thousand rows are materially faster than a sequential walk.
 */
import {
  buildPhygitalsParamAttempts,
  emptyMeta,
  extractRows,
  LONGTAIL_DEFAULT_MAX_PAGES,
  LONGTAIL_MAX_PAGES_CAP,
  LongtailOptions,
  LongtailProvider,
  normalizePhygitalsRow,
  PHYGITALS_BROWSER_HEADERS,
  PHYGITALS_DEFAULT_PAGE_SIZE,
  PHYGITALS_FILTERS_PATH,
  PHYGITALS_MAX_ITEMS_PER_PAGE,
  type PhygitalsFiltersPayload,
} from "./longtailCommon.js";
import { paginateConcurrent } from "../http/pageConcurrency.js";
import {
  fetchWithRetry,
  getResponseEtag,
  isNotModifiedStatus,
} from "../http/fetchWithRetry.js";
import type { Listing } from "../types.js";
import type { PullPage, PullQuery } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Phygitals venue provider (api.phygitals.com). Concurrent multi-page walk
 * (adaptive concurrency) — kept concurrent on purpose: cold pulls of a few
 * thousand rows are materially faster than a sequential walk.
 */
export class PhygitalsProvider extends LongtailProvider {
  protected override async pullVenue(query: PullQuery): Promise<PullPage> {
    return this.pullPhygitals(query);
  }

  protected override async pullVenuePages(
    query: PullQuery & { maxPages?: number },
  ): Promise<PullPage> {
    return this.pullPhygitalsPages(query);
  }

  protected override async pullVenueAll(
    query: PullQuery & { maxPages?: number },
  ): Promise<PullPage> {
    return this.runPlannedWalk(query, this.walkPageSize(query));
  }

  protected override walkPageSize(query: PullQuery): number {
    const bootstrap = Boolean(query.bootstrap);
    const hasExplicitMaxPages =
      query.maxPages != null && Number.isFinite(query.maxPages);
    return Math.min(
      Math.max(
        query.limit != null && query.limit > 0
          ? Math.floor(query.limit)
          : bootstrap || hasExplicitMaxPages
            ? PHYGITALS_MAX_ITEMS_PER_PAGE
            : PHYGITALS_DEFAULT_PAGE_SIZE,
        1,
      ),
      PHYGITALS_MAX_ITEMS_PER_PAGE,
    );
  }

  private async pullPhygitalsPages(
    query: PullQuery & { maxPages?: number },
  ): Promise<PullPage> {
    const maxPages = Math.max(
      1,
      Math.min(
        query.maxPages ?? LONGTAIL_DEFAULT_MAX_PAGES,
        LONGTAIL_MAX_PAGES_CAP,
      ),
    );
    const clientLimit = query.limit;
    const pageSize = Math.min(
      Math.max(
        clientLimit != null && clientLimit > 0
          ? Math.min(clientLimit, PHYGITALS_MAX_ITEMS_PER_PAGE)
          : PHYGITALS_DEFAULT_PAGE_SIZE,
        1,
      ),
      PHYGITALS_MAX_ITEMS_PER_PAGE,
    );
    let total: number | null = null;
    let etag: string | null = null;
    let partialError: string | null = null;
    let knownTotalPages: number | null = null;

    const walk = await paginateConcurrent<Listing>({
      maxPages,
      concurrency: this.pageConcurrency,
      baseBackoffMs: this.retryDelayMs,
      fetchFirst: async () => {
        const one = await this.pullPhygitals({
          ...query,
          limit: pageSize,
          offset: 0,
          ifNoneMatch: query.ifNoneMatch,
        });
        if (one.notModified) {
          return { listings: [], full: false, notModified: true };
        }
        if (this.lastError && one.listings.length === 0) {
          partialError = this.lastError;
          return { listings: [], full: false };
        }
        etag = one.meta.etag ?? etag;
        if (one.meta.total != null) {
          total = one.meta.total;
          knownTotalPages = Math.max(
            1,
            Math.ceil(one.meta.total / pageSize),
          );
        }
        return {
          listings: one.listings,
          full: one.hasMore === true && one.listings.length > 0,
          knownTotalPages,
        };
      },
      fetchPage: async (pageIndex) => {
        const one = await this.pullPhygitals({
          ...query,
          limit: pageSize,
          offset: pageIndex * pageSize,
        });
        if (this.lastError && one.listings.length === 0) {
          partialError = this.lastError;
          return { listings: [], full: false };
        }
        etag = one.meta.etag ?? etag;
        if (one.meta.total != null) total = one.meta.total;
        return {
          listings: one.listings,
          full: one.hasMore === true && one.listings.length > 0,
        };
      },
    });

    if (walk.notModified) {
      return emptyMeta(this.id, [], false, null, { etag });
    }

    if (walk.listings.length === 0 && !partialError) {
      // 200-empty first page with no exception: treat as soft-fail so sync
      // never replaces a prior scope with an empty snapshot (wipe).
      this.lastError = "phygitals empty first page (0 rows) — treated as soft-fail";
      return emptyMeta(this.id, [], false, null, {
        etag,
        softFail: true,
      });
    }

    if (partialError && walk.listings.length === 0) {
      this.lastError = partialError;
      return emptyMeta(this.id, [], false, null, {
        etag,
        softFail: true,
      });
    }

    if (partialError) {
      this.lastError = `phygitals partial multi-page after ${walk.listings.length} rows: ${partialError}`;
    } else {
      this.lastError = null;
    }

    this.lastPageWalkStats = {
      pagesAttempted: walk.stats.items + 1,
      pagesOk: walk.stats.ok + 1,
      throttles: walk.stats.throttles,
      peakConcurrency: walk.stats.peakConcurrency,
      wallMs: walk.stats.wallMs,
    };

    const listings =
      clientLimit != null
        ? walk.listings.slice(0, clientLimit)
        : walk.listings;
    const hasMore =
      (walk.hasMore || Boolean(partialError)) &&
      (clientLimit == null || walk.listings.length < (total ?? Infinity));

    return emptyMeta(
      this.id,
      listings,
      hasMore,
      total ?? listings.length,
      { etag },
    );
  }
  private phygitalsHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...PHYGITALS_BROWSER_HEADERS,
      "User-Agent": this.userAgent,
    };
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
  private async pullPhygitals(query: PullQuery): Promise<PullPage> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/";
    const headers = this.phygitalsHeaders();
    const retryOpts = {
      fetchImpl: this.fetchImpl,
      maxRetries: this.maxRetries,
      baseDelayMs: this.retryDelayMs,
    };

    let filterMeta: Record<string, Array<{ value?: string; count?: number }>> | undefined;
    try {
      const filtersUrl = new URL(PHYGITALS_FILTERS_PATH, base).toString();
      const fres = await fetchWithRetry(filtersUrl, { headers }, retryOpts);
      if (fres.ok) {
        const body = (await fres.json()) as PhygitalsFiltersPayload;
        filterMeta = body.filters?.metadata;
      }
    } catch {
      // filters are best-effort for alternate params
    }

    // Cap attempts so a total outage does not hammer the origin.
    const attempts = buildPhygitalsParamAttempts(query, filterMeta).slice(0, 10);
    const errors: string[] = [];
    let attemptIdx = 0;
    // Conditional GET only on first param shape (stable URL for ETag reuse).
    let tryIfNone = query.ifNoneMatch ?? true;

    for (const params of attempts) {
      const url = new URL(this.listingPath, base);
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
      const urlStr = url.toString();
      this.lastUrl = urlStr;
      attemptIdx++;
      try {
        const inm =
          tryIfNone === true
            ? this.etagByUrl.get(urlStr) || this.lastEtag || null
            : typeof tryIfNone === "string"
              ? tryIfNone
              : null;
        tryIfNone = false;
        const res = await fetchWithRetry(
          urlStr,
          { headers },
          { ...retryOpts, ifNoneMatch: inm },
        );
        if (isNotModifiedStatus(res.status)) {
          const etag = getResponseEtag(res) ?? inm;
          if (etag) {
            this.etagByUrl.set(urlStr, etag);
            this.lastEtag = etag;
          }
          this.lastError = null;
          return this.notModifiedPage(etag);
        }
        if (res.ok) {
          const etag = getResponseEtag(res);
          if (etag) {
            this.etagByUrl.set(urlStr, etag);
            this.lastEtag = etag;
          }
          const body = await res.json();
          const rows = extractRows(body);
          const total =
            body &&
            typeof body === "object" &&
            typeof (body as { amount?: unknown }).amount === "number"
              ? ((body as { amount: number }).amount as number)
              : rows.length;
          const listings = rows
            .map((r) => normalizePhygitalsRow(r, this.id))
            .filter((x): x is Listing => x != null)
            .slice(
              0,
              query.limit ?? PHYGITALS_MAX_ITEMS_PER_PAGE,
            );
          this.lastError = null;
          const pageSize = Number(
            params.itemsPerPage ??
              query.limit ??
              PHYGITALS_DEFAULT_PAGE_SIZE,
          );
          return emptyMeta(
            this.id,
            listings,
            (Number(params.page ?? 0) + 1) * pageSize < total,
            total,
            { etag },
          );
        }
        errors.push(`HTTP ${res.status} ${url}`);
        // Non-retryable (e.g. 4xx) or exhausted 429/5xx → try next param shape
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
      // Brief pause between alternate param shapes
      if (errors.length) await sleep(Math.min(this.retryDelayMs, 200));
    }

    // Soft-fail: never throw — empty page + lastError (MultiSourceRadar continues)
    // attemptIdx counts param shapes; fetchWithRetry handles per-URL retries.
    const detail = errors[0] ?? "unknown error";
    this.lastError = `phygitals soft-fail after ${attemptIdx} attempt(s): ${detail} — ${this.statusNote}`;
    return emptyMeta(this.id, [], false, 0, { softFail: true });
  }
}


export function createPhygitalsProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new PhygitalsProvider({ ...opts, id: "phygitals" });
}
