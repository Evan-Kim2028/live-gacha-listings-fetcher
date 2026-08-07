/**
 * Single-page venues: Renaiss (tRPC collectible.list) and DYLI (/api/explore).
 */
import {
  emptyMeta,
  extractRows,
  LongtailOptions,
  LongtailProvider,
  normalizeDyliRow,
  normalizeRenaissRow,
} from "./longtailCommon.js";
import type { Listing } from "../types.js";
import type { PullPage, PullQuery } from "./types.js";

/**
 * Single-page venues: Renaiss (tRPC collectible.list) and DYLI (/api/explore).
 */
export class RenaissProvider extends LongtailProvider {
  protected override async pullVenue(query: PullQuery): Promise<PullPage> {
    return this.pullRenaiss(query);
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
}

export class DyliProvider extends LongtailProvider {
  protected override async pullVenue(query: PullQuery): Promise<PullPage> {
    return this.pullDyli(query);
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
}


export function createRenaissProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new RenaissProvider({ ...opts, id: "renaiss" });
}
export function createDyliProvider(
  opts: Omit<LongtailOptions, "id"> = {},
): LongtailProvider {
  return new DyliProvider({ ...opts, id: "dyli" });
}
