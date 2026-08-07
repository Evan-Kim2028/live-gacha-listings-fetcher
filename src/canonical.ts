/**
 * Cross-venue card identity (#5): the same physical card exists on several
 * venues with DIFFERENT ids (CC mint, ME mint, Courtyard proofOfIntegrity,
 * Beezie tokenId). No shared canonical id is populated by the origins today
 * (`canonical.scrydex_id` is null), so clustering matches on
 * tcg + normalized name + grader + grade — the same fallback
 * `instrumentKeyFromListing` uses to merge asks in the orderbook.
 */
import type { Listing } from "./types.js";

/** Deterministic cross-venue cluster key: tcg|name|grader|grade. */
export function cardClusterKey(listing: Listing): string {
  const name = (listing.name || "unknown").toLowerCase().slice(0, 80);
  const tcg = listing.tcg ?? "unk";
  const grade = listing.gradeNum ?? listing.grade ?? "raw";
  const grader = listing.grader ?? "raw";
  return `${tcg}|${name}|${grader}|${grade}`.toLowerCase();
}

/** Group listings into same-card clusters (across venues). */
export function clusterListings(
  listings: Iterable<Listing>,
): Map<string, Listing[]> {
  const out = new Map<string, Listing[]>();
  for (const l of listings) {
    const key = cardClusterKey(l);
    const arr = out.get(key);
    if (arr) arr.push(l);
    else out.set(key, [l]);
  }
  return out;
}

/**
 * Every listing across venues that is the same physical card as the given
 * token (by cluster). Empty when the token is unknown or not in the set.
 */
export function sameCardListings(
  tokenId: string,
  listings: Iterable<Listing>,
): Listing[] {
  const clusters = clusterListings(listings);
  let key: string | null = null;
  for (const [k, arr] of clusters) {
    if (arr.some((l) => l.tokenId === tokenId)) {
      key = k;
      break;
    }
  }
  return key ? (clusters.get(key) ?? []) : [];
}
