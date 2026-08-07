/**
 * Long-tail marketplace providers: Beezie, Beezie Solana, Renaiss, DYLI, Phygitals.
 *
 * Beezie (Base): EVM marketplace on Base L2 (Seaport-style `0x` SellOrder;
 * claw contract verified on basescan.org). Provider stays registered for
 * inventory; normalize flags `chain` on market + raw so Solana radar
 * consumers can filter.
 *
 * Beezie Solana: same Hono API shape on `solana-api.beezie.com` (Solana mints,
 * USDC SellOrder). Site: solana.beezie.com/marketplace/pokemon.
 */
import { readFile } from "node:fs/promises";
import { contentFingerprint } from "../contentFingerprint.js";
import {
  beezieSolanaListingUrl,
  dyliListingUrl,
  originProvidedUrl,
  phygitalsListingUrl,
  renaissListingUrl,
} from "../externalUrl.js";
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
import type { Listing } from "../types.js";
import type { ListingsProvider, PullPage, PullQuery } from "./types.js";

export type LongtailId = "beezie" | "beezie-solana" | "renaiss" | "dyli" | "phygitals";

/** Detected settlement chain from address shape. */
export type BeezieChain = "evm" | "solana" | "unknown";

export interface LongtailOptions {
  id: LongtailId;
  baseUrl?: string;
  listingPath?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  /** Documented status for operators */
  statusNote?: string;
  /** Beezie category id (default "1" = Pokémon) */
  beezieCategoryId?: string;
  /**
   * Pull **all** Beezie categories (GET /dropItems/categories) instead of
   * only `beezieCategoryId`. Walks every enabled category and merges into
   * one PullPage (one store scope). Any category that fails marks the walk
   * incomplete (hasMore=true → upsert-only, no prune).
   */
  allBeezieCategories?: boolean;
  /** Retries after first attempt on 429 / 5xx / network (default 2). */
  maxRetries?: number;
  /** Base delay ms for exponential backoff (default 400). */
  retryDelayMs?: number;
  /**
   * Optional Phygitals user API key (`phy_…`). Browse is public; key is sent as
   * `X-API-Key` when set (or env `PHYGITALS_API_KEY`).
   */
  apiKey?: string;
  /**
   * Concurrent multi-page cold pulls for Beezie/Phygitals (default start 8, max 16).
   */
  pageConcurrency?: AdaptiveConcurrencyOptions;
}

/** Diagnostics from last Beezie pull. */
export interface BeeziePullMeta {
  page: number;
  pageSize: number;
  total: number | null;
  chainCounts: Record<BeezieChain, number>;
  /** Dominant chain across the page (evm when EVM-only catalog). */
  dominantChain: BeezieChain;
}

const DEFAULTS: Record<
  LongtailId,
  { baseUrl: string; listingPath: string; note: string }
> = {
  beezie: {
    baseUrl: "https://api.beezie.com",
    listingPath: "/dropItems/byCategory",
    note:
      "POST /dropItems/byCategory {filters, saleStatus, sort, page, categoryId}; " +
      "page size ~20 fixed; pullAll multi-page bootstrap (maxPages cap 50); " +
      "Base L2 (EVM): owners/creators are 0x — flagged on listing.market/raw.chain",
  },
  "beezie-solana": {
    baseUrl: "https://solana-api.beezie.com",
    listingPath: "/dropItems/byCategory",
    note:
      "POST /dropItems/byCategory {filters, saleStatus, page (0-based), pageSize, " +
      "sellOrderDateOrder, categoryId}; pageSize up to 100; saleStatus=forSale = " +
      "active SellOrder only; Solana mints + USDC; buyback/claw endpoints exist " +
      "(GET /claw/minimal, /claw/buyback-offers/:username) for bid-side later",
  },
  renaiss: {
    baseUrl: "https://www.renaiss.xyz",
    listingPath: "/api/trpc/collectible.list",
    note: "tRPC collectible.list; askPriceInUSDT in wei (1e18); offers via offer.* need auth",
  },
  dyli: {
    baseUrl: "https://www.dyli.io",
    listingPath: "/api/explore",
    note: "GET /api/explore (+ /api/explore/top, /api/search/products)",
  },
  phygitals: {
    baseUrl: "https://api.phygitals.com",
    listingPath: "/api/marketplace/marketplace-listings",
    note:
      "GET marketplace-listings?page&itemsPerPage(≤200)&listedStatus=listed; pullAll multi-page for bootstrap (maxPages cap 50); wrong limit/offset → 500; soft empty + lastError on 5xx (never prunes); successful complete listed page may prune absences (delist)",
  },
};

/** Facet keys returned by GET /api/marketplace/filters (metadata.*). */
const PHYGITALS_FILTERS_PATH = "/api/marketplace/filters";

/** Browser-like headers — site JS calls api.phygitals.com from www.phygitals.com. */
const PHYGITALS_BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json",
  Origin: "https://www.phygitals.com",
  Referer: "https://www.phygitals.com/",
  "Accept-Language": "en-US,en;q=0.9",
};

type PhygitalsFiltersPayload = {
  filters?: {
    metadata?: Record<string, Array<{ value?: string; count?: number }>>;
    priceRanges?: unknown[];
  };
};

/**
 * Official Public API query shapes for GET /api/marketplace/marketplace-listings.
 * Docs: page (0-based), itemsPerPage (max 200), listedStatus, sortBy,
 * metadataConditions (JSON), priceRange/fmvRange (JSON), searchTerm.
 * Bare `limit`/`offset` alone often 500 on the origin.
 */
export function buildPhygitalsParamAttempts(
  query: PullQuery,
  filterMeta?: Record<string, Array<{ value?: string; count?: number }>>,
): Array<Record<string, string>> {
  const pageSize = Math.min(
    Math.max(query.limit ?? PHYGITALS_DEFAULT_PAGE_SIZE, 1),
    PHYGITALS_MAX_ITEMS_PER_PAGE,
  );
  const itemsPerPage = String(pageSize);
  const page =
    query.offset != null && pageSize > 0
      ? String(Math.floor(query.offset / pageSize))
      : "0";

  const base: Record<string, string> = {
    page,
    itemsPerPage,
    listedStatus: "listed",
    sortBy: "price-low-high",
  };

  const attempts: Array<Record<string, string>> = [
    { ...base },
    { ...base, sortBy: "recently-listed" },
    { ...base, sortBy: "newest" },
    { ...base, sortBy: "fmv-low-high" },
    { page, itemsPerPage, listedStatus: "listed" },
    { page, itemsPerPage, listedStatus: "any", sortBy: "price-low-high" },
    {
      page,
      itemsPerPage,
      listedStatus: "listed",
      sortBy: "price-low-high",
      metadataConditions: "{}",
      priceRange: "[null,null]",
      fmvRange: "[null,null]",
    },
  ];

  const conditions: Record<string, string[]> = {};
  if (query.tcg === "pokemon") {
    conditions.Type = ["Pokémon"];
  } else if (query.tcg) {
    conditions.Type = [query.tcg];
  }
  if (query.grader) conditions.Grader = [query.grader];
  if (query.grade) conditions.Grade = [query.grade];
  if (query.language) conditions.Language = [query.language];

  if (Object.keys(conditions).length) {
    for (const [trait, vals] of Object.entries(conditions)) {
      attempts.push({
        ...base,
        metadataConditions: JSON.stringify({ [trait]: vals }),
      });
    }
    attempts.push({
      ...base,
      metadataConditions: JSON.stringify(conditions),
    });
    if (query.tcg === "pokemon") {
      attempts.push({
        ...base,
        metadataConditions: JSON.stringify({ Category: ["Pokemon"] }),
      });
    }
  }

  if (query.priceMin != null || query.priceMax != null) {
    attempts.push({
      ...base,
      priceRange: JSON.stringify([
        query.priceMin ?? null,
        query.priceMax ?? null,
      ]),
    });
  }
  if (query.q) {
    attempts.push({ ...base, searchTerm: query.q });
  }

  // Top values from live /filters metadata (Type, Grader, Language, …)
  if (filterMeta) {
    for (const facet of ["Type", "Grader", "Language", "Rarity"] as const) {
      const values = filterMeta[facet];
      if (!values?.length) continue;
      const top = [...values]
        .filter((v) => v.value)
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
        .slice(0, 2);
      for (const v of top) {
        attempts.push({
          ...base,
          metadataConditions: JSON.stringify({ [facet]: [String(v.value)] }),
        });
      }
    }
  }

  // Dedupe by stable key
  const seen = new Set<string>();
  const out: Array<Record<string, string>> = [];
  for (const a of attempts) {
    const key = Object.keys(a)
      .sort()
      .map((k) => `${k}=${a[k]}`)
      .join("&");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** USDC base units (6 decimals) → USD number. */
export function phygitalsPriceToUsd(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const n = Number(raw) / 1_000_000;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Integer micro-units (e.g. 300000 → $0.30); small decimals already USD
  if (Number.isInteger(n) && n >= 1000) return n / 1_000_000;
  return n;
}

function phygitalsMetaMap(
  metadata: unknown,
): Record<string, string> {
  const m: Record<string, string> = {};
  if (!Array.isArray(metadata)) return m;
  for (const row of metadata) {
    if (!row || typeof row !== "object") continue;
    const r = row as { key?: string; value?: unknown };
    if (r.key == null || r.value == null) continue;
    const k = String(r.key).replace(/^\ufeff/, "").toLowerCase();
    m[k] = String(r.value);
  }
  return m;
}

/** Normalize a Phygitals UniversalNFTData listing row. */
export function normalizePhygitalsRow(
  row: Record<string, unknown>,
  providerId = "phygitals",
): Listing | null {
  const nativeId = String(row.address ?? row.slug ?? row.id ?? "");
  if (!nativeId) return null;
  // Unlisted rows may have null price — skip for ask radar
  if (row.listed === false) return null;
  const price = phygitalsPriceToUsd(row.price);
  if (price == null) return null;
  const attrs = phygitalsMetaMap(row.metadata);
  const name = String(row.name ?? attrs.title ?? attrs.name ?? nativeId);
  const gradeStr = attrs.grade ?? null;
  const gradeNum =
    gradeStr && /^\d+(\.\d+)?$/.test(gradeStr) ? Number(gradeStr) : null;
  const type = (attrs.type ?? attrs.category ?? "").toLowerCase();
  const tcg =
    type.includes("pok") || name.toLowerCase().includes("pokemon")
      ? "pokemon"
      : type || null;
  const listedAt =
    (row.mostRecentListActivity as { time?: string } | undefined)?.time ??
    (typeof row.updatedAt === "string" ? row.updatedAt : null);
  const slug = typeof row.slug === "string" ? row.slug : null;
  const fmv =
    row.altFmv == null || row.altFmv === "" ? null : Number(row.altFmv);
  return {
    id: listingId({ provider: providerId, platform: "phygitals", nativeId }),
    provider: providerId,
    platform: "phygitals",
    nativeId,
    tokenId: nativeId,
    name,
    price,
    currency: "USDC",
    fmv: fmv != null && Number.isFinite(fmv) ? fmv : null,
    delta: deltaFromListing(price, fmv, "USDC"),
    market:
      typeof row.marketplace === "string"
        ? `Phygitals (${row.marketplace})`
        : "Phygitals",
    seller: typeof row.owner === "string" ? row.owner : null,
    // Prefer slug; fall back to mint address (public card page).
    externalUrl: phygitalsListingUrl(slug ?? nativeId),
    imageUrl: typeof row.image === "string" ? row.image : null,
    listedAt,
    firstListedAt: null,
    lastEvent: "LIST",
    tcg,
    itemType: "card",
    grader: attrs.grader ?? null,
    grade: gradeStr,
    gradeNum: gradeNum != null && Number.isFinite(gradeNum) ? gradeNum : null,
    language: attrs.language ?? null,
    setRaw: attrs.set ?? null,
    cardNumber: attrs["card number"] ?? attrs["card id"] ?? null,
    year: attrs.year ? Number(attrs.year) : null,
    confidence: null,
    canonical: null,
    contractAddress:
      typeof row.collection_address === "string"
        ? row.collection_address
        : null,
    searchBlob: name,
    raw: row,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Classify wallet/creator address as EVM, Solana, or unknown. */
export function detectAddressChain(
  addr: string | null | undefined,
): BeezieChain {
  if (addr == null || typeof addr !== "string") return "unknown";
  const a = addr.trim();
  if (!a) return "unknown";
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return "evm";
  // Solana base58 pubkeys are typically 32–44 chars, no 0x prefix
  if (!a.startsWith("0x") && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) {
    return "solana";
  }
  return "unknown";
}

/** Prefer owner, then creatorAddress, for Beezie row chain detection. */
export function detectBeezieChain(row: Record<string, unknown>): BeezieChain {
  const owner = detectAddressChain(
    typeof row.owner === "string" ? row.owner : null,
  );
  if (owner !== "unknown") return owner;
  return detectAddressChain(
    typeof row.creatorAddress === "string" ? row.creatorAddress : null,
  );
}

function beezieMarketLabel(chain: BeezieChain): string {
  if (chain === "evm") return "Beezie (Base)";
  if (chain === "solana") return "Beezie (Solana)";
  return "Beezie";
}

function emptyChainCounts(): Record<BeezieChain, number> {
  return { evm: 0, solana: 0, unknown: 0 };
}

function dominantChain(
  counts: Record<BeezieChain, number>,
): BeezieChain {
  if (counts.evm === 0 && counts.solana === 0 && counts.unknown === 0) {
    return "unknown";
  }
  if (counts.evm >= counts.solana && counts.evm >= counts.unknown) return "evm";
  if (counts.solana >= counts.unknown) return "solana";
  return "unknown";
}

/**
 * Build a successful PullPage with content fingerprint as generation.
 * Soft-fail empties should pass `softFail: true` so fingerprint is omitted
 * (avoids generation short-circuit against a prior non-empty book).
 */
function emptyMeta(
  provider: string,
  listings: Listing[],
  hasMore: boolean,
  total: number | null = listings.length,
  opts?: { etag?: string | null; softFail?: boolean },
): PullPage {
  const etag = opts?.etag ?? null;
  if (opts?.softFail) {
    return {
      listings,
      hasMore,
      meta: {
        provider,
        builtAt: null,
        total,
        universe: null,
        fetchedAt: new Date().toISOString(),
        querySignature: "",
        etag,
      },
    };
  }
  const fp = contentFingerprint(listings);
  return {
    listings,
    hasMore,
    meta: {
      provider,
      builtAt: fp,
      total,
      universe: null,
      fetchedAt: new Date().toISOString(),
      querySignature: "",
      etag,
      contentFingerprint: fp,
    },
  };
}

function attrMap(
  attrs: Array<{ trait_type?: string; trait_value?: string }> | undefined,
): Record<string, string> {
  const m: Record<string, string> = {};
  for (const a of attrs ?? []) {
    if (a.trait_type && a.trait_value != null) m[a.trait_type.toLowerCase()] = String(a.trait_value);
  }
  return m;
}

/** Generic row normalizer (fixtures + flexible shapes). */
export function normalizeLongtailRow(
  row: Record<string, unknown>,
  providerId: string,
  platform: string,
): Listing | null {
  // Phygitals UniversalNFTData (address + micro-USDC price string)
  if (
    providerId === "phygitals" ||
    (typeof row.address === "string" &&
      (row.listed != null || Array.isArray(row.metadata)) &&
      row.price != null)
  ) {
    const phy = normalizePhygitalsRow(row, providerId === "phygitals" ? "phygitals" : providerId);
    if (phy) return phy;
  }
  // Beezie live shape (EVM + Solana variants share row shape)
  if (
    (providerId === "beezie" || providerId === "beezie-solana") &&
    (row.SellOrder || row.metadata)
  ) {
    return normalizeBeezieRow(row, providerId);
  }
  // Renaiss live shape
  if (providerId === "renaiss" && (row.askPriceInUSDT != null || row.tokenId != null)) {
    return normalizeRenaissRow(row, providerId);
  }
  // DYLI products
  if (providerId === "dyli" && (row.lowest_price != null || row.price != null) && row.name) {
    return normalizeDyliRow(row, providerId);
  }

  const nativeId = String(
    row.id ?? row.instance_id ?? row.token_id ?? row.tokenId ?? row.mint ?? row.nftAddress ?? "",
  );
  if (!nativeId) return null;
  const price = Number(row.price ?? row.listPrice ?? row.price_usd ?? row.lowest_price ?? 0);
  if (!Number.isFinite(price) || price <= 0) return null;
  const name = String(row.name ?? row.title ?? row.itemName ?? nativeId);
  return {
    id: listingId({ provider: providerId, platform, nativeId }),
    provider: providerId,
    platform,
    nativeId,
    tokenId: (row.token_id as string) ?? (row.tokenId as string) ?? (row.mint as string) ?? null,
    name,
    price,
    currency: String(row.currency ?? "USDC"),
    fmv: row.fmv == null ? null : Number(row.fmv),
    delta: null,
    market: providerId,
    seller: (row.seller as string) ?? (row.owner as string) ?? null,
    externalUrl: originProvidedUrl(row),
    imageUrl: (row.image_url as string) ?? (row.image as string) ?? null,
    listedAt: (row.listed_at as string) ?? (row.createdAt as string) ?? null,
    firstListedAt: null,
    lastEvent: "LIST",
    tcg: (row.tcg as string) ?? null,
    itemType: (row.item_type as string) ?? "card",
    grader: (row.grader as string) ?? null,
    grade: (row.grade as string) ?? null,
    gradeNum: row.grade_num == null ? null : Number(row.grade_num),
    language: (row.language as string) ?? null,
    setRaw: null,
    cardNumber: null,
    year: row.year == null ? null : Number(row.year),
    confidence: null,
    canonical: null,
    contractAddress: null,
    searchBlob: name,
    raw: row,
  };
}

export function normalizeBeezieRow(
  row: Record<string, unknown>,
  providerId = "beezie",
): Listing | null {
  const sell = row.SellOrder as { amountUSDC?: string; createdAt?: number } | null | undefined;
  if (!sell?.amountUSDC) return null;
  const price = Number(sell.amountUSDC);
  if (!Number.isFinite(price) || price <= 0) return null;
  const nativeId = String(row.id ?? row.tokenId ?? "");
  if (!nativeId) return null;
  const meta = (row.metadata as {
    name?: string;
    image?: string;
    attributes?: Array<{ trait_type?: string; trait_value?: string }>;
  }) ?? {};
  const attrs = attrMap(meta.attributes);
  const gradeNum = attrs.grade ? Number(attrs.grade) : null;
  const chain = detectBeezieChain(row);
  const chainNote =
    chain === "evm"
      ? "Base L2 (EVM) catalog: owner/creator are 0x addresses (Seaport SellOrder), not Solana"
      : chain === "solana"
        ? "Solana address shape detected on owner/creator"
        : "Could not classify owner/creator chain";
  // Preserve origin row; surface chain for Solana-radar filters / debugging
  const raw =
    row && typeof row === "object"
      ? { ...row, chain, chainNote }
      : { chain, chainNote, origin: row };
  return {
    id: listingId({ provider: providerId, platform: providerId, nativeId }),
    provider: providerId,
    platform: providerId,
    nativeId,
    tokenId: row.tokenId != null ? String(row.tokenId) : null,
    name: meta.name ?? nativeId,
    price,
    currency: "USDC",
    fmv: row.altFmv == null || row.altFmv === "" ? null : Number(row.altFmv),
    delta: null,
    market: beezieMarketLabel(chain),
    seller: typeof row.owner === "string" ? row.owner : null,
    // Beezie: no verified stable public item path from id/tokenId (category
    // browse only). Leave null unless origin supplies http(s) URL fields.
    // Solana variant: site collectible route /marketplace/collectible/{slug}-{mint}.
    externalUrl:
      originProvidedUrl(row) ??
      (providerId === "beezie-solana"
        ? beezieSolanaListingUrl(meta.name, row.tokenId != null ? String(row.tokenId) : null)
        : null),
    imageUrl: meta.image ?? null,
    listedAt:
      sell.createdAt != null ? new Date(Number(sell.createdAt)).toISOString() : null,
    firstListedAt: null,
    lastEvent: "LIST",
    tcg: (attrs.category ?? "pokemon").toLowerCase().includes("pokemon")
      ? "pokemon"
      : attrs.category?.toLowerCase() ?? null,
    itemType: "card",
    grader: attrs.grader ?? null,
    grade: attrs.grade ?? null,
    gradeNum: gradeNum != null && Number.isFinite(gradeNum) ? gradeNum : null,
    language: attrs.language ?? null,
    setRaw: attrs["set name"] ?? null,
    cardNumber: attrs["card number"] ?? null,
    year: attrs.year ? Number(attrs.year) : null,
    confidence: null,
    canonical: null,
    contractAddress:
      typeof row.creatorAddress === "string" ? row.creatorAddress : null,
    searchBlob: meta.name ?? null,
    raw,
  };
}

export function normalizeRenaissRow(
  row: Record<string, unknown>,
  providerId = "renaiss",
): Listing | null {
  const askRaw = row.askPriceInUSDT;
  if (askRaw == null || askRaw === "NO-ASK-PRICE" || askRaw === "") return null;
  let price = Number(askRaw);
  if (!Number.isFinite(price) || price <= 0) return null;
  // Wei-scale USDT (1e18)
  if (price > 1e12) price = price / 1e18;
  price = Math.round(price * 100) / 100;
  if (price <= 0) return null;
  const nativeId = String(row.id ?? row.tokenId ?? "");
  if (!nativeId) return null;
  const fmvRaw = row.fmvPriceInUSD;
  const fmv =
    fmvRaw == null || fmvRaw === "" || fmvRaw === "NO-FMV"
      ? null
      : Number(fmvRaw);
  const name = String(row.name ?? nativeId);
  const gradeStr = row.grade != null ? String(row.grade) : null;
  const gradeNumMatch = gradeStr?.match(/([\d.]+)/);
  return {
    id: listingId({ provider: providerId, platform: "renaiss", nativeId }),
    provider: providerId,
    platform: "renaiss",
    nativeId,
    tokenId: row.tokenId != null ? String(row.tokenId) : null,
    name,
    price,
    currency: "USDC",
    fmv: fmv != null && Number.isFinite(fmv) ? fmv : null,
    delta: deltaFromListing(price, fmv, "USDC"),
    market: "Renaiss",
    seller: (row.ownerAddress as string) ?? null,
    // Prefer origin URL; else construct public /card/{tokenId} page.
    externalUrl:
      originProvidedUrl(row) ??
      renaissListingUrl(
        row.tokenId != null ? String(row.tokenId) : null,
      ),
    imageUrl: (row.frontImageUrl as string) ?? null,
    listedAt: null,
    firstListedAt: null,
    lastEvent: "LIST",
    tcg: "pokemon",
    itemType: "card",
    grader: (row.gradingCompany as string) ?? null,
    grade: gradeStr,
    gradeNum: gradeNumMatch ? Number(gradeNumMatch[1]) : null,
    language: null,
    setRaw: (row.setName as string) ?? null,
    cardNumber: (row.cardNumber as string) ?? null,
    year: row.year == null ? null : Number(row.year),
    confidence: null,
    canonical: null,
    contractAddress: null,
    searchBlob: name,
    raw: row,
  };
}

export function normalizeDyliRow(
  row: Record<string, unknown>,
  providerId = "dyli",
): Listing | null {
  const price = Number(row.lowest_price ?? row.price ?? 0);
  if (!Number.isFinite(price) || price <= 0) return null;
  const nativeId = String(row.id ?? "");
  if (!nativeId) return null;
  const name = String(row.name ?? nativeId);
  return {
    id: listingId({ provider: providerId, platform: "dyli", nativeId }),
    provider: providerId,
    platform: "dyli",
    nativeId,
    tokenId: null,
    name,
    price,
    currency: "USDC",
    fmv: null,
    delta: null,
    market: "DYLI",
    seller: null,
    // Prefer origin URL; else construct public /p/{id} (Next /p/[slug] route).
    externalUrl: originProvidedUrl(row) ?? dyliListingUrl(nativeId),
    imageUrl: (row.image as string) ?? (row.image_url as string) ?? null,
    listedAt: null,
    firstListedAt: null,
    lastEvent: "LIST",
    tcg: null,
    itemType: "card",
    grader: row.cert != null ? String(row.cert) : null,
    grade: null,
    gradeNum: null,
    language: null,
    setRaw: (row.brand as string) ?? null,
    cardNumber: null,
    year: null,
    confidence: null,
    canonical: null,
    contractAddress: null,
    searchBlob: name,
    raw: row,
  };
}

function extractRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of [
      "dropItems",
      "products",
      "listings",
      "items",
      "data",
      "results",
      "rows",
      "cards",
      "collection",
    ]) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
    }
    // tRPC envelope
    const result = o.result as { data?: { json?: { collection?: unknown[] } } } | undefined;
    const col = result?.data?.json?.collection;
    if (Array.isArray(col)) return col as Record<string, unknown>[];
  }
  return [];
}

/**
 * Pagination caps (bootstrap / pullAll). Documented in docs/BOOTSTRAP_FULL_BOOK.md.
 * - Beezie: fixed ~20 rows per POST page; API ignores client limit.
 * - Phygitals: itemsPerPage max 200 (docs); page is 0-based.
 * - Both: hard page ceiling so cold pulls never run unbounded.
 */
export const BEEZIE_PAGE_SIZE = 20;
/** Beezie Solana page size — API accepts up to 100 (verified live). */
export const BEEZIE_SOLANA_PAGE_SIZE = 100;
export const PHYGITALS_MAX_ITEMS_PER_PAGE = 200;
export const PHYGITALS_DEFAULT_PAGE_SIZE = 24;
/**
 * Hard cap on multi-page walks for Beezie / Phygitals (pullPages / pullAll).
 * High enough for full-universe cold seeds; still stops on !hasMore / empty.
 * ~500 × 200 items/page Phygitals ≈ 100k rows safety ceiling.
 */
export const LONGTAIL_MAX_PAGES_CAP = 500;
/** Default maxPages when pullPages is called without maxPages or limit-derived plan. */
export const LONGTAIL_DEFAULT_MAX_PAGES = 1;

export class LongtailProvider implements ListingsProvider {
  readonly id: string;
  private readonly platform: string;
  private readonly baseUrl: string;
  private readonly listingPath: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  readonly statusNote: string;
  private readonly beezieCategoryId: string;
  private readonly allBeezieCategories: boolean;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly apiKey: string | undefined;
  private readonly pageConcurrency: AdaptiveConcurrencyOptions;
  /** Last concurrent page-walk stats (Phygitals/Beezie multi-page). */
  lastPageWalkStats: {
    pagesAttempted: number;
    pagesOk: number;
    throttles: number;
    peakConcurrency: number;
    wallMs: number;
  } | null = null;
  /** Diagnostics from last Beezie network pull. */
  lastBeezieMeta: BeeziePullMeta | null = null;
  /**
   * Soft-fail detail for the last pull (Phygitals 5xx / network).
   * Null after a successful listing page. MultiSourceRadar copies this into
   * `errors` so one origin outage never aborts the fan-out.
   */
  lastError: string | null = null;
  /** Last listing URL attempted (debug / operators). */
  lastUrl: string | null = null;
  /** Most recent response ETag when origin provides one (soft). */
  lastEtag: string | null = null;
  /** Last ETag per URL for If-None-Match on GET pulls. */
  private readonly etagByUrl = new Map<string, string>();

  constructor(opts: LongtailOptions) {
    const d = DEFAULTS[opts.id];
    this.id = opts.id;
    this.platform = opts.id;
    this.baseUrl = opts.baseUrl ?? d.baseUrl;
    this.listingPath = opts.listingPath ?? d.listingPath;
    this.userAgent =
      opts.userAgent ??
      (opts.id === "phygitals"
        ? "Mozilla/5.0 (compatible; traded-listings/0.3; +phygitals)"
        : `traded-listings/0.3 (+${opts.id})`);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.statusNote = opts.statusNote ?? d.note;
    this.beezieCategoryId = opts.beezieCategoryId ?? "1";
    this.allBeezieCategories = opts.allBeezieCategories ?? false;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
    this.pageConcurrency = opts.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
    this.apiKey =
      opts.apiKey ??
      (typeof process !== "undefined"
        ? process.env?.PHYGITALS_API_KEY
        : undefined);
  }

  async pull(query: PullQuery = {}): Promise<PullPage> {
    this.lastError = null;
    this.lastUrl = null;
    if (query.fixturePath) {
      const text = await readFile(query.fixturePath, "utf8");
      const rows = extractRows(JSON.parse(text));
      const listings = rows
        .map((r) => normalizeLongtailRow(r, this.id, this.platform))
        .filter((x): x is Listing => x != null)
        .slice(0, query.limit ?? 100);
      if (this.id === "beezie" || this.id === "beezie-solana") {
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
      return emptyMeta(this.id, listings, false);
    }
    if (query.offline) {
      throw new Error(
        `${this.id}: offline without fixture — ${this.statusNote}`,
      );
    }

    if (this.id === "beezie") return this.pullBeezie(query);
    if (this.id === "beezie-solana") return this.pullBeezie(query);
    if (this.id === "renaiss") return this.pullRenaiss(query);
    if (this.id === "dyli") return this.pullDyli(query);
    return this.pullPhygitals(query);
  }

  /**
   * Multi-page pull for APIs that support it (Beezie, Phygitals).
   * Other long-tail ids fall through to single `pull`.
   *
   * Caps: `maxPages` default {@link LONGTAIL_DEFAULT_MAX_PAGES}, hard ceiling
   * {@link LONGTAIL_MAX_PAGES_CAP}. Soft-fail mid-walk keeps rows already
   * collected; total soft-empty sets `lastError` and does not invent data.
   * Prefer {@link pullAll} for bootstrap so page count derives from `limit`.
   */
  async pullPages(
    query: PullQuery & { maxPages?: number } = {},
  ): Promise<PullPage> {
    if (query.fixturePath || query.offline) {
      return this.pull(query);
    }
    if (this.id === "beezie" || this.id === "beezie-solana") {
      return this.pullBeeziePages(query);
    }
    if (this.id === "phygitals") {
      return this.pullPhygitalsPages(query);
    }
    return this.pull(query);
  }

  /**
   * Bootstrap / fuller pull used by `syncOnce` when present.
   * Beezie + Phygitals paginate until `limit` (or maxPages / !hasMore / cap).
   * `bootstrap: true` raises the page plan to {@link LONGTAIL_MAX_PAGES_CAP}
   * when limit/maxPages are omitted. Single page when derived maxPages === 1.
   * Renaiss/DYLI stay single-page.
   */
  async pullAll(
    query: PullQuery & { maxPages?: number } = {},
  ): Promise<PullPage> {
    if (query.fixturePath || query.offline) {
      return this.pull(query);
    }
    if (
      (this.id === "beezie" || this.id === "beezie-solana") &&
      this.allBeezieCategories
    ) {
      return this.pullBeezieAllCategories(query);
    }
    if (
      this.id !== "beezie" &&
      this.id !== "beezie-solana" &&
      this.id !== "phygitals"
    ) {
      return this.pull(query);
    }

    const bootstrap = Boolean(query.bootstrap);
    const hasExplicitMaxPages =
      query.maxPages != null && Number.isFinite(query.maxPages);
    const pageSize =
      this.id === "beezie-solana"
        ? BEEZIE_SOLANA_PAGE_SIZE
        : this.id === "beezie"
          ? BEEZIE_PAGE_SIZE
          : Math.min(
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
    const desired =
      query.limit != null && Number.isFinite(query.limit) && query.limit > 0
        ? Math.floor(query.limit)
        : bootstrap || hasExplicitMaxPages
          ? Number.POSITIVE_INFINITY
          : pageSize;
    const derivedPages = Number.isFinite(desired)
      ? Math.max(1, Math.ceil((desired as number) / pageSize))
      : LONGTAIL_MAX_PAGES_CAP;
    const maxPages = Math.min(
      LONGTAIL_MAX_PAGES_CAP,
      Math.max(
        1,
        hasExplicitMaxPages
          ? Math.floor(query.maxPages!)
          : bootstrap
            ? LONGTAIL_MAX_PAGES_CAP
            : derivedPages,
      ),
    );

    if (maxPages === 1) {
      return this.pull({
        ...query,
        limit: Number.isFinite(desired)
          ? Math.min(desired as number, pageSize)
          : pageSize,
        offset: query.offset ?? 0,
      });
    }

    const page = await this.pullPages({
      ...query,
      limit: Number.isFinite(desired) ? (desired as number) : pageSize * maxPages,
      maxPages,
    });
    if (Number.isFinite(desired) && page.listings.length > (desired as number)) {
      return { ...page, listings: page.listings.slice(0, desired as number) };
    }
    return page;
  }

  /** Beezie page walk: fixed page size, API pages 1-based (EVM) / 0-based (Solana). */
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
    const all: Listing[] = [];
    const counts = emptyChainCounts();
    const solana = this.id === "beezie-solana";
    let page = solana ? 0 : 1;
    let total: number | null = null;
    let lastPageSize = pageSize;
    let hasMore = false;
    let partialError: string | null = null;

    // EVM pages are 1-based (inclusive cap maxPages); Solana 0-based (exclusive cap)
    for (; page < (solana ? maxPages : maxPages + 1); page++) {
      try {
        const one = await this.pullBeezie({
          ...query,
          categoryId,
          offset: solana ? page * pageSize : (page - 1) * pageSize,
          limit: undefined, // API ignores limit; fixed page size
        });
        lastPageSize = one.listings.length || pageSize;
        if (one.meta.total != null) total = one.meta.total;
        for (const l of one.listings) {
          all.push(l);
          const raw = l.raw as { chain?: BeezieChain } | undefined;
          const c = raw?.chain ?? "unknown";
          counts[c] = (counts[c] ?? 0) + 1;
        }
        hasMore = one.hasMore;
        if (!one.hasMore || one.listings.length === 0) break;
        if (clientLimit != null && all.length >= clientLimit) break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Soft-fail: keep prior pages; never throw away a partial multi-page book
        if (all.length === 0) {
          this.lastError = `beezie soft-fail page ${page}: ${msg} — ${this.statusNote}`;
          return emptyMeta(this.id, [], false, 0, { softFail: true });
        }
        partialError = msg;
        this.lastError = `beezie partial multi-page after ${all.length} rows (page ${page}): ${msg}`;
        hasMore = true;
        break;
      }
    }

    const listings =
      clientLimit != null ? all.slice(0, clientLimit) : all;
    if (!partialError) this.lastError = null;
    this.lastBeezieMeta = {
      page: Math.min(page, maxPages),
      pageSize: lastPageSize,
      total,
      chainCounts: counts,
      dominantChain: dominantChain(counts),
    };
    return emptyMeta(
      this.id,
      listings,
      hasMore && (clientLimit == null || all.length < (total ?? Infinity)),
      total ?? listings.length,
    );
  }

  /**
   * Walk **all** Beezie categories (GET /dropItems/categories) and merge into
   * one PullPage (single store scope). A category that fails marks the walk
   * incomplete (hasMore=true → sync upserts, never prunes); total soft-fail
   * (all categories fail) returns an empty soft page.
   */
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
    for (const c of cats) {
      try {
        const one = await this.pullBeeziePages({
          ...query,
          categoryId: String(c.id),
          limit: undefined,
          maxPages: maxPagesPerCat,
        });
        // pullBeeziePages swallows per-page errors: detect via soft/partial
        // page markers instead of exceptions.
        const softEmpty = one.meta.builtAt === null && one.listings.length === 0;
        if (softEmpty) {
          failures.push(
            `${c.name || c.id}: ${this.lastError ?? "soft-fail empty"}`,
          );
          continue;
        }
        if (one.hasMore) failures.push(`${c.name || c.id}: partial walk`);
        if (one.listings.length > 0) anyOk = true;
        total += one.meta.total ?? one.listings.length;
        all.push(...one.listings);
      } catch (e) {
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

  /** GET /dropItems/categories → enabled category ids + names. */
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

  /**
   * Phygitals page walk: 0-based `page`, `itemsPerPage` ≤ 200.
   * First page sequential; remaining concurrent with adaptive concurrency.
   */
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

  /** Conditional GET: honor If-None-Match / 304 when origin supports ETag. */
  private async fetchGetJson(
    url: string,
    ifNoneMatch?: string | null,
  ): Promise<
    | { notModified: true; etag: string | null }
    | { notModified: false; body: unknown; etag: string | null }
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
      throw new Error(`HTTP ${res.status} ${url} — ${this.statusNote}`);
    }
    const etag = getResponseEtag(res);
    if (etag) {
      this.etagByUrl.set(url, etag);
      this.lastEtag = etag;
    }
    return { notModified: false, body: await res.json(), etag };
  }

  private notModifiedPage(etag: string | null): PullPage {
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
        etag,
      },
    };
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

  private async pullRenaiss(query: PullQuery): Promise<PullPage> {
    const limit = query.limit ?? 20;
    const input = encodeURIComponent(JSON.stringify({ json: { limit: Math.max(limit, 50) } }));
    const url = `${this.baseUrl}${this.listingPath}?input=${input}`;
    const result = await this.fetchGetJson(url, query.ifNoneMatch);
    if (result.notModified) return this.notModifiedPage(result.etag);
    const rows = extractRows(result.body);
    const listings = rows
      .map((r) => normalizeRenaissRow(r, this.id))
      .filter((x): x is Listing => x != null)
      .slice(0, limit);
    return emptyMeta(this.id, listings, rows.length >= limit, listings.length, {
      etag: result.etag,
    });
  }

  private async pullDyli(query: PullQuery): Promise<PullPage> {
    let path = this.listingPath;
    if (query.q) {
      path = `/api/search/products?searchTerm=${encodeURIComponent(query.q)}`;
    }
    const url = new URL(
      path,
      this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/",
    );
    if (query.limit && !query.q) url.searchParams.set("limit", String(query.limit));
    const result = await this.fetchGetJson(url.toString(), query.ifNoneMatch);
    if (result.notModified) return this.notModifiedPage(result.etag);
    const json = result.body as {
      products?: Record<string, unknown>[];
      hasMore?: boolean;
    };
    const rows = json.products ?? extractRows(json);
    const listings = rows
      .map((r) => normalizeDyliRow(r, this.id))
      .filter((x): x is Listing => x != null)
      .slice(0, query.limit ?? 50);
    return emptyMeta(
      this.id,
      listings,
      Boolean(json.hasMore),
      listings.length,
      { etag: result.etag },
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

  /**
   * Phygitals marketplace-listings (Public API, no key required).
   * Uses documented query params (page / itemsPerPage / listedStatus=listed).
   * Wrong shapes (bare limit/offset) often 500 on origin.
   * Retries with exponential backoff via fetchWithRetry; on total failure
   * soft-returns empty + lastError so MultiSourceRadar continues and
   * syncOnce does **not** prune prior scope (soft_fail_no_prune).
   * A successful complete listed page (hasMore false) participates in
   * poll-diff delist: absences may prune via replaceScopeSnapshot.
   */
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

export function createBeezieProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new LongtailProvider({ ...opts, id: "beezie" });
}
/**
 * Beezie **Solana** marketplace (solana.beezie.com, API solana-api.beezie.com).
 * Solana mints + USDC SellOrders; pokemon = categoryId "1".
 * Live market is thin (verified ~2 active listings, 2026-08) — pulls are cheap.
 */
export function createBeezieSolanaProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new LongtailProvider({ ...opts, id: "beezie-solana" });
}
export function createRenaissProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new LongtailProvider({ ...opts, id: "renaiss" });
}
export function createDyliProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new LongtailProvider({ ...opts, id: "dyli" });
}
export function createPhygitalsProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new LongtailProvider({ ...opts, id: "phygitals" });
}
