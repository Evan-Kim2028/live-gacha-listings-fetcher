import type { Listing } from "../types.js";
import type { FmvProvider } from "./FmvProvider.js";

export type FixtureFmvLookup =
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number>>
  | ((listing: Listing) => number | null | undefined);

/**
 * In-memory / test-only FMV plugin. No network.
 * Map keys are listing `id` values unless a function lookup is supplied.
 */
export class FixtureFmvProvider implements FmvProvider {
  readonly id: string;

  constructor(
    private readonly lookup: FixtureFmvLookup,
    opts?: { id?: string },
  ) {
    this.id = opts?.id ?? "fixture_fmv";
  }

  enrich(listing: Listing): Listing {
    const fmv = this.resolve(listing);
    if (fmv == null || !Number.isFinite(fmv)) return listing;
    return { ...listing, fmv };
  }

  enrichMany(listings: Listing[]): Listing[] {
    return listings.map((l) => this.enrich(l));
  }

  private resolve(listing: Listing): number | null | undefined {
    const lu = this.lookup;
    if (typeof lu === "function") {
      return lu(listing);
    }
    if (lu instanceof Map) {
      return lu.get(listing.id);
    }
    const rec = lu as Readonly<Record<string, number>>;
    return rec[listing.id];
  }
}
