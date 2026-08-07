/**
 * Beezie venue providers (Base L2 + Solana share the Hono API shape).
 * Factories: createBeezieProvider (Base), createBeezieSolanaProvider.
 */
import {
  BeezieChain,
  BEEZIE_PAGE_SIZE,
  BEEZIE_SOLANA_PAGE_SIZE,
  dominantChain,
  emptyChainCounts,
  emptyMeta,
  LONGTAIL_DEFAULT_MAX_PAGES,
  LONGTAIL_MAX_PAGES_CAP,
  LongtailOptions,
  LongtailProvider,
  normalizeBeezieRow,
} from "./longtailCommon.js";
import {
  fetchWithRetry,
  getResponseEtag,
} from "../http/fetchWithRetry.js";
import { walkSequentialPages } from "./pageWalk.js";
import type { Listing } from "../types.js";
import type { PullPage, PullQuery } from "./types.js";

/**
 * Beezie venue provider (Base L2 + Solana share the Hono API shape).
 * Base L2: api.beezie.com (1-based pages, ~20/page). Solana:
 * solana-api.beezie.com (0-based pages, ≤100/page). `allBeezieCategories`
 * walks every enabled /dropItems/categories and merges into one scope.
 */
export class BeezieProvider extends LongtailProvider {
  private readonly beezieCategoryId: string;
  private readonly allBeezieCategories: boolean;

  constructor(
    opts: Omit<LongtailOptions, "id"> & { id: "beezie" | "beezie-solana" },
  ) {
    super(opts);
    this.beezieCategoryId = opts.beezieCategoryId ?? "1";
    this.allBeezieCategories = opts.allBeezieCategories ?? false;
  }

  protected override async pullVenue(query: PullQuery): Promise<PullPage> {
    return this.pullBeezie(query);
  }

  protected override async pullVenuePages(
    query: PullQuery & { maxPages?: number },
  ): Promise<PullPage> {
    return this.pullBeeziePages(query);
  }

  protected override async pullVenueAll(
    query: PullQuery & { maxPages?: number },
  ): Promise<PullPage> {
    if (this.allBeezieCategories) {
      return this.pullBeezieAllCategories(query);
    }
    return this.runPlannedWalk(query, this.walkPageSize(query));
  }

  protected override walkPageSize(_query: PullQuery): number {
    return this.id === "beezie-solana"
      ? BEEZIE_SOLANA_PAGE_SIZE
      : BEEZIE_PAGE_SIZE;
  }

  protected override fixtureHook(listings: Listing[]): void {
    const counts = emptyChainCounts();
    for (const l of listings) {
      const raw = l.raw as { chain?: BeezieChain } | undefined;
      const c = raw?.chain ?? "unknown";
      counts[c] = (counts[c] ?? 0) + 1;
    }
    this.lastBeezieMeta = {
      page: 1,
      pageSize: listings.length,
      total: listings.length,
      chainCounts: counts,
      dominantChain: dominantChain(counts),
    };
  }

  private async pullBeeziePages(
    query: PullQuery & { maxPages?: number; categoryId?: string },
  ): Promise<PullPage> {
    const categoryId = query.categoryId ?? this.beezieCategoryId;
    const pageSize =
      this.id === "beezie-solana" ? BEEZIE_SOLANA_PAGE_SIZE : BEEZIE_PAGE_SIZE;
    const maxPages = Math.max(
      1,
      Math.min(
        query.maxPages ?? LONGTAIL_DEFAULT_MAX_PAGES,
        LONGTAIL_MAX_PAGES_CAP,
      ),
    );
    const clientLimit = query.limit;
    const counts = emptyChainCounts();
    const solana = this.id === "beezie-solana";
    const walk = await walkSequentialPages(
      async (offset) => {
        const one = await this.pullBeezie({
          ...query,
          categoryId,
          offset,
          limit: undefined, // API ignores limit; fixed page size
        });
        for (const l of one.listings) {
          const raw = l.raw as { chain?: BeezieChain } | undefined;
          const c = raw?.chain ?? "unknown";
          counts[c] = (counts[c] ?? 0) + 1;
        }
        return {
          listings: one.listings,
          hasMore: one.hasMore,
          total: one.meta.total ?? null,
        };
      },
      {
        maxPages,
        pageSize,
        firstPage: solana ? 0 : 1,
        limit: clientLimit,
        label: "beezie",
      },
    );

    // Ambiguous empty first page (200 + 0 rows, no exception): treat as
    // soft-fail so sync never wipes a populated scope. (Multi-category walks
    // interpret this as legitimately empty via firstPageEmpty.)
    if (walk.firstPageEmpty && walk.partialError === null) {
      this.lastError = `beezie empty page (0 rows) — treated as soft-fail — ${this.statusNote}`;
      return emptyMeta(this.id, [], false, 0, { softFail: true });
    }
    if (walk.firstPageEmpty && walk.partialError !== null) {
      this.lastError = `beezie soft-fail page: ${walk.partialError} — ${this.statusNote}`;
      return emptyMeta(this.id, [], false, 0, { softFail: true });
    }
    if (walk.partialError) {
      this.lastError = `beezie partial multi-page after ${walk.listings.length} rows: ${walk.partialError}`;
    } else {
      this.lastError = null;
    }

    const listings =
      clientLimit != null ? walk.listings.slice(0, clientLimit) : walk.listings;
    this.lastBeezieMeta = {
      // 0-based venues: last fetched page index; 1-based: page number.
      page: Math.max(walk.pagesFetched - (solana ? 1 : 0), 0),
      pageSize,
      total: walk.total ?? listings.length,
      chainCounts: counts,
      dominantChain: dominantChain(counts),
    };
    return emptyMeta(
      this.id,
      listings,
      walk.hasMore &&
        (clientLimit == null || walk.listings.length < (walk.total ?? Infinity)),
      walk.total ?? listings.length,
    );
  }
  private async pullBeezieAllCategories(
    query: PullQuery & { maxPages?: number },
  ): Promise<PullPage> {
    const clientLimit = query.limit;
    // All-categories walks default to the full ceiling — each category's walk
    // ends naturally on !hasMore (LONGTAIL_DEFAULT_MAX_PAGES=1 would truncate).
    const maxPagesPerCat = Math.max(
      1,
      Math.min(
        query.maxPages ?? LONGTAIL_MAX_PAGES_CAP,
        LONGTAIL_MAX_PAGES_CAP,
      ),
    );
    const cats = await this.fetchBeezieCategories().catch((e) => {
      this.lastError = `beezie categories fetch failed: ${e instanceof Error ? e.message : String(e)} — ${this.statusNote}`;
      return null;
    });
    if (!cats || cats.length === 0) {
      return emptyMeta(this.id, [], false, 0, { softFail: true });
    }
    const all: Listing[] = [];
    let total = 0;
    let anyOk = false;
    const failures: string[] = [];
    const solana = this.id === "beezie-solana";
    const pageSize = solana ? BEEZIE_SOLANA_PAGE_SIZE : BEEZIE_PAGE_SIZE;
    for (const c of cats) {
      try {
        // Walk this category on the shared sequential walker for explicit
        // tri-state semantics (no ambiguity via builtAt heuristics):
        //  - firstPageEmpty + no error → legitimately empty category (the
        //    NORMAL state — most categories have 0 forSale items) → 0 rows,
        //    no failure
        //  - hard failure (exception) → failure (whole walk incomplete so
        //    sync never prunes the beezie scope on a broken category)
        //  - partial walk (rows kept) → rows are real; mass-drop guards
        //    bound any missing-category prune
        const one = await walkSequentialPages(
          async (offset) => {
            const pg = await this.pullBeezie({
              ...query,
              categoryId: String(c.id),
              offset,
              limit: undefined,
            });
            return {
              listings: pg.listings,
              hasMore: pg.hasMore,
              total: pg.meta.total ?? null,
            };
          },
          {
            maxPages: maxPagesPerCat,
            pageSize,
            firstPage: solana ? 0 : 1,
            label: `beezie category ${c.name || c.id}`,
          },
        );
        if (one.firstPageEmpty && one.partialError === null) continue;
        if (one.partialError) {
          failures.push(`${c.name || c.id}: ${one.partialError}`);
          continue;
        }
        if (one.listings.length > 0) anyOk = true;
        total += one.total ?? one.listings.length;
        all.push(...one.listings);
      } catch (e) {
        // Hard failure (categories fetch ok but the walk threw): mark
        // incomplete so sync never prunes the whole beezie scope.
        failures.push(`${c.name || c.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!anyOk) {
      this.lastError = `beezie all-categories soft-fail (${failures.length}/${cats.length} failed): ${failures[0] ?? "no rows"} — ${this.statusNote}`;
      return emptyMeta(this.id, [], false, 0, { softFail: true });
    }
    const listings = clientLimit != null ? all.slice(0, clientLimit) : all;
    if (failures.length > 0) {
      this.lastError = `beezie all-categories partial (${failures.length}/${cats.length} failed): ${failures.join("; ")}`;
      return emptyMeta(this.id, listings, true, total || listings.length);
    }
    this.lastError = null;
    return emptyMeta(
      this.id,
      listings,
      clientLimit != null && all.length >= clientLimit,
      total || listings.length,
    );
  }
  private async fetchBeezieCategories(): Promise<
    Array<{ id: number; name: string }>
  > {
    const url = `${this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl}/dropItems/categories`;
    const res = await fetchWithRetry(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": this.userAgent,
        },
      },
      {
        fetchImpl: this.fetchImpl,
        maxRetries: this.maxRetries,
        baseDelayMs: this.retryDelayMs,
      },
    );
    if (!res.ok) {
      throw new Error(`beezie HTTP ${res.status} ${url}`);
    }
    const json = (await res.json()) as Array<{
      id?: number | string;
      name?: string;
      enabled?: boolean;
    }>;
    if (!Array.isArray(json)) return [];
    return json
      .filter((c) => c && c.enabled !== false && c.id != null)
      .map((c) => ({ id: Number(c.id), name: String(c.name ?? c.id) }));
  }
  private beeziePageFromQuery(query: PullQuery): number {
    if (this.id === "beezie-solana") {
      // Solana API is 0-based: page = floor(offset / pageSize)
      if (query.offset != null && query.offset > 0) {
        return Math.floor(query.offset / BEEZIE_SOLANA_PAGE_SIZE);
      }
      return 0;
    }
    if (query.offset != null && query.offset > 0) {
      return Math.floor(query.offset / BEEZIE_PAGE_SIZE) + 1;
    }
    return 1;
  }
  private async fetchBeezieJson(
    url: string,
    body: Record<string, unknown>,
  ): Promise<{
    dropItems?: Record<string, unknown>[];
    total?: number;
    etag: string | null;
  }> {
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body: JSON.stringify(body),
      },
      {
        fetchImpl: this.fetchImpl,
        maxRetries: this.maxRetries,
        baseDelayMs: this.retryDelayMs,
      },
    );
    if (!res.ok) {
      throw new Error(
        `beezie HTTP ${res.status} ${url} — ${this.statusNote}`,
      );
    }
    const etag = getResponseEtag(res);
    if (etag) this.lastEtag = etag;
    const json = (await res.json()) as {
      dropItems?: Record<string, unknown>[];
      total?: number;
    };
    return { ...json, etag };
  }
  private async pullBeezie(
    query: PullQuery & { categoryId?: string },
  ): Promise<PullPage> {
    const url = new URL(
      this.listingPath,
      this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/",
    );
    const categoryId = query.categoryId ?? this.beezieCategoryId;
    const page = this.beeziePageFromQuery(query);
    const solana = this.id === "beezie-solana";
    const body = solana
      ? {
          filters: [] as unknown[],
          saleStatus: "forSale",
          page: String(page),
          pageSize: String(query.limit ?? BEEZIE_SOLANA_PAGE_SIZE),
          categoryId,
          // Sort: default = recently listed; price sort = priceOrder.
          // (Site also supports fmvOrder; not needed for radar pulls.)
          ...(query.sort === "price"
            ? { priceOrder: "ASC" }
            : { sellOrderDateOrder: "DESC" }),
        }
      : {
          filters: [] as unknown[],
          saleStatus: "forSale",
          sort: query.sort === "price" ? "priceAsc" : "recent",
          page: String(page),
          categoryId,
          // API currently ignores limit and returns ~20; still send for future compat
          limit: String(query.limit ?? BEEZIE_PAGE_SIZE),
        };
    const json = await this.fetchBeezieJson(url.toString(), body);
    const rows = json.dropItems ?? [];
    const listings = rows
      .map((r) => normalizeBeezieRow(r, this.id))
      .filter((x): x is Listing => x != null);
    const sliced =
      query.limit != null ? listings.slice(0, query.limit) : listings;
    const counts = emptyChainCounts();
    for (const l of sliced) {
      const raw = l.raw as { chain?: BeezieChain } | undefined;
      const c = raw?.chain ?? "unknown";
      counts[c] = (counts[c] ?? 0) + 1;
    }
    const total = json.total ?? null;
    const pageSize = rows.length || (solana ? BEEZIE_SOLANA_PAGE_SIZE : BEEZIE_PAGE_SIZE);
    // EVM pages are 1-based (page*size < total); Solana pages are 0-based
    // ((page+1)*size < total).
    const hasMore =
      total != null
        ? solana
          ? (page + 1) * pageSize < total
          : page * pageSize < total
        : rows.length >= pageSize;
    this.lastBeezieMeta = {
      page,
      pageSize,
      total,
      chainCounts: counts,
      dominantChain: dominantChain(counts),
    };
    return emptyMeta(this.id, sliced, hasMore, total ?? sliced.length, {
      etag: json.etag,
    });
  }
}


export function createBeezieProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new BeezieProvider({ ...opts, id: "beezie" });
}
/**
 * Beezie **Solana** marketplace (solana.beezie.com, API solana-api.beezie.com).
 * Solana mints + USDC SellOrders; pokemon = categoryId "1".
 */
export function createBeezieSolanaProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new BeezieProvider({ ...opts, id: "beezie-solana" });
}
