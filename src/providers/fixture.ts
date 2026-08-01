import { readFile } from "node:fs/promises";
import { listingId } from "../identity.js";
import type { Listing } from "../types.js";
import type { ListingsProvider, PullPage, PullQuery } from "./types.js";

/**
 * Second source adapter: loads a local JSON array or { rows: [...] } file.
 * Proves the extension path without network or traded.gg coupling.
 *
 * Expected row shape (minimal):
 * { id?, platform, nativeId|instance_id, name, price, currency? }
 */
export interface FixtureRow {
  id?: string;
  platform: string;
  nativeId?: string;
  instance_id?: string;
  name: string;
  price: number;
  currency?: string;
  listed_at?: string;
  fmv?: number | null;
  market?: string | null;
  external_url?: string | null;
  tcg?: string | null;
}

export interface FixtureProviderOptions {
  /** Default path when query.fixturePath omitted */
  path: string;
  providerId?: string;
  builtAt?: string;
}

function normalizeFixtureRow(row: FixtureRow, providerId: string): Listing {
  const nativeId = (row.nativeId ?? row.instance_id ?? row.id ?? "").toString();
  if (!nativeId || !row.platform) {
    throw new Error("fixture row requires platform and nativeId|instance_id|id");
  }
  const id = listingId({
    provider: providerId,
    platform: row.platform,
    nativeId,
  });
  return {
    id,
    provider: providerId,
    platform: row.platform,
    nativeId,
    tokenId: null,
    name: row.name,
    price: Number(row.price),
    currency: row.currency ?? "USD",
    fmv: row.fmv ?? null,
    delta: null,
    market: row.market ?? null,
    seller: null,
    externalUrl: row.external_url ?? null,
    imageUrl: null,
    listedAt: row.listed_at ?? null,
    firstListedAt: null,
    lastEvent: null,
    tcg: row.tcg ?? null,
    itemType: null,
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
    searchBlob: null,
    raw: row,
  };
}

export class FixtureProvider implements ListingsProvider {
  readonly id: string;
  private readonly path: string;
  private readonly builtAt: string;

  constructor(opts: FixtureProviderOptions) {
    this.path = opts.path;
    this.id = opts.providerId ?? "fixture";
    this.builtAt = opts.builtAt ?? "1970-01-01T00:00:00.000Z";
  }

  async pull(query: PullQuery = {}): Promise<PullPage> {
    const path = query.fixturePath ?? this.path;
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as
      | FixtureRow[]
      | { rows?: FixtureRow[]; builtAt?: string; total?: number; universe?: number };

    const rows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
    let listings = rows.map((r) => normalizeFixtureRow(r, this.id));
    if (query.limit != null) {
      const offset = query.offset ?? 0;
      listings = listings.slice(offset, offset + query.limit);
    }
    const builtAt = Array.isArray(parsed)
      ? this.builtAt
      : (parsed.builtAt ?? this.builtAt);

    return {
      listings,
      hasMore: false,
      meta: {
        provider: this.id,
        builtAt,
        total: Array.isArray(parsed) ? rows.length : (parsed.total ?? rows.length),
        universe: Array.isArray(parsed) ? rows.length : (parsed.universe ?? rows.length),
        fetchedAt: new Date().toISOString(),
        querySignature: "",
      },
    };
  }
}

export function createFixtureProvider(opts: FixtureProviderOptions): FixtureProvider {
  return new FixtureProvider(opts);
}
