import type { Listing } from "./types.js";
import type { PullQuery } from "./providers/types.js";
import { listingMatchesWatchlist } from "./watchlist.js";

/**
 * Whether a listing matches a decision subset filter.
 * Used for client-side SSE filtering (stream is global) and local views.
 * Optional `filter.watchlist` applies {@link listingMatchesWatchlist} (OR criteria).
 */
export function listingMatchesFilter(
  listing: Listing,
  filter: PullQuery = {},
): boolean {
  // Missing tcg (common on ME/long-tail) does not exclude — providers already best-effort filter
  if (
    filter.tcg &&
    listing.tcg &&
    listing.tcg.toLowerCase() !== filter.tcg.toLowerCase()
  ) {
    return false;
  }
  if (
    filter.platform &&
    listing.platform.toLowerCase() !== filter.platform.toLowerCase()
  ) {
    return false;
  }
  if (
    filter.itemType &&
    (listing.itemType ?? "").toLowerCase() !== filter.itemType.toLowerCase()
  ) {
    return false;
  }
  if (
    filter.grader &&
    (listing.grader ?? "").toLowerCase() !== filter.grader.toLowerCase()
  ) {
    return false;
  }
  if (filter.grade != null && filter.grade !== "") {
    const g = listing.grade ?? "";
    const gn = listing.gradeNum;
    if (g !== filter.grade && String(gn) !== String(filter.grade)) {
      // allow "10" to match grade_num 10
      if (!(gn != null && String(gn) === String(filter.grade))) return false;
    }
  }
  if (
    filter.language &&
    (listing.language ?? "").toUpperCase() !== filter.language.toUpperCase()
  ) {
    return false;
  }
  if (filter.priceMin != null && listing.price < filter.priceMin) return false;
  if (filter.priceMax != null && listing.price > filter.priceMax) return false;
  if (filter.yearMin != null && (listing.year == null || listing.year < filter.yearMin)) {
    return false;
  }
  if (filter.yearMax != null && (listing.year == null || listing.year > filter.yearMax)) {
    return false;
  }
  if (filter.requireFmv && listing.fmv == null) return false;
  if (filter.maxDelta != null) {
    if (listing.delta == null || listing.delta > filter.maxDelta) return false;
  }
  if (filter.canonical === "yes" && !listing.canonical) return false;
  if (filter.canonical === "no" && listing.canonical) return false;
  if (filter.q) {
    const hay = `${listing.name} ${listing.setRaw ?? ""} ${listing.searchBlob ?? ""}`.toLowerCase();
    const parts = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.some((p) => !hay.includes(p))) return false;
  }
  // activity is event-ish; approximate via lastEvent
  if (filter.activity) {
    const a = filter.activity.toLowerCase();
    const ev = (listing.lastEvent ?? "").toLowerCase();
    if (a === "new" && ev !== "list") return false;
    if (a === "reprice" && ev !== "price_update") return false;
    if (a === "drop") {
      // drop ≈ reprice with negative delta
      if (listing.delta == null || listing.delta >= 0) return false;
    }
  }
  if (filter.watchlist && !listingMatchesWatchlist(listing, filter.watchlist)) {
    return false;
  }
  return true;
}

export function filterListings(
  listings: Listing[],
  filter: PullQuery = {},
): Listing[] {
  return listings.filter((l) => listingMatchesFilter(l, filter));
}
