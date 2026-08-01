import type { Listing } from "../types.js";
import { instrumentKeyFromListing } from "./instrument.js";
import type { AskOrder } from "./types.js";

/** Map a listing to an ask order (sell-side of the book). */
export function listingToAsk(listing: Listing): AskOrder {
  return {
    id: `ask:${listing.id}`,
    provider: listing.provider,
    instrumentKey: instrumentKeyFromListing(listing),
    nativeId: listing.nativeId,
    side: "ask",
    price: listing.price,
    size: 1,
    currency: listing.currency,
    seller: listing.seller,
    platform: listing.platform,
    listingId: listing.id,
    updatedAt: listing.listedAt ?? new Date().toISOString(),
    raw: listing,
  };
}

export function listingsToAsks(listings: Listing[]): AskOrder[] {
  return listings.map(listingToAsk);
}
