import type { Listing } from "./types.js";

/**
 * Ensure `lastSeenAt` is set. Does not overwrite a non-empty existing value.
 * Prefer `fetchedAt` from the apply/snapshot when stamping page rows.
 */
export function withLastSeenAt<T extends Pick<Listing, "lastSeenAt">>(
  listing: T,
  fetchedAt: string,
): T {
  const cur = listing.lastSeenAt;
  if (cur != null && cur !== "") return listing;
  return { ...listing, lastSeenAt: fetchedAt };
}

/** Age in ms from lastSeenAt, or null when unknown / unparseable. */
export function listingAgeMs(
  listing: Pick<Listing, "lastSeenAt">,
  nowMs: number = Date.now(),
): number | null {
  const raw = listing.lastSeenAt;
  if (raw == null || raw === "") return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return Math.max(0, nowMs - t);
}

/**
 * True when the listing is older than maxAgeMs (or has no usable lastSeenAt).
 * Host UIs should grey-out stale rows after soft-fail windows when age exceeds
 * the trader's maxAgeMs policy (e.g. 2–3× poll interval).
 */
export function isStale(
  listing: Pick<Listing, "lastSeenAt">,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!(maxAgeMs >= 0) || !Number.isFinite(maxAgeMs)) return false;
  const age = listingAgeMs(listing, nowMs);
  if (age == null) return true;
  return age > maxAgeMs;
}
