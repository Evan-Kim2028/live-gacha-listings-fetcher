import { readFile } from "node:fs/promises";
import { filterListings } from "../filter.js";
import { listingId } from "../identity.js";
import type { CanonicalCard, Listing } from "../types.js";
import type { ListingsProvider, PullPage, PullQuery } from "./types.js";

const DEFAULT_BASE = "https://www.traded.gg";

/** Raw radar row fields (public API). */
export interface TradedRadarRow {
  instance_id: string;
  platform: string;
  token_id?: string | null;
  seller?: string | null;
  market?: string | null;
  contract_address?: string | null;
  name?: string | null;
  image_url?: string | null;
  external_url?: string | null;
  price?: number | null;
  price_native?: number | null;
  price_converted?: boolean | null;
  currency?: string | null;
  fmv?: number | null;
  delta?: number | null;
  listed_at?: string | null;
  first_listed_at?: string | null;
  grader?: string | null;
  grade?: string | null;
  grade_num?: number | null;
  tcg?: string | null;
  item_type?: string | null;
  language?: string | null;
  set_raw?: string | null;
  card_number?: string | null;
  year?: number | null;
  confidence?: number | null;
  canonical?: CanonicalCard | null;
  last_event?: string | null;
  prev_price?: number | null;
  raw_name?: string | null;
  search?: string | null;
}

export interface TradedRadarResponse {
  total?: number;
  universe?: number;
  builtAt?: string;
  facets?: unknown;
  rows?: TradedRadarRow[];
}

export interface TradedGgOptions {
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  /** Default page size when query.limit omitted */
  defaultLimit?: number;
}

/**
 * Normalize a traded.gg radar row into the shared Listing model.
 * Pure function — unit-testable without network.
 */
export function normalizeTradedRow(
  row: TradedRadarRow,
  providerId = "tradedgg",
): Listing {
  if (!row?.instance_id || !row?.platform) {
    throw new Error("traded.gg row missing instance_id or platform");
  }
  const price = Number(row.price ?? row.price_native ?? NaN);
  if (!Number.isFinite(price)) {
    throw new Error(`traded.gg row ${row.instance_id} missing numeric price`);
  }
  const id = listingId({
    provider: providerId,
    platform: row.platform,
    nativeId: row.instance_id,
  });
  return {
    id,
    provider: providerId,
    platform: row.platform,
    nativeId: row.instance_id,
    tokenId: row.token_id ?? null,
    name: (row.name ?? row.raw_name ?? "").toString(),
    price,
    currency: (row.currency ?? "USDC").toString(),
    fmv: row.fmv == null ? null : Number(row.fmv),
    delta: row.delta == null ? null : Number(row.delta),
    market: row.market ?? null,
    seller: row.seller ?? null,
    externalUrl: row.external_url ?? null,
    imageUrl: row.image_url ?? null,
    listedAt: row.listed_at ?? null,
    firstListedAt: row.first_listed_at ?? null,
    lastEvent: row.last_event ?? null,
    tcg: row.tcg ?? null,
    itemType: row.item_type ?? null,
    grader: row.grader ?? null,
    grade: row.grade ?? null,
    gradeNum: row.grade_num == null ? null : Number(row.grade_num),
    language: row.language ?? null,
    setRaw: row.set_raw ?? null,
    cardNumber: row.card_number ?? null,
    year: row.year == null ? null : Number(row.year),
    confidence: row.confidence == null ? null : Number(row.confidence),
    canonical: row.canonical ?? null,
    contractAddress: row.contract_address ?? null,
    searchBlob: row.search ?? null,
    raw: row,
  };
}

function buildRadarUrl(baseUrl: string, query: PullQuery = {}): string {
  const u = new URL("/api/radar", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  const limit = query.limit ?? 300;
  u.searchParams.set("limit", String(limit));
  if (query.offset != null) u.searchParams.set("offset", String(query.offset));
  if (query.sort) u.searchParams.set("sort", query.sort);
  if (query.tcg) u.searchParams.set("tcg", query.tcg);
  if (query.q) u.searchParams.set("q", query.q);
  if (query.platform) u.searchParams.set("platform", query.platform);
  // Server-side filters (from reverse-eng)
  if (query.itemType) u.searchParams.set("itemType", query.itemType);
  if (query.grader) u.searchParams.set("grader", query.grader);
  if (query.grade != null && query.grade !== "") {
    u.searchParams.set("grade", String(query.grade));
  }
  if (query.language) u.searchParams.set("language", query.language);
  if (query.activity) u.searchParams.set("activity", query.activity);
  if (query.canonical) u.searchParams.set("canonical", query.canonical);
  if (query.priceMin != null) u.searchParams.set("priceMin", String(query.priceMin));
  if (query.priceMax != null) u.searchParams.set("priceMax", String(query.priceMax));
  if (query.yearMin != null) u.searchParams.set("yearMin", String(query.yearMin));
  if (query.yearMax != null) u.searchParams.set("yearMax", String(query.yearMax));
  return u.toString();
}

export class TradedGgProvider implements ListingsProvider {
  readonly id = "tradedgg";
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultLimit: number;

  constructor(opts: TradedGgOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.userAgent = opts.userAgent ?? "traded-listings/0.1 (+trading-lib)";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.defaultLimit = opts.defaultLimit ?? 300;
  }

  async pull(query: PullQuery = {}): Promise<PullPage> {
    const q = { ...query, limit: query.limit ?? this.defaultLimit };
    let body: TradedRadarResponse;

    if (q.fixturePath) {
      const text = await readFile(q.fixturePath, "utf8");
      body = JSON.parse(text) as TradedRadarResponse;
    } else if (q.offline) {
      throw new Error("TradedGgProvider: offline=true but no fixturePath");
    } else {
      const url = buildRadarUrl(this.baseUrl, q);
      const res = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": this.userAgent,
        },
      });
      if (!res.ok) {
        throw new Error(`traded.gg radar HTTP ${res.status} for ${url}`);
      }
      body = (await res.json()) as TradedRadarResponse;
    }

    const rows = body.rows ?? [];
    // Server applies main filters; client-only filters (maxDelta, requireFmv) applied after.
    let listings = rows.map((r) => normalizeTradedRow(r, this.id));
    // Client-side subset filters (and fixture re-filter for local testing)
    if (
      q.fixturePath ||
      q.maxDelta != null ||
      q.requireFmv ||
      q.tcg ||
      q.platform ||
      q.itemType ||
      q.grader ||
      q.q
    ) {
      listings = filterListings(listings, q);
    }
    const offset = q.offset ?? 0;
    const total = body.total ?? listings.length;
    const hasMore = offset + listings.length < total;

    return {
      listings,
      hasMore,
      meta: {
        provider: this.id,
        builtAt: body.builtAt ?? null,
        total: body.total ?? null,
        universe: body.universe ?? null,
        fetchedAt: new Date().toISOString(),
        querySignature: "",
      },
    };
  }

  async pullAll(query: PullQuery = {}): Promise<PullPage> {
    // Fixture / single-shot: one page is enough when limit caps decision pull
    if (query.fixturePath || query.offline) {
      return this.pull(query);
    }
    const pageSize = query.limit ?? this.defaultLimit;
    // For decision path default: single page (fast). Caller can raise limit.
    // Full universe scan is optional via pullAll with explicit high maxPages.
    return this.pull({ ...query, limit: pageSize, offset: query.offset ?? 0 });
  }
}

export function createTradedGgProvider(opts?: TradedGgOptions): TradedGgProvider {
  return new TradedGgProvider(opts);
}
