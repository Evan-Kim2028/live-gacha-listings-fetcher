/**
 * Courtyard marketplace provider — listings via Algolia; bids via per-asset orderbook REST.
 *
 * Endpoint MAP (probe 2026-08-01, browser-like UA + Origin/Referer):
 * | Path | Status | Use |
 * |------|--------|-----|
 * | POST y8tl3m06qa-dsn.algolia.net/1/indexes/*\/queries | ✅ 200 public | **Listings** (CourtyardProvider) |
 * | GET api.courtyard.io/orderbook/config | ✅ 200 | On-chain orderbook addresses |
 * | GET api.courtyard.io/orderbook/assets/{proofOfIntegrity} | ✅ 200 | **Bids + asks** for one asset |
 * | GET api.courtyard.io/index/asset/{id} | ✅ 200 | Asset index enrichment |
 * | GET api.courtyard.io/configs/providers/config.json | ✅ 200 | RPC / chain config |
 * | GET api.courtyard.io/orderbook/bids\|offers | ❌ 404 | No bulk bid browse |
 * | Most other api.courtyard.io/* | ❌ 403 WAF without UA | — |
 *
 * On-chain (Polygon, from /orderbook/config):
 * - orderbookAddress: 0x5E4943373c2198625BD441Ae0629E9E7b4FB4797
 * - coinflowOrderbookAddress: 0x7fbF08A0eD3EF12565A61935Ca6339BbeCC25F48
 * - NFT contract (graded): 0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD
 * - USDC: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
 *
 * Algolia: app Y8TL3M06QA, public search key, index marketplace_prod_recently_listed.
 * No Algolia bid/offer index (indices are ownership/listed/sold/deals only).
 * Offline: fixturePath → listings or single-asset orderbook fixture.
 */
import { readFile } from "node:fs/promises";
import { courtyardListingUrl, originProvidedUrl } from "../externalUrl.js";
import { deltaFromListing } from "../fmv/delta.js";
import { listingId } from "../identity.js";
import { fetchWithRetry } from "../http/fetchWithRetry.js";
import { emptyPage, walkSequentialPages } from "./pageWalk.js";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TTL_MS,
  TtlCache,
  mapWithBidBudget,
  resolveBidBudgetOptions,
  type BidBudgetOptions,
} from "../orderbook/bidBudget.js";
import type { BidOrder } from "../orderbook/types.js";
import type { BidsProvider, BidsPullQuery } from "../orderbook/BidsProvider.js";
import type { Listing } from "../types.js";
import type { ListingsProvider, PullPage, PullQuery } from "./types.js";

const ALGOLIA_APP = "Y8TL3M06QA";
const ALGOLIA_KEY = "3b3ed18284ca0baee9a496aea5f093d6";
const ALGOLIA_HOST = "https://y8tl3m06qa-dsn.algolia.net";
const DEFAULT_INDEX = "marketplace_prod_recently_listed";
const DEFAULT_API_BASE = "https://api.courtyard.io";
/** Browser-like UA — bare curl without UA often 403 WAF on orderbook routes. */
const DEFAULT_BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** Default walk page cap for pullAll (Algolia deep cap ≈ 3.1k hits / 32 pages of 100). */
const COURTYARD_MAX_PAGES_DEFAULT = 50;
/** Hard ceiling for a Courtyard page walk. */
const COURTYARD_MAX_PAGES_CAP = 500;
/** Default page size for full-book walks. */
const COURTYARD_PAGE_SIZE = 100;

/** Known on-chain addresses (Polygon). Prefer live /orderbook/config when available. */
export const COURTYARD_ONCHAIN = {
  chain: "polygon",
  chainId: 137,
  orderbookAddress: "0x5E4943373c2198625BD441Ae0629E9E7b4FB4797",
  coinflowOrderbookAddress: "0x7fbF08A0eD3EF12565A61935Ca6339BbeCC25F48",
  gradedNftContract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
  usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
} as const;

export interface CourtyardOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Override Algolia index */
  indexName?: string;
  algoliaAppId?: string;
  algoliaApiKey?: string;
  cookie?: string;
  /** REST API base (orderbook). Default https://api.courtyard.io */
  apiBaseUrl?: string;
  /** Max retries on 429 / 5xx (default 3). */
  maxRetries?: number;
  /** Base delay ms for exponential backoff (default 500). */
  retryDelayMs?: number;
}

export interface CyAlgoliaHit {
  objectID?: string;
  proofOfIntegrity?: string;
  title?: string;
  imageUrl?: string;
  listedAt?: string;
  price?: { currency?: string; amountUsd?: number; amountNative?: number };
  certification?: { agency?: string; grade?: string; number?: string };
  metadata?: Record<string, string>;
  estimatedValueUsd?: number;
  ownerAddress?: string;
  year?: number;
  set?: string;
  assetNumber?: string;
  tags?: string[];
  latestListing?: {
    orderId?: string;
    maker?: string;
    price?: {
      amount?: { decimal?: number; usd?: number };
      currency?: { symbol?: string };
    };
  };
  [key: string]: unknown;
}

function mapTcg(meta?: Record<string, string>, tags?: string[]): string | null {
  const cat = (meta?.Category ?? tags?.[0] ?? "").toLowerCase();
  if (cat.includes("pok") || cat.includes("pokemon")) return "pokemon";
  if (cat.includes("one piece")) return "one_piece";
  return cat || null;
}

function parseGradeNum(grade?: string): number | null {
  if (!grade) return null;
  const m = grade.match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}

/** Normalize Algolia marketplace hit → shared Listing. */
export function normalizeCourtyardAlgoliaHit(
  hit: CyAlgoliaHit,
  providerId = "courtyard",
): Listing | null {
  const tokenId = hit.proofOfIntegrity ?? hit.objectID ?? "";
  if (!tokenId) return null;
  const price =
    hit.price?.amountUsd ??
    hit.latestListing?.price?.amount?.usd ??
    hit.latestListing?.price?.amount?.decimal ??
    hit.price?.amountNative;
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const meta = hit.metadata ?? {};
  const grader = hit.certification?.agency ?? meta.Grader ?? null;
  const grade = hit.certification?.grade ?? meta.Grade ?? null;
  const fmv =
    hit.estimatedValueUsd == null ? null : Number(hit.estimatedValueUsd);
  const name = hit.title ?? meta["Title/Subject"] ?? tokenId;
  const currency = hit.price?.currency ?? "USDC";
  return {
    id: listingId({
      provider: providerId,
      platform: "courtyard",
      nativeId: tokenId,
    }),
    provider: providerId,
    platform: "courtyard",
    nativeId: tokenId,
    tokenId,
    name,
    price: p,
    currency,
    fmv: fmv != null && Number.isFinite(fmv) ? fmv : null,
    delta: deltaFromListing(p, fmv, currency),
    market: "Courtyard (Polygon)",
    seller: hit.ownerAddress ?? hit.latestListing?.maker ?? meta.OwnerAddress ?? null,
    // Prefer origin http(s) URL when present; else stable courtyard.io asset page.
    externalUrl: originProvidedUrl(hit) ?? courtyardListingUrl(tokenId),
    imageUrl: hit.imageUrl ?? null,
    listedAt: hit.listedAt ?? null,
    firstListedAt: hit.listedAt ?? null,
    lastEvent: "LIST",
    tcg: mapTcg(meta, hit.tags),
    itemType: "card",
    grader,
    grade,
    gradeNum: parseGradeNum(grade ?? undefined),
    language: meta.Language ?? null,
    setRaw: hit.set ?? meta.Set ?? null,
    cardNumber: hit.assetNumber ?? meta["Card Number"] ?? null,
    year: hit.year ?? (meta.Year ? Number(meta.Year) : null),
    confidence: null,
    canonical: meta["Title/Subject"]
      ? { name: meta["Title/Subject"], number: meta["Card Number"] }
      : null,
    contractAddress: null,
    searchBlob: hit.metadataSearch as string ?? name,
    raw: hit,
  };
}

/** @deprecated alias for tests / fixtures */
export function normalizeCourtyardRow(
  row: Record<string, unknown>,
  providerId = "courtyard",
): Listing | null {
  // Support both Algolia hits and simple fixture shapes
  if (row.proofOfIntegrity || row.objectID || row.latestListing) {
    return normalizeCourtyardAlgoliaHit(row as CyAlgoliaHit, providerId);
  }
  const tokenId = String(row.token_id ?? row.tokenId ?? row.id ?? "");
  if (!tokenId) return null;
  const price = Number(row.price ?? row.listPrice ?? 0);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    id: listingId({ provider: providerId, platform: "courtyard", nativeId: tokenId }),
    provider: providerId,
    platform: "courtyard",
    nativeId: tokenId,
    tokenId,
    name: String(row.name ?? row.title ?? tokenId),
    price,
    currency: String(row.currency ?? "USDC"),
    fmv: row.fmv == null ? null : Number(row.fmv),
    delta: null,
    market: "Courtyard (Polygon)",
    seller: (row.seller as string) ?? null,
    // Prefer origin http(s) URL when present; else stable courtyard.io asset page.
    externalUrl: originProvidedUrl(row) ?? courtyardListingUrl(tokenId),
    imageUrl: (row.image_url as string) ?? (row.imageUrl as string) ?? null,
    listedAt: (row.listed_at as string) ?? (row.listedAt as string) ?? null,
    firstListedAt: null,
    lastEvent: "LIST",
    tcg: (row.tcg as string) ?? null,
    itemType: "card",
    grader: (row.grader as string) ?? null,
    grade: (row.grade as string) ?? null,
    gradeNum: row.grade_num == null ? null : Number(row.grade_num),
    language: null,
    setRaw: null,
    cardNumber: null,
    year: null,
    confidence: null,
    canonical: null,
    contractAddress: null,
    searchBlob: String(row.name ?? ""),
    raw: row,
  };
}

export class CourtyardProvider implements ListingsProvider {
  readonly id = "courtyard";
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly indexName: string;
  private readonly appId: string;
  private readonly apiKey: string;
  private readonly cookie: string | undefined;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  lastError: string | null = null;

  constructor(opts: CourtyardOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "traded-listings/0.3 (+courtyard-algolia)";
    this.indexName = opts.indexName ?? DEFAULT_INDEX;
    this.appId = opts.algoliaAppId ?? ALGOLIA_APP;
    this.apiKey = opts.algoliaApiKey ?? ALGOLIA_KEY;
    this.cookie = opts.cookie;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
  }

  /**
   * Full-book walk: page through Algolia until the end of the retrievable
   * universe (or `maxPages` / `limit`). Algolia stops returning hits past its
   * deep-pagination cap (~1k records), so the walk ends naturally with an
   * empty page. Soft-fail mid-walk keeps rows already collected; a soft
   * empty (lastError set, zero rows) never prunes the prior scope.
   */
  async pullAll(
    query: PullQuery & { maxPages?: number } = {},
  ): Promise<PullPage> {
    if (query.fixturePath || query.offline) return this.pull(query);
    const maxPages = Math.max(
      1,
      Math.min(
        query.maxPages ?? COURTYARD_MAX_PAGES_DEFAULT,
        COURTYARD_MAX_PAGES_CAP,
      ),
    );
    const pageSize = Math.min(query.limit ?? COURTYARD_PAGE_SIZE, 100);
    const clientLimit = query.limit;
    const walk = await walkSequentialPages(
      async (offset) => {
        const one = await this.pull({ ...query, offset, limit: pageSize });
        return {
          listings: one.listings,
          hasMore: one.hasMore,
          total: one.meta.total ?? null,
        };
      },
      {
        maxPages,
        pageSize,
        firstPage: 0,
        limit: clientLimit,
      },
    );

    // Ambiguous empty first page (200 + 0 hits): a transient Algolia hiccup
    // must NOT look like a completed empty book — sync would
    // replaceScopeSnapshot and wipe the prior scope. Mark soft.
    if (walk.firstPageEmpty) {
      this.lastError = `courtyard empty page 0 (0 hits)${walk.partialError ? `: ${walk.partialError}` : ""} — treated as soft-fail`;
      return emptyPage(this.id, { softFail: true });
    }
    if (walk.partialError) {
      this.lastError = `courtyard partial multi-page after ${walk.listings.length} rows: ${walk.partialError}`;
    } else {
      this.lastError = null;
    }
    const listings =
      clientLimit != null ? walk.listings.slice(0, clientLimit) : walk.listings;
    return {
      listings,
      hasMore:
        walk.hasMore &&
        (clientLimit == null || walk.listings.length < (walk.total ?? Infinity)),
      meta: {
        provider: this.id,
        builtAt: new Date().toISOString(),
        // At the Algolia deep-pagination cap nbHits is inflated beyond what
        // is retrievable — report the walked rows as the honest book size.
        total: walk.stoppedAtCap ? walk.listings.length : (walk.total ?? listings.length),
        universe: walk.stoppedAtCap ? walk.listings.length : (walk.total ?? listings.length),
        fetchedAt: new Date().toISOString(),
        querySignature: "",
      },
    };
  }

  /**
   * Point lookup via GET /orderbook/assets/{proofOfIntegrity} (browser-like
   * UA + Origin/Referer; bare curl 403 WAF). Returns null when the token is
   * unknown or has no active ask. Price = active ask UsdcAmount (micro-USDC).
   */
  async getByTokenId(tokenId: string): Promise<Listing | null> {
    const res = await fetchWithRetry(
      `${DEFAULT_API_BASE}/orderbook/assets/${encodeURIComponent(tokenId)}`,
      { headers: courtyardHeaders(this.userAgent, this.cookie) },
      {
        fetchImpl: this.fetchImpl,
        maxRetries: this.maxRetries,
        baseDelayMs: this.retryDelayMs,
      },
    );
    if (!res.ok) {
      this.lastError = `courtyard getByTokenId HTTP ${res.status}`;
      return null;
    }
    const body = (await res.json()) as { asset?: CyAssetOrderbook };
    const a = body?.asset;
    if (!a) return null;
    const ask = (a.orderbook_asks?.[0] as
      | { Ask?: { UsdcAmount?: number }; listed_at?: string }
      | undefined);
    const usdc = ask?.Ask?.UsdcAmount;
    if (usdc == null || !Number.isFinite(usdc) || usdc <= 0) return null;
    const price = usdc / 1_000_000; // micro-USDC
    const meta = new Map(
      (a.attributes ?? [])
        .filter((x) => x?.name && x?.value)
        .map((x) => [String(x.name).toLowerCase(), String(x.value)]),
    );
    const name = a.title ?? meta.get("title/subject") ?? tokenId;
    const listedAt = ask?.listed_at ?? null;
    const grade = meta.get("grade") ?? null;
    const gradeMatch = grade?.match(/([\d.]+)/);
    return {
      id: listingId({
        provider: this.id,
        platform: "courtyard",
        nativeId: a.proof_of_integrity ?? tokenId,
      }),
      provider: this.id,
      platform: "courtyard",
      nativeId: a.proof_of_integrity ?? tokenId,
      tokenId: a.proof_of_integrity ?? tokenId,
      name,
      price,
      currency: "USDC",
      fmv:
        a.fmv_estimate_usd != null && Number.isFinite(a.fmv_estimate_usd)
          ? a.fmv_estimate_usd
          : null,
      delta: deltaFromListing(price, a.fmv_estimate_usd ?? null, "USDC"),
      market: "Courtyard (Polygon)",
      seller: null,
      externalUrl: courtyardListingUrl(a.proof_of_integrity ?? tokenId),
      imageUrl: (a.image as string | undefined) ?? null,
      listedAt,
      firstListedAt: listedAt,
      lastEvent: "LIST",
      tcg: "pokemon",
      itemType: "card",
      grader: meta.get("grader") ?? null,
      grade,
      gradeNum: gradeMatch ? Number(gradeMatch[1]) : null,
      language: meta.get("language") ?? null,
      setRaw: meta.get("set") ?? null,
      cardNumber: meta.get("card number") ?? null,
      year: meta.get("year") ? Number(meta.get("year")) : null,
      confidence: null,
      canonical: null,
      contractAddress: a.contract ?? null,
      searchBlob: name,
      raw: a,
    };
  }

  async pull(query: PullQuery = {}): Promise<PullPage> {
    this.lastError = null;
    if (query.fixturePath) {
      const text = await readFile(query.fixturePath, "utf8");
      const body = JSON.parse(text) as { listings?: unknown[]; hits?: unknown[] };
      const rows = (body.listings ?? body.hits ?? (Array.isArray(body) ? body : [])) as Record<
        string,
        unknown
      >[];
      const listings = rows
        .map((r) => normalizeCourtyardRow(r, this.id))
        .filter((x): x is Listing => x != null)
        .slice(0, query.limit ?? 100);
      return pageResult(this.id, listings, listings.length);
    }
    if (query.offline) {
      throw new Error("CourtyardProvider: offline without fixturePath");
    }

    const hitsPerPage = Math.min(query.limit ?? 48, 100);
    const page =
      query.offset != null && hitsPerPage > 0
        ? Math.floor(query.offset / hitsPerPage)
        : 0;

    const facetFilters: string[][] = [];
    // Category facet: Pokémon listings
    if (query.tcg === "pokemon") {
      facetFilters.push(["metadata.Category:Pokémon", "metadata.Category:Pokemon", "tags:Pokémon"]);
    } else if (query.tcg === "one_piece") {
      facetFilters.push(["metadata.Category:One Piece", "tags:One Piece"]);
    }
    if (query.grader) {
      facetFilters.push([`metadata.Grader:${query.grader}`, `certification.agency:${query.grader}`]);
    }

    const request: Record<string, unknown> = {
      indexName: this.indexName,
      hitsPerPage,
      page,
      query: query.q ?? "",
    };
    if (facetFilters.length) {
      // Algolia facetFilters: OR within group is multi-value; AND across groups
      // Use single preferred filter for category
      if (query.tcg === "pokemon") {
        request.facetFilters = [["metadata.Category:Pokémon"]];
      } else if (query.tcg) {
        request.facetFilters = facetFilters;
      }
    }
    if (query.priceMin != null || query.priceMax != null) {
      const min = query.priceMin ?? 0;
      const max = query.priceMax ?? 1e12;
      request.numericFilters = [`price.amountUsd:${min} TO ${max}`];
    }

    const url = `${ALGOLIA_HOST}/1/indexes/*/queries?x-algolia-agent=traded-listings&x-algolia-api-key=${encodeURIComponent(this.apiKey)}&x-algolia-application-id=${encodeURIComponent(this.appId)}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
      Referer: "https://courtyard.io/",
      Origin: "https://courtyard.io",
    };
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ requests: [request] }),
      },
      {
        fetchImpl: this.fetchImpl,
        maxRetries: this.maxRetries,
        baseDelayMs: this.retryDelayMs,
      },
    );
    if (!res.ok) {
      this.lastError = `Algolia HTTP ${res.status}`;
      // 403/401: surface status so callers/tests can fall back to fixturePath
      throw new Error(this.lastError);
    }
    const data = (await res.json()) as {
      results?: Array<{ hits?: CyAlgoliaHit[]; nbHits?: number; nbPages?: number; page?: number }>;
    };
    const result = data.results?.[0];
    const hits = result?.hits ?? [];
    let listings = hits
      .map((h) => normalizeCourtyardAlgoliaHit(h, this.id))
      .filter((x): x is Listing => x != null);

    // Client fallback filter if facet failed
    if (query.tcg) {
      listings = listings.filter(
        (l) => !l.tcg || l.tcg === query.tcg || (query.tcg === "pokemon" && l.tcg.includes("pok")),
      );
    }

    const nbHits = result?.nbHits ?? listings.length;
    const nbPages = result?.nbPages ?? 1;
    const curPage = result?.page ?? page;
    return {
      listings,
      hasMore: curPage + 1 < nbPages,
      meta: {
        provider: this.id,
        builtAt: new Date().toISOString(),
        total: nbHits,
        universe: nbHits,
        fetchedAt: new Date().toISOString(),
        querySignature: "",
      },
    };
  }
}

function pageResult(
  provider: string,
  listings: Listing[],
  total: number,
): PullPage {
  return {
    listings,
    hasMore: false,
    meta: {
      provider,
      builtAt: new Date().toISOString(),
      total,
      universe: total,
      fetchedAt: new Date().toISOString(),
      querySignature: "",
    },
  };
}

export function createCourtyardProvider(opts?: CourtyardOptions): CourtyardProvider {
  return new CourtyardProvider(opts);
}

// ─── Orderbook config + per-asset bids ───────────────────────────────────────

export interface CourtyardOrderbookConfig {
  orderbookAddress: string;
  coinflowOrderbookAddress: string;
  raw?: unknown;
}

export interface CyOfferData {
  orderId?: string;
  side?: string;
  kind?: string;
  maker?: string;
  createdAt?: string;
  expiration?: string;
  price?: {
    currency?: { symbol?: string; decimals?: number; contract?: string };
    amount?: { raw?: string; decimal?: number; usd?: number; native?: number };
  };
  [key: string]: unknown;
}

export interface CyOrderbookBidRow {
  id?: string;
  status?: string;
  asset_id?: string;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
  expiration_date?: string;
  usdc_contract?: string;
  Bid?: {
    Permit?: {
      From?: string;
      To?: string;
      Value?: number | string;
    };
    FeeBps?: number;
    TokenId?: number | string;
  };
  [key: string]: unknown;
}

export interface CyAssetOrderbook {
  proof_of_integrity?: string;
  title?: string;
  contract?: string;
  token_id?: string;
  minimum_bid_threshold?: number;
  fmv_estimate_usd?: number;
  attributes?: Array<{ name?: string; value?: string }>;
  offer_data?: CyOfferData[];
  orderbook_bids?: CyOrderbookBidRow[];
  listing_data?: unknown[];
  orderbook_asks?: unknown[];
  [key: string]: unknown;
}

/** Diagnostics from last Courtyard bids pull (budget + cache). */
export interface CyBidsBudgetMeta {
  bidsHttpCalls: number;
  cacheHits: number;
  sampleUsed: number;
  sampleSize: number;
  maxConcurrent: number;
  ttlMs: number;
  provider: string;
}

export interface CourtyardBidsOptions extends CourtyardOptions, BidBudgetOptions {
  /** Explicit asset ids (proofOfIntegrity / objectID hex). */
  assetIds?: string[];
  /**
   * When set and assetIds empty, pull listings first and use those tokenIds.
   * Default: create a CourtyardProvider from the same opts.
   */
  listingsProvider?: CourtyardProvider;
  /**
   * Max concurrent per-asset orderbook fetches (default 4).
   * Alias for {@link BidBudgetOptions.maxConcurrent}.
   */
  concurrency?: number;
}

function courtyardHeaders(
  userAgent: string,
  cookie?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": userAgent,
    Origin: "https://courtyard.io",
    Referer: "https://courtyard.io/",
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/** Live GET /orderbook/config → on-chain addresses. */
export async function fetchCourtyardOrderbookConfig(
  opts: CourtyardOptions = {},
): Promise<CourtyardOrderbookConfig> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiBaseUrl ?? DEFAULT_API_BASE;
  const ua = opts.userAgent ?? DEFAULT_BROWSER_UA;
  const res = await fetchWithRetry(
    `${base}/orderbook/config`,
    {
      headers: courtyardHeaders(ua, opts.cookie),
    },
    {
      fetchImpl,
      maxRetries: opts.maxRetries ?? 3,
      baseDelayMs: opts.retryDelayMs ?? 500,
    },
  );
  if (!res.ok) {
    throw new Error(`Courtyard orderbook/config HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    config?: {
      orderbookAddress?: string;
      coinflowOrderbookAddress?: string;
    };
  };
  const c = body.config ?? {};
  return {
    orderbookAddress:
      c.orderbookAddress ?? COURTYARD_ONCHAIN.orderbookAddress,
    coinflowOrderbookAddress:
      c.coinflowOrderbookAddress ?? COURTYARD_ONCHAIN.coinflowOrderbookAddress,
    raw: body,
  };
}

export function instrumentKeyFromCyAsset(
  assetId: string,
  asset?: CyAssetOrderbook | null,
): string {
  const attrs = asset?.attributes ?? [];
  const get = (n: string) =>
    attrs.find((a) => (a.name ?? "").toLowerCase() === n.toLowerCase())?.value;
  const grader = (get("Grader") ?? "raw").toLowerCase();
  const gradeRaw = get("Grade") ?? "raw";
  const gradeMatch = String(gradeRaw).match(/([\d.]+)/);
  const grade = gradeMatch ? gradeMatch[1] : gradeRaw.toLowerCase();
  return `cy:asset:${assetId}|${grader}|${grade}`;
}

function usdcFromRaw(
  raw: string | number | undefined,
  decimals = 6,
): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Heuristic: values >= 1e5 are micro-USDC (6dp); small integers are already decimal
  if (n >= 1e5) return n / 10 ** decimals;
  return n;
}

/** Prefer offer_data (side=buy); fall back to orderbook_bids. Dedup by order id. */
export function normalizeCourtyardAssetBids(
  asset: CyAssetOrderbook,
  providerId = "courtyard_bids",
): BidOrder[] {
  const assetId = String(
    asset.proof_of_integrity ??
      (typeof asset.objectID === "string" ? asset.objectID : "") ??
      "",
  );
  if (!assetId) return [];
  const instrument = instrumentKeyFromCyAsset(assetId, asset);
  const out: BidOrder[] = [];
  const seen = new Set<string>();

  for (const o of asset.offer_data ?? []) {
    if (o.side && o.side !== "buy") continue;
    const price =
      o.price?.amount?.usd ??
      o.price?.amount?.decimal ??
      o.price?.amount?.native ??
      usdcFromRaw(o.price?.amount?.raw, o.price?.currency?.decimals ?? 6);
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) continue;
    const nativeId = String(o.orderId ?? `${assetId}:${o.maker ?? "unknown"}`);
    if (seen.has(nativeId)) continue;
    seen.add(nativeId);
    out.push({
      id: listingId({
        provider: providerId,
        platform: "courtyard",
        nativeId: `bid:${nativeId}`,
      }),
      provider: providerId,
      instrumentKey: instrument,
      nativeId,
      side: "bid",
      price: p,
      size: 1,
      currency: o.price?.currency?.symbol ?? "USDC",
      bidder: o.maker ?? null,
      platform: "courtyard",
      updatedAt: o.createdAt ?? new Date().toISOString(),
      raw: o,
    });
  }

  for (const b of asset.orderbook_bids ?? []) {
    if (b.status && b.status !== "active") continue;
    const nativeId = String(b.id ?? "");
    if (!nativeId || seen.has(nativeId)) continue;
    const value = b.Bid?.Permit?.Value;
    const p = usdcFromRaw(value, 6);
    if (p == null || p <= 0) continue;
    seen.add(nativeId);
    out.push({
      id: listingId({
        provider: providerId,
        platform: "courtyard",
        nativeId: `bid:${nativeId}`,
      }),
      provider: providerId,
      instrumentKey: instrument,
      nativeId,
      side: "bid",
      price: p,
      size: 1,
      currency: "USDC",
      bidder: b.Bid?.Permit?.From ?? null,
      platform: "courtyard",
      updatedAt: b.updated_at ?? b.created_at ?? new Date().toISOString(),
      raw: b,
    });
  }

  return out;
}

/**
 * Per-asset bids via GET /orderbook/assets/{proofOfIntegrity}.
 * No bulk bid index — harvest asset ids from Algolia listings (or explicit assetIds).
 *
 * Budget (see docs/BIDS_BUDGET.md): maxSample + maxConcurrent + ttlMs cache
 * on `/orderbook/assets/{id}` so repeated polls skip origin detail hops.
 */
export class CourtyardBidsProvider implements BidsProvider {
  readonly id = "courtyard_bids";
  private readonly opts: CourtyardBidsOptions;
  /** Process-local TTL cache for GET /orderbook/assets/{id}. */
  private readonly assetCache: TtlCache<CyAssetOrderbook | null>;
  lastAssets: CyAssetOrderbook[] = [];
  lastError: string | null = null;
  /** Budget / cache diagnostics from last live pull. */
  lastBudgetMeta: CyBidsBudgetMeta | null = null;

  constructor(opts: CourtyardBidsOptions = {}) {
    this.opts = opts;
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.assetCache = new TtlCache<CyAssetOrderbook | null>(ttlMs);
  }

  setAssetIds(ids: string[]): void {
    this.opts.assetIds = [...ids];
  }

  /** Clear the per-asset orderbook cache (tests / forced refresh). */
  clearAssetCache(): void {
    this.assetCache.clear();
  }

  async pull(query: BidsPullQuery = {}): Promise<BidOrder[]> {
    this.lastError = null;
    this.lastAssets = [];
    this.lastBudgetMeta = null;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const base = this.opts.apiBaseUrl ?? DEFAULT_API_BASE;
    const ua = this.opts.userAgent ?? DEFAULT_BROWSER_UA;
    const sampleSize =
      this.opts.maxSample ?? query.limit ?? 20;

    if (query.fixturePath) {
      const text = await readFile(query.fixturePath, "utf8");
      const body = JSON.parse(text) as {
        asset?: CyAssetOrderbook;
        assets?: CyAssetOrderbook[];
      };
      const assets = body.assets ?? (body.asset ? [body.asset] : []);
      this.lastAssets = assets;
      const bids: BidOrder[] = [];
      for (const a of assets) {
        for (const b of normalizeCourtyardAssetBids(a, this.id)) {
          if (query.instrumentKey && b.instrumentKey !== query.instrumentKey) {
            continue;
          }
          bids.push(b);
        }
      }
      return bids;
    }
    if (query.offline) return [];

    let assetIds = this.opts.assetIds?.length ? [...this.opts.assetIds] : [];
    if (assetIds.length === 0) {
      const listings =
        this.opts.listingsProvider ??
        new CourtyardProvider({
          fetchImpl: this.opts.fetchImpl,
          userAgent: this.opts.userAgent,
          indexName: this.opts.indexName,
          algoliaAppId: this.opts.algoliaAppId,
          algoliaApiKey: this.opts.algoliaApiKey,
          cookie: this.opts.cookie,
          apiBaseUrl: this.opts.apiBaseUrl,
        });
      try {
        const page = await listings.pull({
          limit: sampleSize,
          tcg: query.tcg,
          grader: query.grader,
          priceMin: query.priceMin,
          priceMax: query.priceMax,
        });
        assetIds = page.listings
          .map((l) => l.tokenId ?? l.nativeId)
          .filter((x): x is string => !!x);
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        assetIds = [];
      }
    }

    // Dedupe preserve order
    const seenIds = new Set<string>();
    assetIds = assetIds.filter((id) => {
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    if (assetIds.length === 0) {
      this.lastBudgetMeta = {
        bidsHttpCalls: 0,
        cacheHits: 0,
        sampleUsed: 0,
        sampleSize,
        maxConcurrent: Math.max(
          1,
          this.opts.maxConcurrent ?? this.opts.concurrency ?? DEFAULT_MAX_CONCURRENT,
        ),
        ttlMs: this.assetCache.ttlMs,
        provider: this.id,
      };
      return [];
    }

    const budget = resolveBidBudgetOptions({
      maxConcurrent:
        this.opts.maxConcurrent ?? this.opts.concurrency ?? DEFAULT_MAX_CONCURRENT,
      ttlMs: this.opts.ttlMs ?? DEFAULT_TTL_MS,
      maxSample: sampleSize,
    });

    const run = await mapWithBidBudget(assetIds, {
      provider: this.id,
      assetOf: (id) => id,
      maxSample: budget.maxSample,
      maxConcurrent: budget.maxConcurrent,
      ttlMs: budget.ttlMs,
      cache: this.assetCache,
      fetch: (id) => this.fetchAsset(id, base, ua, fetchImpl),
    });

    this.lastBudgetMeta = {
      bidsHttpCalls: run.httpCalls,
      cacheHits: run.cacheHits,
      sampleUsed: run.sampleUsed,
      sampleSize,
      maxConcurrent: run.maxConcurrent,
      ttlMs: run.ttlMs,
      provider: this.id,
    };

    const bids: BidOrder[] = [];
    const seen = new Set<string>();
    for (const asset of run.results) {
      if (!asset) continue;
      this.lastAssets.push(asset);
      for (const b of normalizeCourtyardAssetBids(asset, this.id)) {
        if (query.instrumentKey && b.instrumentKey !== query.instrumentKey) {
          continue;
        }
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        bids.push(b);
      }
    }
    return bids;
  }

  private async fetchAsset(
    assetId: string,
    base: string,
    ua: string,
    fetchImpl: typeof fetch,
  ): Promise<CyAssetOrderbook | null> {
    try {
      const res = await fetchWithRetry(
        `${base}/orderbook/assets/${encodeURIComponent(assetId)}`,
        { headers: courtyardHeaders(ua, this.opts.cookie) },
        {
          fetchImpl,
          maxRetries: this.opts.maxRetries ?? 3,
          baseDelayMs: this.opts.retryDelayMs ?? 500,
        },
      );
      if (!res.ok) {
        this.lastError = `orderbook/assets HTTP ${res.status}`;
        return null;
      }
      const body = (await res.json()) as { asset?: CyAssetOrderbook };
      return body.asset ?? null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }
}

export function createCourtyardBidsProvider(
  opts?: CourtyardBidsOptions,
): CourtyardBidsProvider {
  return new CourtyardBidsProvider(opts);
}
