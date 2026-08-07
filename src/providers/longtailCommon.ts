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
import {
  DEFAULT_PAGE_CONCURRENCY,
  type AdaptiveConcurrencyOptions,
} from "../http/pageConcurrency.js";
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

export const PHYGITALS_FILTERS_PATH = "/api/marketplace/filters";

/** Browser-like headers — site JS calls api.phygitals.com from www.phygitals.com. */
export const PHYGITALS_BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json",
  Origin: "https://www.phygitals.com",
  Referer: "https://www.phygitals.com/",
  "Accept-Language": "en-US,en;q=0.9",
};

export type PhygitalsFiltersPayload = {
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

export function emptyChainCounts(): Record<BeezieChain, number> {
  return { evm: 0, solana: 0, unknown: 0 };
}

export function dominantChain(
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
export function emptyMeta(
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
    // SellOrder.createdAt is the earliest list time the API exposes — it IS
    // the first-known listing, so age tracking works without prior history.
    firstListedAt:
      sell.createdAt != null ? new Date(Number(sell.createdAt)).toISOString() : null,
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

export function extractRows(body: unknown): Record<string, unknown>[] {
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

/**
 * Shared scaffold for the long-tail venues (Beezie Base/Solana, Renaiss, DYLI,
 * Phygitals). One base class owns transport, diagnostics, fixture handling and
 * the page-walk planner; each venue subclass overrides pullVenue /
 * pullVenuePages / pullVenueAll (+ walkPageSize) so no id-switch dispatchers
 * are needed.
 */
export class LongtailProvider implements ListingsProvider {
  readonly id: string;
  private readonly platform: string;
  protected readonly baseUrl: string;
  protected readonly listingPath: string;
  protected readonly userAgent: string;
  protected readonly fetchImpl: typeof fetch;
  readonly statusNote: string;
  protected readonly maxRetries: number;
  protected readonly retryDelayMs: number;
  protected readonly apiKey: string | undefined;
  protected readonly pageConcurrency: AdaptiveConcurrencyOptions;
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
  protected readonly etagByUrl = new Map<string, string>();

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
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
    this.pageConcurrency = opts.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
    this.apiKey =
      opts.apiKey ??
      (typeof process !== "undefined"
        ? process.env?.PHYGITALS_API_KEY
        : undefined);
  }

  /**
   * Venue single-page pull. Subclasses override; base throws so a venue
   * without an implementation fails loudly instead of returning nothing.
   */
  protected async pullVenue(_query: PullQuery): Promise<PullPage> {
    throw new Error(
      `${this.id}: live pull not implemented — ${this.statusNote}`,
    );
  }

  /** Post-normalize hook for fixture pulls (Beezie chain diagnostics). */
  protected fixtureHook(_listings: Listing[]): void {}

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
      this.fixtureHook(listings);
      return emptyMeta(this.id, listings, false);
    }
    if (query.offline) {
      throw new Error(
        `${this.id}: offline without fixture — ${this.statusNote}`,
      );
    }
    return this.pullVenue(query);
  }

  /**
   * Multi-page pull for venues that support it (Beezie, Phygitals).
   * Other long-tail ids fall through to single `pull`.
   *
   * Caps: `maxPages` default {@link LONGTAIL_DEFAULT_MAX_PAGES}, hard ceiling
   * {@link LONGTAIL_MAX_PAGES_CAP}. Soft-fail mid-walk keeps rows already
   * collected; total soft-empty sets `lastError` and does not invent data.
   */
  async pullPages(
    query: PullQuery & { maxPages?: number } = {},
  ): Promise<PullPage> {
    if (query.fixturePath || query.offline) {
      return this.pull(query);
    }
    return this.pullVenuePages(query);
  }

  /** Venue multi-page walk. Base = single page. */
  protected async pullVenuePages(
    query: PullQuery & { maxPages?: number },
  ): Promise<PullPage> {
    return this.pullVenue(query);
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
    return this.pullVenueAll(query);
  }

  /** Venue full-book strategy. Base = multi-page (or single when no walk). */
  protected async pullVenueAll(
    query: PullQuery & { maxPages?: number },
  ): Promise<PullPage> {
    return this.pullVenuePages(query);
  }

  /** Rows per page for the shared planner (Beezie/Phygitals override). */
  protected walkPageSize(_query: PullQuery): number {
    return 1;
  }

  /**
   * Shared page-plan (used by Beezie + Phygitals `pullAll`):
   * derive maxPages from limit/bootstrap/maxPages, single-pull when the plan
   * is one page, else delegate to the venue page walk and slice to limit.
   */
  protected async runPlannedWalk(
    query: PullQuery & { maxPages?: number },
    pageSize: number,
  ): Promise<PullPage> {
    const bootstrap = Boolean(query.bootstrap);
    const hasExplicitMaxPages =
      query.maxPages != null && Number.isFinite(query.maxPages);
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

    const page = await this.pullVenuePages({
      ...query,
      limit: Number.isFinite(desired) ? (desired as number) : pageSize * maxPages,
      maxPages,
    });
    if (Number.isFinite(desired) && page.listings.length > (desired as number)) {
      return { ...page, listings: page.listings.slice(0, desired as number) };
    }
    return page;
  }

  protected async fetchGetJson(
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

  protected notModifiedPage(etag: string | null): PullPage {
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
}

