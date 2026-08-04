/**
 * Trader-facing listing deep-links (read-only).
 *
 * Prefer {@link Listing.externalUrl}; otherwise reconstruct public marketplace
 * pages from provider/platform + ids via `externalUrl.ts` builders.
 *
 * **Hard rule:** open-in-browser only. No transaction building, private keys,
 * place-order, buy/list/offer, or wallet signing.
 */

import type { Listing } from "../types.js";
import {
  ccListingUrl,
  courtyardListingUrl,
  dyliListingUrl,
  formatOpenCommand,
  meListingUrl,
  phygitalsListingUrl,
  renaissListingUrl,
} from "../externalUrl.js";

/** Minimal listing shape needed to resolve an open URL. */
export type ListingOpenUrlInput = Pick<
  Listing,
  "externalUrl" | "provider" | "platform" | "nativeId" | "tokenId"
>;

function isHttpUrl(s: string | null | undefined): s is string {
  return typeof s === "string" && /^https?:\/\//i.test(s.trim());
}

/**
 * Public listing page URL for operators / host UIs.
 *
 * 1. Prefer `listing.externalUrl` when it is http(s).
 * 2. Else construct from provider/platform using known origin patterns.
 * 3. Else null (beezie / fixture / unknown without origin URL).
 */
export function listingOpenUrl(listing: ListingOpenUrlInput): string | null {
  if (isHttpUrl(listing.externalUrl)) {
    return listing.externalUrl!.trim();
  }

  const platform = (listing.platform ?? "").trim().toLowerCase();
  const provider = (listing.provider ?? "").trim().toLowerCase();
  const mintOrToken = listing.tokenId;
  const nativeId = listing.nativeId;

  // Match on platform first (canonical), then provider id.
  const key = platform || provider;

  switch (key) {
    case "cc":
    case "collectorcrypt":
      // Prefer mint (tokenId); catalog card id on same path when mint missing.
      return ccListingUrl(mintOrToken) ?? ccListingUrl(nativeId);

    case "me":
    case "magiceden":
      return meListingUrl(mintOrToken) ?? meListingUrl(nativeId);

    case "courtyard":
      return courtyardListingUrl(mintOrToken) ?? courtyardListingUrl(nativeId);

    case "phygitals":
      return phygitalsListingUrl(nativeId) ?? phygitalsListingUrl(mintOrToken);

    case "renaiss":
      // Public path uses on-chain tokenId when present.
      return renaissListingUrl(mintOrToken) ?? renaissListingUrl(nativeId);

    case "dyli":
      return dyliListingUrl(nativeId) ?? dyliListingUrl(mintOrToken);

    // beezie / fixture / unknown: no stable construct without origin URL
    default:
      return null;
  }
}

/**
 * CLI-friendly shell open hint for a listing (deep-link only).
 * e.g. `open 'https://…'` / `xdg-open 'https://…'` / `cmd /c start "" '…'`.
 * Returns null when no public URL can be resolved.
 */
export function formatOpenHint(
  listing: ListingOpenUrlInput,
  opts?: { platform?: NodeJS.Platform },
): string | null {
  return formatOpenCommand(listingOpenUrl(listing), opts);
}
