/**
 * Native Collector Crypt marketplace provider.
 * Docs: https://docs.collectorcrypt.com/marketplace/api
 * Base: https://api.collectorcrypt.com
 *
 * Listings: GET /marketplace (public, CDN cached ~30s)
 * Pagination: page (1-indexed) + step (max 100)
 *
 * Delist / leave-book (Solana radar):
 * - Every browse request sets `marketplaceStatus=Buy now` (currently listed only).
 * - There is no sold SSE or bulk sold endpoint on this path — do not invent one.
 * - Leave-book signal = id absent from a **complete** full-scope pullAll
 *   (bootstrap / warm multi-page until !hasMore) → store prune + prunedIds.
 * - Incomplete / soft-fail pages never prune (see docs/SOLD_TAKEDOWN.md).
 * - Card-level `status` (e.g. "Transferred") is catalog ownership, not listing sold.
 *
 * Offers (buy bids):
 * - Browse embeds `offers` often as `{ id }` only (docs + live).
 * - Priced detail: POST / JSON-RPC `{ method: "getCardOffers", params: { nftAddress, useV2: true } }`
 *   (same path the CC web app uses; not documented on marketplace/api).
 * - Listing.raw always gets `offerCount` + lake_listing (1:1 insured columns).
 * - BidOrder.raw gets lake_offer (1:1 priced-offer columns) after getCardOffers.
 */
import { contentFingerprint } from "../contentFingerprint.js";
import { ccListingUrl } from "../externalUrl.js";
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
import type { Listing } from "../types.js";
import type { ListingsProvider, PullPage, PullQuery } from "./types.js";
import type { BidsProvider, BidsPullQuery } from "../orderbook/BidsProvider.js";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TTL_MS,
  TtlCache,
  bidCacheKey,
  mapWithBidBudget,
} from "../orderbook/bidBudget.js";
import {
  attachLakeListingToRaw,
  attachLakeOfferToRaw,
  lakeListingFromCcCard,
  lakeOfferFromCcOffer,
} from "./ccLakeSchema.js";

const DEFAULT_BASE = "https://api.collectorcrypt.com";
const MAX_STEP = 100;
/**
 * Cold bootstrap page cap when maxPages omitted (step ≤ 100 → up to 50k rows).
 * Stop earlier on !hasMore. Explicit query.maxPages can go higher.
 */
const BOOTSTRAP_MAX_PAGES = 500;
/** Official GET /marketplace `blockchain` CSV values (docs + live 400 enum). */
export const CC_BLOCKCHAINS = [
  "Solana",
  "Base",
  "Monad",
  "ApeChain",
  "Ethereum",
  "XLayer",
  "Robinhood",
] as const;
export type CcBlockchain = (typeof CC_BLOCKCHAINS)[number];
/** Solana radar default — CC marketplace program is Solana-primary. */
const DEFAULT_BLOCKCHAIN: CcBlockchain = "Solana";

export interface CcListingBlock {
  createdAt?: string;
  updatedAt?: string;
  currency?: string;
  price?: string | number;
  receiptId?: string;
  sellerId?: string;
  marketplace?: string;
}

export interface CcOfferBuyer {
  id?: string;
  name?: string | null;
  wallet?: string;
  role?: string;
}

/** Browse often returns `{ id }` only; getCardOffers returns priced rows. */
export interface CcOfferRef {
  id?: string;
  price?: string | number;
  currency?: string;
  buyer?: string | CcOfferBuyer | null;
  buyerId?: string;
  buyerWallet?: string;
  wallet?: string;
  status?: string;
  source?: string;
  cardId?: string;
  createdAt?: string;
  updatedAt?: string;
  expiryDate?: number | string;
  receiptId?: string | null;
  [key: string]: unknown;
}

export interface CcCard {
  id: string;
  itemName?: string;
  nftAddress?: string;
  category?: string;
  type?: string;
  year?: number;
  grade?: string;
  gradeNum?: number;
  gradingCompany?: string;
  gradingID?: string;
  language?: string;
  listedAt?: string;
  /**
   * Catalog ownership state from browse docs (e.g. `"Transferred"`).
   * Not a listing sold flag — leave-book is absence under `marketplaceStatus=Buy now`.
   */
  status?: string;
  listing?: CcListingBlock | null;
  offers?: CcOfferRef[] | null;
  owner?: { wallet?: string; name?: string; id?: string };
  images?: { front?: string; frontS?: string; frontM?: string };
  insuredValue?: string | number;
  /** Platform suggest / secondary mark when present on API. */
  suggestPrice?: string | number;
  blockchain?: string;
  set?: string;
  serial?: string;
  nftStatus?: string;
  vault?: string;
  [key: string]: unknown;
}

export interface CcMarketplaceResponse {
  filterNFtCard?: CcCard[];
  findTotal?: number;
  total?: number;
  totalPages?: number;
  cardsQtyByCategory?: Record<string, number>;
}

export interface CollectorCryptOptions {
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  /** Default page size (step). Clamped to 1..100. */
  defaultStep?: number;
  /** Max retries on 429 / 5xx (default 3). */
  maxRetries?: number;
  /** Base delay ms between retries (default 500); multiplied by attempt, honors Retry-After. */
  retryDelayMs?: number;
  /**
   * Server-side `blockchain` filter (CSV values: Solana, Base, …).
   * Default `"Solana"` for Solana radar. Pass `null` to omit the param.
   */
  blockchain?: CcBlockchain | string | null;
  /**
   * Concurrent multi-page cold pulls (default start 8, max 16).
   * Set `{ start: 1, max: 1 }` to force sequential (tests / fragile networks).
   */
  pageConcurrency?: AdaptiveConcurrencyOptions;
}

export interface CollectorCryptBidsOptions extends CollectorCryptOptions {
  /**
   * Explicit mint addresses to fetch offers for. When set, pull() skips
   * browse discovery and queries getCardOffers for exactly these mints
   * (used by `traded-listings card <tokenId> --bids`).
   */
  nftAddresses?: string[];
  defaultTcg?: string;
  /**
   * After browse, call POST getCardOffers per mint with offer refs (default true).
   * Browse alone almost always returns id-only offers.
   */
  enrichOffers?: boolean;
  /** Max concurrent getCardOffers calls (default 4). Alias: maxConcurrent. */
  concurrency?: number;
  /** Bid-budget alias for concurrency (docs/BIDS_BUDGET.md). */
  maxConcurrent?: number;
  /**
   * Cap how many mints get detail enrichment per pull (default 24).
   * Prefer cards that already show offer id refs on browse.
   * Alias: maxSample.
   */
  sampleCards?: number;
  /** Bid-budget alias for sampleCards. */
  maxSample?: number;
  /**
   * TTL for per-mint getCardOffers cache (ms). Default 30_000.
   * 0 disables caching (always miss).
   */
  ttlMs?: number;
}

/** Extended bids query — marketplace filters + instrument scope. */
export interface CollectorCryptBidsQuery extends BidsPullQuery {
  tcg?: string;
  grader?: string;
  grade?: string;
  priceMin?: number;
  priceMax?: number;
  offset?: number;
  sort?: string;
  platform?: string;
  /** Pages to scan when harvesting offers (default 1). */
  pages?: number;
  /** Override constructor enrichOffers for this pull. */
  enrichOffers?: boolean;
  /** Cap mints for getCardOffers (default opts.sampleCards / 24). */
  sampleCards?: number;
}

export interface CcPullMeta {
  page: number;
  step: number;
  totalPages: number;
  findTotal: number | null;
  url: string | null;
  /** Sum of offer id refs on browse cards. */
  offerRefs: number;
  /** Priced offers already present on browse payload (usually 0). */
  pricedOffers: number;
  /** Resolved blockchain query param (null if omitted). */
  blockchain: string | null;
  /** Pages fetched in last pull / pullAll. */
  pagesFetched: number;
}

export interface CcBidsPullMeta extends CcPullMeta {
  enrichEnabled: boolean;
  mintsAttempted: number;
  detailOffersRaw: number;
  bidsNormalized: number;
  attempts: Array<{
    nftAddress: string;
    httpStatus: number | null;
    offerCount: number;
    error?: string;
    /** True when getCardOffers was served from TTL cache. */
    cacheHit?: boolean;
  }>;
  /** Origin HTTP for getCardOffers this pull (excludes browse). */
  httpCalls: number;
  /** Detail fetches skipped due to fresh TTL cache. */
  cacheHits: number;
  /** Instruments selected for detail this pull. */
  sampleUsed: number;
  maxConcurrent: number;
  ttlMs: number;
  fetchedAt: string;
}

/** Cached getCardOffers payload keyed by mint (nftAddress). */
interface CcOffersCacheValue {
  offers: CcOfferRef[];
  httpStatus: number | null;
  error?: string;
}

const TCG_TO_CATEGORY: Record<string, string> = {
  pokemon: "Pokemon",
  one_piece: "One Piece",
  mtg: "Magic The Gathering",
  magic: "Magic The Gathering",
  yugioh: "Yu-Gi-Oh!",
  "yu-gi-oh": "Yu-Gi-Oh!",
  lorcana: "Lorcana",
  baseball: "Baseball",
  basketball: "Basketball",
  football: "Football",
};

function mapCategoryToTcg(category?: string): string | null {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c.includes("pokemon")) return "pokemon";
  if (c.includes("one piece")) return "one_piece";
  if (c.includes("magic")) return "mtg";
  if (c.includes("yu-gi")) return "yugioh";
  if (c.includes("lorcana")) return "lorcana";
  return category.toLowerCase().replace(/\s+/g, "_");
}

function mapItemType(type?: string): string | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t === "sealed") return "sealed";
  if (t === "card" || t === "raw") return "card";
  return t;
}

function clampStep(n: number | undefined, fallback: number): number {
  const v = n ?? fallback;
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(Math.floor(v), MAX_STEP);
}

/** Normalize / validate blockchain filter; empty or null → omit. */
export function resolveBlockchainParam(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  // API enum is case-sensitive (solana → 400). Canonicalize common aliases.
  const lower = trimmed.toLowerCase();
  const hit = CC_BLOCKCHAINS.find((b) => b.toLowerCase() === lower);
  return hit ?? trimmed;
}

/** page is 1-indexed; derived from offset/limit when offset given. */
export function pageFromQuery(
  query: Pick<PullQuery, "offset" | "limit">,
  defaultStep: number,
): { page: number; step: number } {
  const step = clampStep(query.limit, defaultStep);
  const page =
    query.offset != null && step > 0
      ? Math.floor(Math.max(0, query.offset) / step) + 1
      : 1;
  return { page: Math.max(1, page), step };
}

export interface BuildMarketplaceUrlOpts {
  /** Override provider default blockchain filter. */
  blockchain?: string | null;
}

/** Build GET /marketplace URL from PullQuery (page/step + filters). */
export function buildMarketplaceUrl(
  baseUrl: string,
  query: PullQuery = {},
  defaultStep = 50,
  opts: BuildMarketplaceUrlOpts = {},
): string {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const u = new URL("marketplace", base);
  const { page, step } = pageFromQuery(query, defaultStep);
  u.searchParams.set("page", String(page));
  u.searchParams.set("step", String(step));
  // Delist signal: only currently-listed rows. Absence after complete pullAll = prune.
  u.searchParams.set("marketplaceStatus", "Buy now");

  // Category / tcg
  if (query.tcg) {
    const cat = TCG_TO_CATEGORY[query.tcg.toLowerCase()] ?? query.tcg;
    u.searchParams.set("categories", cat);
  }

  if (query.q) u.searchParams.set("search", query.q);
  if (query.itemType === "sealed") u.searchParams.set("cardType", "Sealed");
  else if (query.itemType === "card") u.searchParams.set("cardType", "Card");
  if (query.grader) u.searchParams.set("gradingCompany", query.grader);
  if (query.grade != null) u.searchParams.set("grade", String(query.grade));
  if (query.language) u.searchParams.set("language", query.language);
  if (query.priceMin != null) {
    u.searchParams.set("listPriceMin", String(query.priceMin));
  }
  if (query.priceMax != null) {
    u.searchParams.set("listPriceMax", String(query.priceMax));
  }
  if (query.yearMin != null) u.searchParams.set("yearMin", String(query.yearMin));
  if (query.yearMax != null) u.searchParams.set("yearMax", String(query.yearMax));
  if (query.platform === "me") u.searchParams.set("marketplaceSource", "ME");
  else if (query.platform === "cc") u.searchParams.set("marketplaceSource", "CC");

  // Official filter: blockchain CSV (Solana | Base | Monad | …). Case-sensitive.
  const chain = resolveBlockchainParam(opts.blockchain);
  if (chain) u.searchParams.set("blockchain", chain);

  const sortMap: Record<string, string> = {
    new: "listedDateDesc",
    price: "listedPriceAsc",
    deal: "listedDateDesc",
    listedDateDesc: "listedDateDesc",
    listedPriceAsc: "listedPriceAsc",
    listedPriceDesc: "listedPriceDesc",
  };
  u.searchParams.set(
    "orderBy",
    sortMap[query.sort ?? "new"] ?? "listedDateDesc",
  );
  return u.toString();
}

/**
 * lastEvent for a still-listed browse row.
 * - Active ask under marketplaceStatus=Buy now → LIST.
 * - Card `status` (e.g. Transferred) is catalog ownership, not sold/delist — not mapped.
 * - listing.updatedAt is often bumped without a price change; do not treat as PRICE_UPDATE.
 * - No bulk sold field on remaining Buy-now rows; leave-book is poll-diff absence only.
 * - Offer `status` is bid-side only (see normalizeCcOffer).
 */
export function lastEventFromCcCard(card: CcCard): Listing["lastEvent"] {
  const listing = card.listing;
  if (!listing || listing.price == null) return null;
  return "LIST";
}

/** Normalize a CC marketplace card with an active listing into shared Listing. */
export function normalizeCcCard(
  card: CcCard,
  providerId = "collectorcrypt",
  opts: { observedAt?: string } = {},
): Listing | null {
  const listing = card.listing;
  if (!listing || listing.price == null) return null;
  const price = Number(listing.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const platform =
    (listing.marketplace ?? "CC").toLowerCase() === "me" ? "me" : "cc";
  const nativeId = card.id || card.nftAddress || "";
  if (!nativeId) return null;
  const id = listingId({
    provider: providerId,
    platform,
    nativeId,
  });
  const fmvRaw = card.insuredValue;
  const fmv = fmvRaw == null || fmvRaw === "" ? null : Number(fmvRaw);
  const currency = (listing.currency ?? "USDC").toString();
  const offerCount = countOfferRefs(card).refs;
  const lake = lakeListingFromCcCard(card, {
    observed_at: opts.observedAt,
  });
  const base: Listing = {
    id,
    provider: providerId,
    platform,
    nativeId,
    tokenId: card.nftAddress ?? null,
    name: card.itemName ?? nativeId,
    price,
    currency,
    fmv: fmv != null && Number.isFinite(fmv) ? fmv : null,
    // `insuredValue` is USD; CC also lists in SOL. deltaFromListing returns
    // null for non-USD prices instead of a fake ~-97% discount.
    delta: deltaFromListing(price, fmv, currency),
    market: listing.marketplace === "ME" ? "Magic Eden" : "CC Native",
    seller: card.owner?.wallet ?? listing.sellerId ?? null,
    // Public card page (deep-link only; no tx). Prefer mint; fall back to card id
    // on the same documented path: https://collectorcrypt.com/cards/{mint|id}.
    externalUrl: ccListingUrl(card.nftAddress) ?? ccListingUrl(card.id),
    imageUrl:
      card.images?.frontS ?? card.images?.frontM ?? card.images?.front ?? null,
    listedAt: listing.createdAt ?? card.listedAt ?? null,
    firstListedAt: listing.createdAt ?? null,
    lastEvent: lastEventFromCcCard(card),
    tcg: mapCategoryToTcg(card.category),
    itemType: mapItemType(card.type ?? undefined),
    grader: card.gradingCompany ?? null,
    grade: card.grade ?? null,
    gradeNum: card.gradeNum == null ? null : Number(card.gradeNum),
    language: card.language ?? null,
    setRaw: card.set ?? null,
    cardNumber: card.serial ?? null,
    year: card.year == null ? null : Number(card.year),
    confidence: null,
    canonical: null,
    contractAddress: null,
    searchBlob: card.itemName ?? null,
    // offerCount: browse is usually id-only; count always available without detail RPC.
    // card.status kept on raw when present (catalog ownership, not leave-book).
    raw: { ...card, offerCount },
  };
  return lake ? attachLakeListingToRaw(base, lake) : base;
}

export function bidderFromCcOffer(o: CcOfferRef): string | null {
  if (o.buyerWallet) return String(o.buyerWallet);
  if (o.wallet) return String(o.wallet);
  if (typeof o.buyer === "string" && o.buyer) return o.buyer;
  if (o.buyer && typeof o.buyer === "object" && o.buyer.wallet) {
    return String(o.buyer.wallet);
  }
  if (o.buyerId) return String(o.buyerId);
  return null;
}

/** Map one priced CC offer into a BidOrder (null if no usable price). */
export function normalizeCcOffer(
  o: CcOfferRef,
  card: Pick<
    CcCard,
    | "id"
    | "nftAddress"
    | "gradingCompany"
    | "grade"
    | "gradeNum"
    | "itemName"
    | "category"
    | "insuredValue"
    | "listing"
  >,
  providerId = "collectorcrypt",
  opts: { observedAt?: string } = {},
): BidOrder | null {
  if (!o?.id) return null;
  const price = o.price == null ? null : Number(o.price);
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const status = (o.status ?? "Active").toString().toLowerCase();
  if (status && status !== "active" && status !== "open") return null;
  const bid: BidOrder = {
    id: listingId({
      provider: providerId,
      platform: "cc",
      nativeId: `offer:${o.id}`,
    }),
    provider: providerId,
    instrumentKey: instrumentKeyFromCcCard(card as CcCard),
    nativeId: o.id,
    side: "bid",
    price,
    size: 1,
    currency: (o.currency ?? "USDC").toString(),
    bidder: bidderFromCcOffer(o),
    platform: "cc",
    updatedAt:
      (typeof o.updatedAt === "string" && o.updatedAt) ||
      (typeof o.createdAt === "string" && o.createdAt) ||
      new Date().toISOString(),
    raw: o,
  };
  const lake = lakeOfferFromCcOffer(o, card as CcCard, {
    observed_at: opts.observedAt,
  });
  return lake ? attachLakeOfferToRaw(bid, lake) : bid;
}

/** Map CC offer refs on a card into BidOrders (when price present). */
export function normalizeCcOffers(
  card: CcCard,
  providerId = "collectorcrypt",
  opts: { observedAt?: string } = {},
): BidOrder[] {
  const offers = card.offers ?? [];
  const out: BidOrder[] = [];
  for (const o of offers) {
    const b = normalizeCcOffer(o, card, providerId, opts);
    if (b) out.push(b);
  }
  return out;
}

/** Count offer refs (priced + id-only) on a card. */
export function countOfferRefs(card: CcCard): {
  refs: number;
  priced: number;
} {
  const offers = card.offers ?? [];
  let priced = 0;
  let refs = 0;
  for (const o of offers) {
    if (!o?.id) continue;
    refs += 1;
    const p = o.price == null ? null : Number(o.price);
    if (p != null && Number.isFinite(p) && p > 0) priced += 1;
  }
  return { refs, priced };
}

/**
 * POST JSON-RPC root: getCardOffers for a mint.
 * Live returns priced Active offers (useV2: true required for V2 escrow offers).
 */
export async function fetchCcCardOffers(
  nftAddress: string,
  opts: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    userAgent?: string;
    useV2?: boolean;
    maxRetries?: number;
    retryDelayMs?: number;
  } = {},
): Promise<{ offers: CcOfferRef[]; httpStatus: number }> {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const useV2 = opts.useV2 !== false;
  const res = await fetchWithRetry(
    `${base}/`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": opts.userAgent ?? "traded-listings/0.3 (+collectorcrypt)",
      },
      body: JSON.stringify({
        method: "getCardOffers",
        params: { nftAddress, useV2 },
      }),
    },
    {
      fetchImpl,
      maxRetries: opts.maxRetries ?? 3,
      baseDelayMs: opts.retryDelayMs ?? 500,
    },
  );
  if (!res.ok) {
    return { offers: [], httpStatus: res.status };
  }
  const body = (await res.json()) as unknown;
  const offers = Array.isArray(body)
    ? (body as CcOfferRef[])
    : Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: CcOfferRef[] }).data)
      : [];
  return { offers, httpStatus: res.status };
}

export function instrumentKeyFromCcCard(card: CcCard): string {
  const grader = (card.gradingCompany ?? "raw").toLowerCase();
  const grade = card.gradeNum ?? card.grade ?? "raw";
  if (card.nftAddress) return `cc:mint:${card.nftAddress}|${grader}|${grade}`;
  return `cc:card:${card.id}|${grader}|${grade}`;
}

export class CollectorCryptProvider implements ListingsProvider {
  readonly id = "collectorcrypt";
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultStep: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  /** Server-side blockchain filter; null omits the query param. */
  private readonly blockchain: string | null;
  private readonly pageConcurrency: AdaptiveConcurrencyOptions;
  /** Last ETag per marketplace URL (If-None-Match on next pull). */
  private readonly etagByUrl = new Map<string, string>();
  /** Most recent marketplace ETag (diagnostics / fallback). */
  lastEtag: string | null = null;
  /** Last pull's raw cards (for offer extraction). */
  lastCards: CcCard[] = [];
  /** Diagnostics from last pull. */
  lastPullMeta: CcPullMeta | null = null;
  /** Last concurrent page-walk stats (cold pullPages). */
  lastPageWalkStats: {
    pagesAttempted: number;
    pagesOk: number;
    throttles: number;
    peakConcurrency: number;
    wallMs: number;
  } | null = null;

  constructor(opts: CollectorCryptOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    // Browser-like UA reduces CDN/WAF 403 rate windows on warm multi-page pulls.
    this.userAgent =
      opts.userAgent ??
      "Mozilla/5.0 (compatible; live-gacha-listings-fetcher/0.1; +https://github.com/Evan-Kim2028/live-gacha-listings-fetcher)";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.defaultStep = clampStep(opts.defaultStep, 50);
    this.maxRetries = opts.maxRetries ?? 4;
    this.retryDelayMs = opts.retryDelayMs ?? 800;
    this.pageConcurrency = opts.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
    // Default Solana for radar; explicit null disables the filter.
    this.blockchain =
      opts.blockchain === undefined
        ? DEFAULT_BLOCKCHAIN
        : resolveBlockchainParam(opts.blockchain);
  }

  private urlOpts(): BuildMarketplaceUrlOpts {
    return { blockchain: this.blockchain };
  }

  /**
   * GET /marketplace with optional If-None-Match.
   * Soft: when origin never returns ETag, fingerprint path still works.
   */
  private async fetchMarketplace(
    url: string,
    ifNoneMatch?: string | null,
  ): Promise<
    | { notModified: true; etag: string | null }
    | {
        notModified: false;
        body: CcMarketplaceResponse;
        etag: string | null;
      }
  > {
    const inm =
      ifNoneMatch || this.etagByUrl.get(url) || this.lastEtag || null;
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
      const etag = getResponseEtag(res) ?? inm;
      if (etag) {
        this.etagByUrl.set(url, etag);
        this.lastEtag = etag;
      }
      return { notModified: true, etag };
    }
    if (!res.ok) {
      throw new Error(
        `Collector Crypt marketplace HTTP ${res.status} for ${url}`,
      );
    }
    const etag = getResponseEtag(res);
    if (etag) {
      this.etagByUrl.set(url, etag);
      this.lastEtag = etag;
    }
    return {
      notModified: false,
      body: (await res.json()) as CcMarketplaceResponse,
      etag,
    };
  }

  async pull(query: PullQuery = {}): Promise<PullPage> {
    const q = { ...query, limit: clampStep(query.limit, this.defaultStep) };
    if (q.offline && !q.fixturePath) {
      throw new Error("CollectorCryptProvider: offline without fixturePath");
    }

    const { page, step } = pageFromQuery(q, this.defaultStep);
    let body: CcMarketplaceResponse;
    let url: string | null = null;
    let etag: string | null = null;
    const fetchedAt = new Date().toISOString();

    if (q.fixturePath) {
      const { readFile } = await import("node:fs/promises");
      body = JSON.parse(
        await readFile(q.fixturePath, "utf8"),
      ) as CcMarketplaceResponse;
    } else {
      url = buildMarketplaceUrl(
        this.baseUrl,
        q,
        this.defaultStep,
        this.urlOpts(),
      );
      // Conditional GET only for page 1 of a given URL (offset 0).
      const ifNone = page === 1 ? q.ifNoneMatch : undefined;
      const result = await this.fetchMarketplace(url, ifNone);
      if (result.notModified) {
        this.lastCards = [];
        this.lastPullMeta = {
          page,
          step,
          totalPages: 1,
          findTotal: null,
          url,
          offerRefs: 0,
          pricedOffers: 0,
          blockchain: this.blockchain,
          pagesFetched: 0,
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
            etag: result.etag,
          },
        };
      }
      body = result.body;
      etag = result.etag;
    }

    const cards = body.filterNFtCard ?? [];
    const chainWanted = this.blockchain?.toLowerCase() ?? null;
    this.lastCards = cards;
    const listings: Listing[] = [];
    let offerRefs = 0;
    let pricedOffers = 0;
    for (const c of cards) {
      // Client-side belt: drop rows that disagree with blockchain filter.
      if (
        chainWanted &&
        c.blockchain &&
        c.blockchain.toLowerCase() !== chainWanted
      ) {
        continue;
      }
      const counts = countOfferRefs(c);
      offerRefs += counts.refs;
      pricedOffers += counts.priced;
      const n = normalizeCcCard(c, this.id);
      if (n) listings.push(n);
    }

    const totalPages = body.totalPages ?? 1;
    this.lastPullMeta = {
      page,
      step,
      totalPages,
      findTotal: body.findTotal ?? null,
      url,
      offerRefs,
      pricedOffers,
      blockchain: this.blockchain,
      pagesFetched: 1,
    };

    // Stable generation when origin has no builtAt; fingerprint path works
    // even if ETag is never returned.
    const fp = contentFingerprint(listings);

    return {
      listings,
      hasMore: page < totalPages,
      meta: {
        provider: this.id,
        builtAt: fp,
        total: body.findTotal ?? listings.length,
        universe: body.total ?? null,
        fetchedAt,
        querySignature: "",
        etag,
        contentFingerprint: fp,
      },
    };
  }

  /**
   * Multi-page pull via page/step (step ≤ 100). Page 1 discovers totalPages,
   * then remaining pages fetch **concurrently** with adaptive concurrency +
   * backoff (see {@link paginateConcurrent}).
   */
  async pullPages(query: PullQuery = {}): Promise<PullPage> {
    const maxPages = Math.max(
      1,
      query.maxPages != null && Number.isFinite(query.maxPages)
        ? Math.floor(query.maxPages)
        : 1,
    );
    const step = clampStep(query.limit, this.defaultStep);
    const startPage = pageFromQuery(query, this.defaultStep).page; // 1-based

    let findTotal: number | null = null;
    let universe: number | null = null;
    let offerRefs = 0;
    let pricedOffers = 0;
    let lastUrl: string | null = null;
    let etag: string | null = null;
    let knownTotalPages: number | null = null;

    const walk = await paginateConcurrent<Listing>({
      maxPages,
      concurrency: this.pageConcurrency,
      baseBackoffMs: this.retryDelayMs,
      fetchFirst: async () => {
        const offset = (startPage - 1) * step;
        const one = await this.pull({
          ...query,
          limit: step,
          offset,
          ifNoneMatch: query.ifNoneMatch,
        });
        if (one.notModified) {
          return { listings: [], full: false, notModified: true };
        }
        if (this.lastPullMeta) {
          knownTotalPages = this.lastPullMeta.totalPages;
          findTotal = this.lastPullMeta.findTotal;
          offerRefs = this.lastPullMeta.offerRefs;
          pricedOffers = this.lastPullMeta.pricedOffers;
          lastUrl = this.lastPullMeta.url;
        }
        universe = one.meta.universe ?? universe;
        etag = one.meta.etag ?? etag;
        return {
          listings: one.listings,
          full: one.hasMore === true && one.listings.length > 0,
          knownTotalPages,
        };
      },
      fetchPage: async (pageIndex) => {
        const page1 = startPage + pageIndex;
        const offset = (page1 - 1) * step;
        const one = await this.pull({
          ...query,
          limit: step,
          offset,
        });
        if (this.lastPullMeta) {
          offerRefs += this.lastPullMeta.offerRefs;
          pricedOffers += this.lastPullMeta.pricedOffers;
          lastUrl = this.lastPullMeta.url ?? lastUrl;
        }
        etag = one.meta.etag ?? etag;
        const full =
          one.hasMore === true &&
          one.listings.length > 0 &&
          (knownTotalPages == null || page1 < knownTotalPages);
        return { listings: one.listings, full };
      },
    });

    if (walk.notModified) {
      return {
        listings: [],
        hasMore: false,
        notModified: true,
        meta: {
          provider: this.id,
          builtAt: null,
          total: null,
          universe: null,
          fetchedAt: new Date().toISOString(),
          querySignature: "",
        },
      };
    }

    this.lastPageWalkStats = {
      pagesAttempted: walk.stats.items + 1,
      pagesOk: walk.stats.ok + 1,
      throttles: walk.stats.throttles,
      peakConcurrency: walk.stats.peakConcurrency,
      wallMs: walk.stats.wallMs,
    };

    const totalPages = knownTotalPages ?? walk.pagesFetched;
    this.lastCards = [];
    this.lastPullMeta = {
      page: startPage + walk.pagesFetched - 1,
      step,
      totalPages,
      findTotal,
      url: lastUrl,
      offerRefs,
      pricedOffers,
      blockchain: this.blockchain,
      pagesFetched: walk.pagesFetched,
    };

    const fp = contentFingerprint(walk.listings);
    return {
      listings: walk.listings,
      hasMore: walk.hasMore,
      meta: {
        provider: this.id,
        builtAt: fp,
        total: findTotal,
        universe,
        fetchedAt: new Date().toISOString(),
        querySignature: "",
        etag,
        contentFingerprint: fp,
      },
    };
  }

  /**
   * Fuller multi-page pull used by syncOnce when present.
   * Paginates with step ≤ 100 until `limit` listings, maxPages, or !hasMore.
   * `bootstrap: true` (or explicit maxPages) uses a high page cap for cold full book.
   * Single page when limit ≤ step and no bootstrap/maxPages override.
   * 429/5xx backoff via fetchWithRetry on each page.
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
          : this.defaultStep;
    // API step max 100; never request more per page.
    const step = clampStep(
      Number.isFinite(desired) ? Math.min(desired, MAX_STEP) : this.defaultStep,
      this.defaultStep,
    );
    const maxPages = hasExplicitMaxPages
      ? Math.max(1, Math.floor(query.maxPages!))
      : bootstrap
        ? BOOTSTRAP_MAX_PAGES
        : Math.max(1, Math.ceil(desired / step));

    if (maxPages === 1) {
      return this.pull({
        ...query,
        limit: Number.isFinite(desired) ? Math.min(desired, step) : step,
      });
    }

    const page = await this.pullPages({
      ...query,
      limit: step,
      maxPages,
    });
    // pullPages already stops on !hasMore / empty page.
    if (Number.isFinite(desired) && page.listings.length > desired) {
      return {
        ...page,
        listings: page.listings.slice(0, desired),
      };
    }
    return page;
  }
}

/**
 * Bids from Collector Crypt.
 *
 * 1. Browse GET /marketplace (filters) — discovers cards + offer **id** refs.
 * 2. Enrich: POST / getCardOffers per mint (useV2) — priced Active bids.
 * 3. Also harvest any priced offers already on the browse payload.
 *
 * Poll-only. Docs document write-side offer txs; getCardOffers is the webapp
 * read path (unauthenticated in production probes).
 */
export class CollectorCryptBidsProvider implements BidsProvider {
  readonly id = "collectorcrypt_bids";
  private readonly listings: CollectorCryptProvider;
  private readonly opts: CollectorCryptBidsOptions;
  private readonly defaultTcg: string | undefined;
  private readonly maxConcurrent: number;
  private readonly sampleDefault: number;
  private readonly ttlMs: number;
  /** Process-local getCardOffers cache keyed by provider+mint. */
  private readonly offersCache: TtlCache<CcOffersCacheValue>;
  /** Diagnostics from last bids pull (browse + detail enrichment). */
  lastBidsMeta: CcBidsPullMeta | null = null;

  constructor(opts: CollectorCryptBidsOptions = {}) {
    this.opts = opts;
    this.listings = new CollectorCryptProvider(opts);
    this.defaultTcg = opts.defaultTcg ?? "pokemon";
    this.maxConcurrent = Math.max(
      1,
      opts.maxConcurrent ?? opts.concurrency ?? DEFAULT_MAX_CONCURRENT,
    );
    this.sampleDefault = Math.max(
      1,
      opts.maxSample ?? opts.sampleCards ?? 24,
    );
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.offersCache = new TtlCache<CcOffersCacheValue>(this.ttlMs);
  }

  /** Expose last marketplace cards for diagnostics. */
  get lastCards(): CcCard[] {
    return this.listings.lastCards;
  }

  get lastPullMeta(): CcPullMeta | null {
    return this.listings.lastPullMeta;
  }

  async pull(query: CollectorCryptBidsQuery = {}): Promise<BidOrder[]> {
    const explicit = this.opts.nftAddresses;
    if (explicit && explicit.length > 0 && !query.fixturePath && !query.offline) {
      // Point lookup: no browse discovery — getCardOffers for exactly these mints.
      const bids: BidOrder[] = [];
      const seen = new Set<string>();
      const budgetRun = await mapWithBidBudget(explicit, {
        provider: this.id,
        assetOf: (mint) => mint,
        maxConcurrent: this.maxConcurrent,
        ttlMs: this.ttlMs,
        cache: this.offersCache,
        fetch: async (mint) => {
          try {
            const { offers } = await fetchCcCardOffers(mint, {
              baseUrl: this.opts.baseUrl,
              fetchImpl: this.opts.fetchImpl,
              userAgent: this.opts.userAgent,
              useV2: true,
            });
            return { offers, httpStatus: null, error: undefined as string | undefined };
          } catch (e) {
            return {
              offers: [] as CcOfferRef[],
              httpStatus: null as number | null,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        },
      });
      for (let i = 0; i < explicit.length; i++) {
        const mint = explicit[i]!;
        const r = budgetRun.results[i]!;
        const card: CcCard = {
          id: mint,
          nftAddress: mint,
          itemName: mint,
          offers: r.offers,
        } as CcCard;
        const observedAt = new Date().toISOString();
        for (const o of r.offers) {
          const b = normalizeCcOffer(o, { ...card, nftAddress: mint }, "collectorcrypt", {
            observedAt,
          });
          if (!b) continue;
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          bids.push(b);
        }
      }
      return bids;
    }
    const pages = Math.max(1, query.pages ?? 1);
    const step = clampStep(query.limit, 50);
    const pullQuery: PullQuery = {
      limit: step,
      offset: query.offset,
      tcg: query.tcg ?? this.defaultTcg,
      grader: query.grader,
      grade: query.grade,
      priceMin: query.priceMin,
      priceMax: query.priceMax,
      sort: query.sort ?? "new",
      platform: query.platform,
      fixturePath: query.fixturePath,
      offline: query.offline,
    };

    const bids: BidOrder[] = [];
    const seen = new Set<string>();

    if (pages > 1 && !query.fixturePath) {
      await this.listings.pullPages({ ...pullQuery, maxPages: pages });
    } else {
      await this.listings.pull(pullQuery);
    }

    const baseMeta = this.listings.lastPullMeta;
    // Browse-embedded priced offers (rare; usually id-only).
    for (const card of this.listings.lastCards) {
      for (const b of normalizeCcOffers(card, "collectorcrypt")) {
        if (query.instrumentKey && b.instrumentKey !== query.instrumentKey) {
          continue;
        }
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        bids.push(b);
      }
    }

    const enrich =
      query.enrichOffers ?? this.opts.enrichOffers ?? true;
    const offline = !!query.offline || !!query.fixturePath;
    // Fixture/offline: only enrich when a custom fetchImpl can serve RPC.
    const canEnrich =
      enrich && (!offline || this.opts.fetchImpl != null);

    const attempts: CcBidsPullMeta["attempts"] = [];
    let detailOffersRaw = 0;
    let mintsAttempted = 0;
    let httpCalls = 0;
    let cacheHits = 0;
    let sampleUsed = 0;

    if (canEnrich) {
      const sampleCap = Math.max(
        1,
        query.sampleCards ?? this.opts.sampleCards ?? this.sampleDefault,
      );
      // Prefer cards with offer refs / offerCount > 0; then rest with mint.
      const withRefs = this.listings.lastCards.filter(
        (c) => c.nftAddress && countOfferRefs(c).refs > 0,
      );
      const rest = this.listings.lastCards.filter(
        (c) =>
          c.nftAddress &&
          !withRefs.some((w) => w.nftAddress === c.nftAddress),
      );
      // Dedupe by mint, preserve prefer rank (withRefs first).
      const byMint = new Map<string, CcCard>();
      for (const c of [...withRefs, ...rest]) {
        if (c.nftAddress && !byMint.has(c.nftAddress)) {
          byMint.set(c.nftAddress, c);
        }
      }
      const mints = [...byMint.keys()].slice(0, sampleCap);
      mintsAttempted = mints.length;

      // Snapshot cache state before budget run for per-mint attempt flags.
      const preHit = new Set<string>();
      for (const mint of mints) {
        if (this.offersCache.has(bidCacheKey(this.id, mint))) {
          preHit.add(mint);
        }
      }

      const budgetRun = await mapWithBidBudget(mints, {
        provider: this.id,
        assetOf: (mint) => mint,
        maxConcurrent: this.maxConcurrent,
        ttlMs: this.ttlMs,
        cache: this.offersCache,
        fetch: async (mint) => {
          try {
            const { offers, httpStatus } = await fetchCcCardOffers(mint, {
              baseUrl: this.opts.baseUrl,
              fetchImpl: this.opts.fetchImpl,
              userAgent: this.opts.userAgent,
              useV2: true,
            });
            return {
              offers,
              httpStatus,
              error: undefined as string | undefined,
            };
          } catch (e) {
            return {
              offers: [] as CcOfferRef[],
              httpStatus: null as number | null,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        },
      });

      httpCalls = budgetRun.httpCalls;
      cacheHits = budgetRun.cacheHits;
      sampleUsed = budgetRun.sampleUsed;

      for (let i = 0; i < mints.length; i++) {
        const mint = mints[i]!;
        const r = budgetRun.results[i]!;
        const card = byMint.get(mint)!;
        attempts.push({
          nftAddress: mint,
          httpStatus: r.httpStatus,
          offerCount: r.offers.length,
          error: r.error,
          cacheHit: preHit.has(mint),
        });
        detailOffersRaw += r.offers.length;
        const observedAt = new Date().toISOString();
        for (const o of r.offers) {
          const b = normalizeCcOffer(o, { ...card, nftAddress: mint }, "collectorcrypt", {
            observedAt,
          });
          if (!b) continue;
          if (query.instrumentKey && b.instrumentKey !== query.instrumentKey) {
            continue;
          }
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          bids.push(b);
        }
      }
    }

    this.lastBidsMeta = {
      page: baseMeta?.page ?? 1,
      step: baseMeta?.step ?? step,
      totalPages: baseMeta?.totalPages ?? 1,
      findTotal: baseMeta?.findTotal ?? null,
      url: baseMeta?.url ?? null,
      offerRefs: baseMeta?.offerRefs ?? 0,
      pricedOffers: baseMeta?.pricedOffers ?? 0,
      blockchain: baseMeta?.blockchain ?? null,
      pagesFetched: baseMeta?.pagesFetched ?? 1,
      enrichEnabled: canEnrich,
      mintsAttempted,
      detailOffersRaw,
      bidsNormalized: bids.length,
      attempts,
      httpCalls,
      cacheHits,
      sampleUsed: canEnrich ? sampleUsed : 0,
      maxConcurrent: this.maxConcurrent,
      ttlMs: this.ttlMs,
      fetchedAt: new Date().toISOString(),
    };

    return bids;
  }
}

export function createCollectorCryptProvider(
  opts?: CollectorCryptOptions,
): CollectorCryptProvider {
  return new CollectorCryptProvider(opts);
}

export function createCollectorCryptBidsProvider(
  opts?: CollectorCryptBidsOptions,
): CollectorCryptBidsProvider {
  return new CollectorCryptBidsProvider(opts);
}
