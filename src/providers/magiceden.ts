/**
 * Magic Eden Solana listings for Collector Crypt collection (and similar).
 * Public: https://api-mainnet.magiceden.dev/v2/collections/{symbol}/listings
 * Offers: https://api-mainnet.magiceden.dev/v2/tokens/{mint}/offers_received
 *
 * Price units (ME v2, verified live):
 *   - listings[].price              → SOL float
 *   - priceInfo.solPrice.rawAmount  → lamports (string, decimals 9)
 *   - stats.floorPrice              → lamports
 *   - tokens/{mint}/offers_received → price in SOL float (when present)
 */
import { contentFingerprint } from "../contentFingerprint.js";
import { meListingUrl } from "../externalUrl.js";
import { deltaFromListing } from "../fmv/delta.js";
import { listingId } from "../identity.js";
import {
  fetchWithRetry,
  getResponseEtag,
  isNotModifiedStatus,
} from "../http/fetchWithRetry.js";
import {
  DEFAULT_PAGE_CONCURRENCY,
  paginateConcurrent,
  type AdaptiveConcurrencyOptions,
} from "../http/pageConcurrency.js";
import type { BidOrder } from "../orderbook/types.js";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TTL_MS,
  TtlCache,
  mapWithBidBudget,
} from "../orderbook/bidBudget.js";
import type { Listing } from "../types.js";
import type { ListingsProvider, PullPage, PullQuery } from "./types.js";
import type { BidsProvider, BidsPullQuery } from "../orderbook/BidsProvider.js";

const DEFAULT_BASE = "https://api-mainnet.magiceden.dev";
/** Solana Collector Crypt collection on Magic Eden. */
const DEFAULT_SYMBOL = "collector_crypt";
/** Fallback when no solPriceUsd and live fetch fails. */
const DEFAULT_SOL_USD = 150;
const LAMPORTS_PER_SOL = 1e9;
/**
 * ME collection listings `limit` max (public API). Larger page sizes are clamped.
 * Pagination uses `offset` + `limit` (no total/cursor in the JSON array response).
 */
export const ME_MAX_PAGE_LIMIT = 100;
/** Default page size for pull / pullAll when limit omitted. */
const DEFAULT_PAGE_LIMIT = 20;
/**
 * Safety ceiling when pullAll is asked for a "full" book without maxPages.
 * Full collector_crypt universe can exceed this; raise maxPages explicitly.
 * See docs/NATIVE_SOURCES.md (ME pagination blockers).
 */
export const ME_DEFAULT_MAX_PAGES = 50;
/**
 * Cold bootstrap page cap (`bootstrap: true`, page ≤ 100 → up to 50k rows).
 * Stop earlier on empty / !hasMore. Explicit maxPages can go higher.
 */
export const ME_BOOTSTRAP_MAX_PAGES = 500;
/** Cache live SOL/USD briefly to avoid CoinGecko rate limits on multi-mint pulls. */
const SOL_PRICE_CACHE_MS = 60_000;
/**
 * Default max mints that get per-token `offers_received` per pull.
 * Override via `sampleMints` or `pull({ limit })`. See docs/BIDS_BUDGET.md.
 */
export const DEFAULT_SAMPLE_MINTS = 8;

let solPriceCache: { usd: number; at: number } | null = null;

export interface MeSolPrice {
  rawAmount?: string | number;
  address?: string;
  decimals?: number;
}

export interface MeTokenAttr {
  trait_type?: string;
  value?: string | number | boolean;
}

export interface MeToken {
  mintAddress?: string;
  name?: string;
  image?: string;
  externalUrl?: string;
  attributes?: MeTokenAttr[];
  collection?: string;
  collectionName?: string;
  [key: string]: unknown;
}

export interface MeListing {
  pdaAddress?: string;
  tokenMint?: string;
  tokenAddress?: string;
  /** SOL float on v2 collection listings */
  price?: number;
  priceInfo?: { solPrice?: MeSolPrice; [key: string]: unknown };
  seller?: string;
  rarity?: unknown;
  extra?: { img?: string };
  listingTime?: number;
  token?: MeToken;
  listingSource?: string;
  expiry?: number;
  [key: string]: unknown;
}

export interface MeOffer {
  price?: number;
  buyer?: string;
  expiry?: number;
  pdaAddress?: string;
  priceInfo?: { solPrice?: MeSolPrice; [key: string]: unknown };
  [key: string]: unknown;
}

export interface MagicEdenOptions {
  baseUrl?: string;
  /** Collection symbol, default `collector_crypt` (Solana CC on ME). */
  symbol?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  /**
   * SOL→USD rate for converting ME SOL prices into USD-ish Listing.price.
   * When omitted, providers use a **live** CoinGecko fetch (cached ~60s),
   * then DEFAULT_SOL_USD only if live fails.
   */
  solPriceUsd?: number;
  /**
   * Skip live SOL price fetch (use `solPriceUsd` or DEFAULT_SOL_USD).
   * Prefer live in production; set for unit tests / offline.
   */
  offlineSolPrice?: boolean;
  /**
   * When true (default), HTTP/network/parse failures return an empty page
   * with `lastError` set instead of throwing — multi-source radar stays up.
   * Fixture/offline misconfig still throws.
   */
  softEmptyOnError?: boolean;
  /** Max retries on 429 / 5xx (default 3). */
  maxRetries?: number;
  /** Base delay ms for exponential backoff (default 500). */
  retryDelayMs?: number;
  /**
   * Default page size for single `pull` and multi-page `pullAll` when
   * `query.limit` is omitted. Clamped to {@link ME_MAX_PAGE_LIMIT} (100).
   */
  defaultLimit?: number;
  /**
   * Default max pages for `pullAll` / `pullPages` when neither `maxPages`
   * nor a finite desired `limit` is given. Default {@link ME_DEFAULT_MAX_PAGES}.
   */
  defaultMaxPages?: number;
  /**
   * Concurrent multi-page cold pulls (default start 8, max 16).
   * `{ start: 1, max: 1 }` forces sequential.
   */
  pageConcurrency?: AdaptiveConcurrencyOptions;
}

/** Diagnostics from last multi-page pull (pullPages / pullAll). */
export interface MeListingsPullMeta {
  pagesFetched: number;
  pageLimit: number;
  offsetStart: number;
  offsetEnd: number;
  rawRows: number;
  listingsNormalized: number;
  stoppedReason: "empty" | "hasMore_false" | "maxPages" | "desired" | "single" | "soft_error";
  symbol: string;
  lastUrl: string | null;
}

export interface MeNormalizeOpts {
  providerId?: string;
  solPriceUsd?: number;
  symbol?: string;
}

/**
 * Convert a ME price field to SOL.
 * Prefer priceInfo.solPrice (lamports + decimals); else treat top-level price as SOL float.
 * Explicit lamports-only numbers (integers ≥ 1e6 with no priceInfo) are treated as lamports.
 */
export function mePriceToSol(
  price: number | string | undefined | null,
  priceInfo?: { solPrice?: MeSolPrice } | null,
): number | null {
  const solInfo = priceInfo?.solPrice;
  if (solInfo?.rawAmount != null && solInfo.rawAmount !== "") {
    const raw = Number(solInfo.rawAmount);
    if (!Number.isFinite(raw) || raw < 0) return null;
    const decimals =
      solInfo.decimals != null && Number.isFinite(Number(solInfo.decimals))
        ? Number(solInfo.decimals)
        : 9;
    return raw / 10 ** decimals;
  }
  if (price == null || price === "") return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return null;
  // Integer in typical lamports range without fractional SOL → lamports
  // (stats.floorPrice, some offer payloads). Listing v2 `price` is always a SOL float.
  if (Number.isInteger(n) && n >= 1_000_000) {
    return n / LAMPORTS_PER_SOL;
  }
  return n;
}

/** SOL → USD (2dp). */
export function solToUsd(sol: number, solPriceUsd: number): number {
  return Math.round(sol * solPriceUsd * 100) / 100;
}

function attrMap(token?: MeToken | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of token?.attributes ?? []) {
    if (a?.trait_type == null) continue;
    m.set(String(a.trait_type).toLowerCase(), String(a.value ?? ""));
  }
  return m;
}

function mapCategoryToTcg(category?: string | null): string | null {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c.includes("pokemon")) return "pokemon";
  if (c.includes("one piece")) return "one_piece";
  if (c.includes("magic") || c === "mtg") return "mtg";
  if (c.includes("yu-gi") || c.includes("yugioh")) return "yugioh";
  if (c.includes("moonbirds")) return null;
  return c.replace(/\s+/g, "_");
}

function mapItemType(type?: string | null): string | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t === "sealed" || t === "box") return "sealed";
  if (t === "card" || t === "raw") return "card";
  if (t === "merch") return "merch";
  return t;
}

/**
 * Fetch live SOL/USD (CoinGecko). Returns null on failure.
 * Module-level cache (~60s) shared across listings + bids pulls.
 */
export async function fetchSolPriceUsd(
  fetchImpl: typeof fetch = fetch,
  opts?: { bypassCache?: boolean },
): Promise<number | null> {
  if (!opts?.bypassCache && solPriceCache) {
    if (Date.now() - solPriceCache.at < SOL_PRICE_CACHE_MS) {
      return solPriceCache.usd;
    }
  }
  try {
    const res = await fetchWithRetry(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { headers: { Accept: "application/json" } },
      { fetchImpl, maxRetries: 2, baseDelayMs: 300 },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { solana?: { usd?: number } };
    const px = body?.solana?.usd;
    if (px != null && Number.isFinite(px) && px > 0) {
      solPriceCache = { usd: px, at: Date.now() };
      return px;
    }
    return null;
  } catch {
    return null;
  }
}

/** Test helper: clear live SOL price cache. */
export function clearSolPriceCache(): void {
  solPriceCache = null;
}

export function normalizeMeListing(
  row: MeListing,
  opts: MeNormalizeOpts = {},
): Listing | null {
  const mint = row.tokenMint ?? row.tokenAddress ?? row.token?.mintAddress;
  if (!mint) return null;

  const sol = mePriceToSol(row.price, row.priceInfo);
  if (sol == null || sol <= 0) return null;

  const px = opts.solPriceUsd ?? DEFAULT_SOL_USD;
  const priceUsd = solToUsd(sol, px);

  const attrs = attrMap(row.token);
  const category = attrs.get("category") ?? null;
  const type = attrs.get("type") ?? null;
  const insured = attrs.get("insured value");
  const yearRaw = attrs.get("year");
  const grader =
    attrs.get("grading company") ?? attrs.get("grader") ?? null;
  const grade = attrs.get("grade") ?? null;
  const fmv =
    insured != null && insured !== "" && Number.isFinite(Number(insured))
      ? Number(insured)
      : null;

  const name =
    row.token?.name?.trim() ||
    (mint.length > 12 ? mint.slice(0, 12) + "…" : mint);

  const imageUrl =
    row.token?.image ??
    (row.extra as { img?: string } | undefined)?.img ??
    null;

  const listedAt =
    row.listingTime != null
      ? new Date(Number(row.listingTime) * 1000).toISOString()
      : null;

  const providerId = opts.providerId ?? "magiceden";
  const nativeId = row.pdaAddress ?? mint;

  return {
    id: listingId({ provider: providerId, platform: "me", nativeId }),
    provider: providerId,
    platform: "me",
    nativeId,
    tokenId: mint,
    name,
    price: priceUsd,
    currency: "USDC",
    fmv,
    delta: deltaFromListing(priceUsd, fmv, "USDC"),
    market: "Magic Eden",
    seller: row.seller ?? null,
    // Prefer origin token.externalUrl; always fall back to public mint page.
    externalUrl:
      (row.token?.externalUrl &&
      /^https?:\/\//i.test(row.token.externalUrl.trim())
        ? row.token.externalUrl.trim()
        : null) ?? meListingUrl(mint),
    imageUrl,
    listedAt,
    firstListedAt: listedAt,
    lastEvent: "LIST",
    tcg: mapCategoryToTcg(category),
    itemType: mapItemType(type),
    grader,
    grade,
    gradeNum:
      grade != null && Number.isFinite(Number(grade)) ? Number(grade) : null,
    language: attrs.get("language") ?? null,
    setRaw: attrs.get("set") ?? null,
    cardNumber: null,
    year:
      yearRaw != null && Number.isFinite(Number(yearRaw))
        ? Number(yearRaw)
        : null,
    confidence: null,
    canonical: null,
    contractAddress: null,
    searchBlob: [name, category, type, mint].filter(Boolean).join(" "),
    raw: row,
  };
}

async function resolveSolUsd(
  opts: MagicEdenOptions,
  fetchImpl: typeof fetch,
): Promise<number> {
  if (opts.solPriceUsd != null && Number.isFinite(opts.solPriceUsd) && opts.solPriceUsd > 0) {
    return opts.solPriceUsd;
  }
  if (opts.offlineSolPrice) return DEFAULT_SOL_USD;
  // Live SOL price (default path for Solana ME)
  const live = await fetchSolPriceUsd(fetchImpl);
  return live ?? DEFAULT_SOL_USD;
}

function emptyPullPage(providerId: string): PullPage {
  // Soft-fail empty: no fingerprint (avoid generation short-circuit vs prior book)
  return {
    listings: [],
    hasMore: false,
    meta: {
      provider: providerId,
      builtAt: null,
      total: null,
      universe: null,
      fetchedAt: new Date().toISOString(),
      querySignature: "",
    },
  };
}

export class MagicEdenProvider implements ListingsProvider {
  readonly id = "magiceden";
  private readonly baseUrl: string;
  private readonly symbol: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: MagicEdenOptions;
  private readonly softEmpty: boolean;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly defaultLimit: number;

  /**
   * Point lookup by mint: GET /v2/tokens/{mint}/listings (active asks, SOL
   * price). Returns the first active listing or null. Name is not returned
   * by this endpoint — the mint short form is used.
   */
  async getByTokenId(tokenId: string): Promise<Listing | null> {
    const url = `${this.baseUrl}/v2/tokens/${encodeURIComponent(tokenId)}/listings`;
    const res = await fetchWithRetry(
      url,
      { headers: { Accept: "application/json", "User-Agent": this.userAgent } },
      {
        fetchImpl: this.fetchImpl,
        maxRetries: this.maxRetries,
        baseDelayMs: this.retryDelayMs,
      },
    );
    if (!res.ok) {
      this.lastError = `magiceden getByTokenId HTTP ${res.status}`;
      return null;
    }
    const rows = (await res.json()) as MeListing[];
    const row = rows?.[0];
    if (!row?.tokenMint) return null;
    const sol = mePriceToSol(row.price, row.priceInfo);
    if (sol == null || sol <= 0) return null;
    const solUsd =
      this.opts.solPriceUsd ??
      (await fetchSolPriceUsd(this.fetchImpl).catch(() => DEFAULT_SOL_USD)) ??
      DEFAULT_SOL_USD;
    return {
      id: listingId({
        provider: this.id,
        platform: this.symbol,
        nativeId: row.tokenMint,
      }),
      provider: this.id,
      platform: this.symbol,
      nativeId: row.tokenMint,
      tokenId: row.tokenMint,
      name: `Magic Eden ${tokenId.slice(0, 8)}…`,
      price: solToUsd(sol, solUsd),
      currency: "USD",
      fmv: null,
      delta: null,
      market: "Magic Eden",
      seller: row.seller ?? null,
      externalUrl: meListingUrl(row.tokenMint),
      imageUrl: null,
      listedAt: null,
      firstListedAt: null,
      lastEvent: "LIST",
      tcg: null,
      itemType: "card",
      grader: null,
      grade: null,
      gradeNum: null,
      language: null,
      setRaw: null,
      cardNumber: null,
      year: null,
      confidence: null,
      canonical: null,
      contractAddress: null,
      searchBlob: tokenId,
      raw: row,
    };
  }
  private readonly defaultMaxPages: number;
  private readonly pageConcurrency: AdaptiveConcurrencyOptions;
  /** Last concurrent page-walk stats. */
  lastPageWalkStats: {
    pagesAttempted: number;
    pagesOk: number;
    throttles: number;
    peakConcurrency: number;
    wallMs: number;
  } | null = null;
  /** Last ETag per listings URL (If-None-Match on next pull). */
  private readonly etagByUrl = new Map<string, string>();
  /** Most recent listings ETag (diagnostics / fallback). */
  lastEtag: string | null = null;
  /** Last successful SOL/USD rate used (live or configured). */
  lastSolPriceUsd: number | null = null;
  /** Mints from last pull (for optional top-mint offers). */
  lastMints: string[] = [];
  /** Last soft-fail error message; null after a successful pull. */
  lastError: string | null = null;
  /** Last listings URL attempted (operators / tests). */
  lastUrl: string | null = null;
  /** Diagnostics from last pull / pullAll. */
  lastPullMeta: MeListingsPullMeta | null = null;
  /** Pages fetched in last pull / pullAll. */
  lastPagesFetched = 0;

  constructor(opts: MagicEdenOptions = {}) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.symbol = opts.symbol ?? DEFAULT_SYMBOL;
    this.userAgent = opts.userAgent ?? "traded-listings/0.3 (+magiceden)";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.softEmpty = opts.softEmptyOnError !== false;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.defaultLimit = Math.min(
      Math.max(1, opts.defaultLimit ?? DEFAULT_PAGE_LIMIT),
      ME_MAX_PAGE_LIMIT,
    );
    this.defaultMaxPages = Math.max(
      1,
      opts.defaultMaxPages ?? ME_DEFAULT_MAX_PAGES,
    );
    this.pageConcurrency = opts.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
  }

  async pull(query: PullQuery = {}): Promise<PullPage> {
    this.lastError = null;
    const limit = Math.min(
      Math.max(1, query.limit ?? this.defaultLimit),
      ME_MAX_PAGE_LIMIT,
    );
    const offset = Math.max(0, query.offset ?? 0);
    const fetchedAt = new Date().toISOString();
    this.lastUrl = null;

    let rows: MeListing[];
    let etag: string | null = null;
    try {
      if (query.fixturePath) {
        const { readFile } = await import("node:fs/promises");
        const body = JSON.parse(await readFile(query.fixturePath, "utf8"));
        rows = Array.isArray(body) ? body : (body.listings ?? body.results ?? []);
      } else if (query.offline) {
        throw new Error(
          "MagicEdenProvider: offline requires fixturePath (no network)",
        );
      } else {
        // Listings: collector_crypt (or configured symbol) on ME Solana v2
        // Pagination: offset + limit (≤100). Response is a bare JSON array — no total.
        const url = `${this.baseUrl}/v2/collections/${encodeURIComponent(this.symbol)}/listings?offset=${offset}&limit=${limit}`;
        this.lastUrl = url;
        const inm =
          query.ifNoneMatch ||
          this.etagByUrl.get(url) ||
          this.lastEtag ||
          null;
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
            ifNoneMatch: inm,
          },
        );
        if (isNotModifiedStatus(res.status)) {
          const et = getResponseEtag(res) ?? inm;
          if (et) {
            this.etagByUrl.set(url, et);
            this.lastEtag = et;
          }
          this.lastMints = [];
          this.lastPagesFetched = 0;
          this.lastPullMeta = {
            pagesFetched: 0,
            pageLimit: limit,
            offsetStart: offset,
            offsetEnd: offset,
            rawRows: 0,
            listingsNormalized: 0,
            stoppedReason: "single",
            symbol: this.symbol,
            lastUrl: url,
          };
          return {
            listings: [],
            hasMore: false,
            notModified: true,
            meta: {
              provider: this.id,
              builtAt: null,
              total: null,
              universe: null,
              fetchedAt,
              querySignature: "",
              etag: et,
            },
          };
        }
        if (!res.ok) {
          throw new Error(`Magic Eden HTTP ${res.status} for ${url}`);
        }
        etag = getResponseEtag(res);
        if (etag) {
          this.etagByUrl.set(url, etag);
          this.lastEtag = etag;
        }
        const body = await res.json();
        if (!Array.isArray(body)) {
          throw new Error("Magic Eden listings: expected JSON array");
        }
        rows = body as MeListing[];
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Offline misconfig must still throw; live/API failures soft-empty
      if (query.offline && !query.fixturePath) throw e instanceof Error ? e : new Error(msg);
      if (!this.softEmpty) throw e instanceof Error ? e : new Error(msg);
      this.lastError = msg;
      this.lastMints = [];
      this.lastPagesFetched = 0;
      this.lastPullMeta = {
        pagesFetched: 0,
        pageLimit: limit,
        offsetStart: offset,
        offsetEnd: offset,
        rawRows: 0,
        listingsNormalized: 0,
        stoppedReason: "soft_error",
        symbol: this.symbol,
        lastUrl: this.lastUrl,
      };
      return emptyPullPage(this.id);
    }

    const solPriceUsd = await resolveSolUsd(this.opts, this.fetchImpl);
    this.lastSolPriceUsd = solPriceUsd;

    const listings: Listing[] = [];
    const mints: string[] = [];
    for (const r of rows) {
      const n = normalizeMeListing(r, {
        providerId: this.id,
        solPriceUsd,
        symbol: this.symbol,
      });
      if (!n) continue;
      // Optional client-side tcg filter (ME collection is mixed categories)
      if (query.tcg && n.tcg && n.tcg !== query.tcg) continue;
      if (query.tcg && !n.tcg && query.tcg !== "all") {
        // keep unknown-tcg rows so radar still gets ME floor inventory
      }
      listings.push(n);
      if (n.tokenId) mints.push(n.tokenId);
    }
    this.lastMints = mints;
    this.lastPagesFetched = 1;
    this.lastPullMeta = {
      pagesFetched: 1,
      pageLimit: limit,
      offsetStart: offset,
      offsetEnd: offset + rows.length,
      rawRows: rows.length,
      listingsNormalized: listings.length,
      stoppedReason: "single",
      symbol: this.symbol,
      lastUrl: this.lastUrl,
    };

    // Stable generation when origin has no builtAt; works without ETag.
    const fp = contentFingerprint(listings);

    return {
      listings,
      // Bare array: assume more pages when origin filled the requested page.
      hasMore: rows.length >= limit,
      meta: {
        provider: this.id,
        builtAt: fp,
        total: null,
        universe: null,
        fetchedAt,
        querySignature: "",
        etag,
        contentFingerprint: fp,
      },
    };
  }

  /**
   * Multi-page collection listings via `offset`/`limit`.
   * First page sequential; remaining pages concurrent with adaptive
   * concurrency + backoff. Soft-fails empty (same as `pull`).
   */
  async pullPages(
    query: PullQuery & { maxPages?: number } = {},
  ): Promise<PullPage> {
    if (query.fixturePath || query.offline) {
      return this.pull(query);
    }

    const pageLimit = Math.min(
      Math.max(1, query.limit ?? this.defaultLimit),
      ME_MAX_PAGE_LIMIT,
    );
    const maxPages = Math.max(1, query.maxPages ?? 1);
    const offsetStart = Math.max(0, query.offset ?? 0);
    let etag: string | null = null;
    let lastUrl: string | null = null;
    let stoppedReason: MeListingsPullMeta["stoppedReason"] = "maxPages";
    let softError = false;

    const walk = await paginateConcurrent<Listing>({
      maxPages,
      concurrency: this.pageConcurrency,
      baseBackoffMs: this.retryDelayMs,
      fetchFirst: async () => {
        const one = await this.pull({
          ...query,
          limit: pageLimit,
          offset: offsetStart,
          ifNoneMatch: query.ifNoneMatch,
        });
        if (one.notModified) {
          return { listings: [], full: false, notModified: true };
        }
        lastUrl = this.lastUrl ?? lastUrl;
        etag = one.meta.etag ?? etag;
        if (this.lastError) {
          softError = true;
          stoppedReason = "soft_error";
          return { listings: [], full: false };
        }
        const full = one.hasMore === true;
        if (!full) {
          stoppedReason =
            one.listings.length === 0 ? "empty" : "hasMore_false";
        }
        return { listings: one.listings, full };
      },
      fetchPage: async (pageIndex) => {
        const offset = offsetStart + pageIndex * pageLimit;
        const one = await this.pull({
          ...query,
          limit: pageLimit,
          offset,
        });
        lastUrl = this.lastUrl ?? lastUrl;
        etag = one.meta.etag ?? etag;
        if (this.lastError) {
          softError = true;
          stoppedReason = "soft_error";
          return { listings: [], full: false };
        }
        const full = one.hasMore === true;
        if (!full) {
          stoppedReason =
            one.listings.length === 0 ? "empty" : "hasMore_false";
        }
        return { listings: one.listings, full };
      },
    });

    if (walk.notModified) {
      return emptyPullPage(this.id);
    }

    // Soft-fail empty (first page or total wipe): no fingerprint
    if (softError && walk.listings.length === 0) {
      this.lastPagesFetched = 0;
      this.lastMints = [];
      this.lastUrl = lastUrl;
      this.lastPullMeta = {
        pagesFetched: 0,
        pageLimit,
        offsetStart,
        offsetEnd: offsetStart,
        rawRows: 0,
        listingsNormalized: 0,
        stoppedReason: "soft_error",
        symbol: this.symbol,
        lastUrl,
      };
      return emptyPullPage(this.id);
    }

    // Successful pages only (exclude trailing soft-empty chunks from count)
    const okPages =
      softError && walk.listings.length > 0
        ? Math.max(1, walk.pagesFetched - 1)
        : walk.pagesFetched;

    // Final stop reason from assemble semantics (not last concurrent racer)
    if (softError) {
      stoppedReason = "soft_error";
    } else if (walk.hasMore) {
      stoppedReason = "maxPages";
    } else if (walk.listings.length === 0) {
      stoppedReason = "empty";
    } else {
      // short last page with rows, or clean end
      stoppedReason = "hasMore_false";
    }

    this.lastPageWalkStats = {
      pagesAttempted: walk.stats.items + 1,
      pagesOk: walk.stats.ok + (softError ? 0 : 1),
      throttles: walk.stats.throttles,
      peakConcurrency: walk.stats.peakConcurrency,
      wallMs: walk.stats.wallMs,
    };

    const mints = walk.listings
      .map((l) => l.tokenId)
      .filter((x): x is string => !!x);
    this.lastMints = mints;
    this.lastPagesFetched = okPages;
    this.lastUrl = lastUrl;
    this.lastPullMeta = {
      pagesFetched: okPages,
      pageLimit,
      offsetStart,
      offsetEnd: offsetStart + okPages * pageLimit,
      rawRows: walk.listings.length,
      listingsNormalized: walk.listings.length,
      stoppedReason,
      symbol: this.symbol,
      lastUrl,
    };

    const fp = contentFingerprint(walk.listings);
    // Mid-pagination soft-fail is incomplete: hasMore must stay true so
    // syncOnce never mass-prunes the prior full scope (poll-diff delist only
    // after a complete multi-page walk). Empty soft-fail returns above.
    const incompleteSoft = softError && walk.listings.length > 0;
    return {
      listings: walk.listings,
      hasMore: incompleteSoft ? true : walk.hasMore,
      meta: {
        provider: this.id,
        builtAt: fp,
        total: null,
        universe: null,
        fetchedAt: new Date().toISOString(),
        querySignature: "",
        etag,
        contentFingerprint: fp,
      },
    };
  }

  /**
   * Fuller multi-page pull used by syncOnce when present.
   * Paginates collector_crypt (or configured symbol) until desired `limit`
   * listings, `!hasMore` / empty page, or `maxPages`.
   *
   * `bootstrap: true` (or explicit maxPages without a small limit) uses a high
   * page cap and page size {@link ME_MAX_PAGE_LIMIT} for cold full-book fills.
   *
   * **API limits / full-universe blockers** (see docs/NATIVE_SOURCES.md):
   * - `limit` ≤ 100 per request; only `offset`/`limit` (no total count).
   * - Bare JSON array → `hasMore` is inferred from full pages (may overshoot once).
   * - Public rate limits / 429; retries help but unbounded scans are unsafe.
   * - No authenticated bulk dump; collection size can exceed default maxPages.
   * - Soft-fail empty on origin errors (partial pages kept if mid-pagination).
   */
  async pullAll(query: PullQuery = {}): Promise<PullPage> {
    if (query.fixturePath || query.offline) {
      return this.pull(query);
    }

    const bootstrap = Boolean(query.bootstrap);
    const hasExplicitMaxPages =
      query.maxPages != null && Number.isFinite(query.maxPages);
    const desired =
      query.limit != null && Number.isFinite(query.limit) && query.limit > 0
        ? Math.floor(query.limit)
        : bootstrap || hasExplicitMaxPages
          ? Number.POSITIVE_INFINITY
          : this.defaultLimit;
    const pageLimit = Math.min(
      Math.max(
        1,
        Number.isFinite(desired)
          ? Math.min(desired, ME_MAX_PAGE_LIMIT)
          : ME_MAX_PAGE_LIMIT,
      ),
      ME_MAX_PAGE_LIMIT,
    );
    const maxPages = hasExplicitMaxPages
      ? Math.max(1, Math.floor(query.maxPages!))
      : bootstrap
        ? ME_BOOTSTRAP_MAX_PAGES
        : Math.max(
            1,
            Math.min(
              this.defaultMaxPages,
              Math.ceil((desired as number) / pageLimit),
            ),
          );

    if (maxPages === 1) {
      return this.pull({
        ...query,
        limit: Number.isFinite(desired)
          ? Math.min(desired as number, pageLimit)
          : pageLimit,
        offset: query.offset ?? 0,
      });
    }

    const page = await this.pullPages({
      ...query,
      limit: pageLimit,
      maxPages,
      offset: query.offset ?? 0,
    });

    if (page.notModified) return page;

    if (Number.isFinite(desired) && page.listings.length > (desired as number)) {
      const cap = desired as number;
      const sliced = page.listings.slice(0, cap);
      const fp = contentFingerprint(sliced);
      this.lastMints = sliced
        .map((l) => l.tokenId)
        .filter((x): x is string => !!x);
      if (this.lastPullMeta) {
        this.lastPullMeta = {
          ...this.lastPullMeta,
          listingsNormalized: sliced.length,
          stoppedReason:
            this.lastPullMeta.stoppedReason === "maxPages" ||
            this.lastPullMeta.stoppedReason === "hasMore_false"
              ? "desired"
              : this.lastPullMeta.stoppedReason,
        };
      }
      return {
        ...page,
        listings: sliced,
        meta: {
          ...page.meta,
          builtAt: fp,
          contentFingerprint: fp,
        },
      };
    }
    return page;
  }
}

export interface MagicEdenBidsOptions extends MagicEdenOptions {
  /** Explicit mints to query offers for (top of list when from listings). */
  mints?: string[];
  /**
   * When set and mints empty, pull listings first and use those mints.
   * Default: create a MagicEdenProvider from the same opts.
   */
  listingsProvider?: MagicEdenProvider;
  /**
   * Max in-flight `offers_received` fetches (default {@link DEFAULT_MAX_CONCURRENT} = 4).
   * Prefer this name; `concurrency` is an alias for the same knob.
   */
  maxConcurrent?: number;
  /** @deprecated Prefer `maxConcurrent`. Same default (4). */
  concurrency?: number;
  /**
   * Cap how many mints get per-token `offers_received` after listings pull / setMints.
   * Default {@link DEFAULT_SAMPLE_MINTS} (**8**). Overridable per pull via `query.limit`.
   * Offers are best-effort — empty or failed mints never throw.
   * @see docs/BIDS_BUDGET.md
   */
  sampleMints?: number;
  /**
   * Per-mint TTL for cached `offers_received` results (ms).
   * Default {@link DEFAULT_TTL_MS} (**30_000**). Cache hits skip origin HTTP.
   * `ttlMs ≤ 0` disables caching (always re-fetch).
   */
  ttlMs?: number;
  /**
   * When false, skip offer fetches entirely (listings path only).
   * Default true — offers remain optional and soft-empty per mint.
   */
  fetchOffers?: boolean;
  /** Test clock for TTL expiry (defaults to Date.now). */
  now?: () => number;
}

export interface MeBidsPullMeta {
  mintsAttempted: number;
  mintsFromListings: number;
  offersRaw: number;
  bidsNormalized: number;
  /** Per-mint status: endpoint that returned 2xx array (or null on failure). */
  attempts: Array<{
    mint: string;
    endpoint: string | null;
    httpStatus: number | null;
    offerCount: number;
  }>;
  solPriceUsd: number;
  fetchedAt: string;
  /** Origin HTTP for offers_received/offers this pull (cache misses only). */
  bidsHttpCalls: number;
  /** Mints served from TTL cache (no detail HTTP). */
  cacheHits: number;
  /** Instruments selected after sample cap (`min(sampleSize, candidates)`). */
  sampleUsed: number;
  maxConcurrent: number;
  ttlMs: number;
}

/** Cached per-mint offer harvest (TTL key: magiceden_bids + mint). */
type MeMintOfferSlot = {
  bids: BidOrder[];
  attempt: MeBidsPullMeta["attempts"][number];
};

function emptyMePullMeta(
  partial: Partial<MeBidsPullMeta> &
    Pick<MeBidsPullMeta, "solPriceUsd" | "maxConcurrent" | "ttlMs">,
): MeBidsPullMeta {
  return {
    mintsAttempted: 0,
    mintsFromListings: 0,
    offersRaw: 0,
    bidsNormalized: 0,
    attempts: [],
    bidsHttpCalls: 0,
    cacheHits: 0,
    sampleUsed: 0,
    fetchedAt: new Date().toISOString(),
    ...partial,
  };
}

function normalizeMeOffer(
  o: MeOffer,
  mint: string,
  solPriceUsd: number,
  providerId: string,
): BidOrder | null {
  const sol = mePriceToSol(o.price, o.priceInfo);
  if (sol == null || sol <= 0) return null;
  const usd = solToUsd(sol, solPriceUsd);
  const nativeId = o.pdaAddress ?? `${mint}:${o.buyer ?? "unknown"}`;
  return {
    id: listingId({
      provider: providerId,
      platform: "me",
      nativeId,
    }),
    provider: providerId,
    instrumentKey: `me:mint:${mint}`,
    nativeId,
    side: "bid",
    price: usd,
    size: 1,
    currency: "USDC",
    bidder: o.buyer ?? null,
    platform: "me",
    updatedAt: new Date().toISOString(),
    raw: o,
  };
}

/**
 * Token offers (bids) on Magic Eden.
 * Flow: sample mints (from opts / prior setMints / ME listings pull) →
 * GET /v2/tokens/{mint}/offers_received (fallback: /offers), with
 * sample cap + TTL cache + concurrency via {@link mapWithBidBudget}.
 *
 * Defaults (see docs/BIDS_BUDGET.md):
 * - sampleMints: {@link DEFAULT_SAMPLE_MINTS} (8)
 * - maxConcurrent: {@link DEFAULT_MAX_CONCURRENT} (4)
 * - ttlMs: {@link DEFAULT_TTL_MS} (30_000) per mint offers_received
 */
export class MagicEdenBidsProvider implements BidsProvider {
  readonly id = "magiceden_bids";
  private readonly opts: MagicEdenBidsOptions;
  /** Per-mint offers_received TTL cache (provider+mint keys). */
  private readonly offersCache: TtlCache<MeMintOfferSlot>;
  /** Diagnostics from last pull (mints attempted, endpoints hit, budget). */
  lastPullMeta: MeBidsPullMeta | null = null;
  /** Mints sampled on last pull. */
  lastMints: string[] = [];

  constructor(opts: MagicEdenBidsOptions = {}) {
    this.opts = opts;
    this.offersCache = new TtlCache<MeMintOfferSlot>(
      opts.ttlMs ?? DEFAULT_TTL_MS,
    );
  }

  /** Allow callers to inject mints after a listings pull (e.g. OrderbookFeed native). */
  setMints(mints: string[]): void {
    this.opts.mints = [...mints];
  }

  /** Clear process-local offers_received TTL cache. */
  clearOffersCache(): void {
    this.offersCache.clear();
  }

  async pull(query: BidsPullQuery = {}): Promise<BidOrder[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const base = this.opts.baseUrl ?? DEFAULT_BASE;
    const ua = this.opts.userAgent ?? "traded-listings/0.3 (+magiceden)";
    const sampleCap = Math.max(
      1,
      query.limit ?? this.opts.sampleMints ?? DEFAULT_SAMPLE_MINTS,
    );
    const maxConcurrent = Math.max(
      1,
      this.opts.maxConcurrent ??
        this.opts.concurrency ??
        DEFAULT_MAX_CONCURRENT,
    );
    const ttlMs = this.opts.ttlMs ?? DEFAULT_TTL_MS;
    const solFallback = this.opts.solPriceUsd ?? DEFAULT_SOL_USD;

    // Optional offers: caller can disable with fetchOffers: false
    if (this.opts.fetchOffers === false) {
      this.lastMints = [];
      this.lastPullMeta = emptyMePullMeta({
        solPriceUsd: solFallback,
        maxConcurrent,
        ttlMs,
      });
      return [];
    }

    let mints = this.opts.mints?.length ? [...this.opts.mints] : [];
    let mintsFromListings = 0;

    // After ME listings pull: derive top mints when none supplied
    if (mints.length === 0 && !query.offline) {
      const listings =
        this.opts.listingsProvider ??
        new MagicEdenProvider({
          baseUrl: this.opts.baseUrl,
          symbol: this.opts.symbol ?? DEFAULT_SYMBOL,
          userAgent: this.opts.userAgent,
          fetchImpl: this.opts.fetchImpl,
          solPriceUsd: this.opts.solPriceUsd,
          offlineSolPrice: this.opts.offlineSolPrice,
          softEmptyOnError: this.opts.softEmptyOnError,
        });
      try {
        const page = await listings.pull({
          limit: Math.max(sampleCap, 20),
          fixturePath: query.fixturePath,
          tcg: query.tcg,
        });
        mints = page.listings
          .map((l) => l.tokenId)
          .filter((x): x is string => !!x);
        if ("lastMints" in listings && Array.isArray(listings.lastMints)) {
          mints = listings.lastMints.length ? [...listings.lastMints] : mints;
        }
        mintsFromListings = mints.length;
      } catch {
        // Soft empty: no mints → no offers (never throw)
        mints = [];
        mintsFromListings = 0;
      }
    }

    // Dedupe preserve order (top of listings first)
    const seen = new Set<string>();
    mints = mints.filter((m) => {
      if (!m || seen.has(m)) return false;
      seen.add(m);
      return true;
    });

    if (mints.length === 0) {
      this.lastMints = [];
      this.lastPullMeta = emptyMePullMeta({
        mintsFromListings,
        solPriceUsd: solFallback,
        maxConcurrent,
        ttlMs,
      });
      return [];
    }

    const solPriceUsd = await resolveSolUsd(this.opts, fetchImpl);

    // sample cap → TTL cache (offers_received per mint) → concurrency
    const budget = await mapWithBidBudget(mints, {
      provider: this.id,
      assetOf: (mint) => mint,
      maxSample: sampleCap,
      maxConcurrent,
      ttlMs,
      cache: this.offersCache,
      now: this.opts.now,
      fetch: (mint) =>
        this.fetchOffersForMint(mint, base, ua, fetchImpl, solPriceUsd),
    });

    this.lastMints = mints.slice(0, budget.sampleUsed);
    const bids: BidOrder[] = [];
    const attempts: MeBidsPullMeta["attempts"] = [];
    let offersRaw = 0;

    for (const part of budget.results) {
      attempts.push(part.attempt);
      offersRaw += part.attempt.offerCount;
      for (const b of part.bids) {
        if (query.instrumentKey && b.instrumentKey !== query.instrumentKey) {
          continue;
        }
        if (
          query.priceMin != null &&
          Number.isFinite(query.priceMin) &&
          b.price < query.priceMin
        ) {
          continue;
        }
        if (
          query.priceMax != null &&
          Number.isFinite(query.priceMax) &&
          b.price > query.priceMax
        ) {
          continue;
        }
        bids.push(b);
      }
    }

    this.lastPullMeta = {
      mintsAttempted: budget.sampleUsed,
      mintsFromListings,
      offersRaw,
      bidsNormalized: bids.length,
      attempts,
      solPriceUsd,
      fetchedAt: new Date().toISOString(),
      bidsHttpCalls: budget.httpCalls,
      cacheHits: budget.cacheHits,
      sampleUsed: budget.sampleUsed,
      maxConcurrent: budget.maxConcurrent,
      ttlMs: budget.ttlMs,
    };
    return bids;
  }

  private async fetchOffersForMint(
    mint: string,
    base: string,
    ua: string,
    fetchImpl: typeof fetch,
    solPriceUsd: number,
  ): Promise<MeMintOfferSlot> {
    // Prefer offers_received (public 200); /offers often 400 on mainnet v2
    const paths = [
      `/v2/tokens/${encodeURIComponent(mint)}/offers_received`,
      `/v2/tokens/${encodeURIComponent(mint)}/offers`,
    ];
    let offers: MeOffer[] = [];
    let endpoint: string | null = null;
    let httpStatus: number | null = null;
    try {
      for (const path of paths) {
        const res = await fetchWithRetry(
          `${base}${path}`,
          {
            headers: { Accept: "application/json", "User-Agent": ua },
          },
          {
            fetchImpl,
            maxRetries: this.opts.maxRetries ?? 3,
            baseDelayMs: this.opts.retryDelayMs ?? 500,
          },
        );
        httpStatus = res.status;
        if (!res.ok) continue;
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          continue;
        }
        if (Array.isArray(body)) {
          offers = body as MeOffer[];
          endpoint = path;
          break;
        }
        if (body && typeof body === "object") {
          const wrapped =
            (body as { results?: MeOffer[]; offers?: MeOffer[] }).results ??
            (body as { offers?: MeOffer[] }).offers;
          if (Array.isArray(wrapped)) {
            offers = wrapped;
            endpoint = path;
            break;
          }
        }
      }
      const out: BidOrder[] = [];
      for (const o of offers) {
        const b = normalizeMeOffer(o, mint, solPriceUsd, this.id);
        if (b) out.push(b);
      }
      return {
        bids: out,
        attempt: {
          mint,
          endpoint,
          httpStatus,
          offerCount: offers.length,
        },
      };
    } catch {
      return {
        bids: [],
        attempt: {
          mint,
          endpoint: null,
          httpStatus,
          offerCount: 0,
        },
      };
    }
  }
}

export function createMagicEdenProvider(opts?: MagicEdenOptions): MagicEdenProvider {
  return new MagicEdenProvider(opts);
}

export function createMagicEdenBidsProvider(
  opts?: MagicEdenBidsOptions,
): MagicEdenBidsProvider {
  return new MagicEdenBidsProvider(opts);
}
