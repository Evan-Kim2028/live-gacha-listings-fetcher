import type { Listing } from "../types.js";

/**
 * Group listings into orderbook instruments.
 * Prefer canonical scrydex id; fall back to tcg|name|grade|grader.
 */
export function instrumentKeyFromListing(listing: Listing): string {
  const scry = listing.canonical?.scrydex_id;
  if (scry && String(scry).trim()) {
    const grade = listing.gradeNum ?? listing.grade ?? "raw";
    const grader = listing.grader ?? "raw";
    return `scry:${scry}|${grader}|${grade}`.toLowerCase();
  }
  const name = (listing.name || "unknown").toLowerCase().slice(0, 80);
  const tcg = listing.tcg ?? "unk";
  const grade = listing.gradeNum ?? listing.grade ?? "raw";
  const grader = listing.grader ?? "raw";
  return `name:${tcg}|${name}|${grader}|${grade}`;
}
