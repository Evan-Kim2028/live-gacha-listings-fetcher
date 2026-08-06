/**
 * Collector Crypt row shapes aligned 1:1 with lake-of-rage parquet columns
 * (poll_cc_insured_snapshots + poll_cc_card_offers).
 *
 * Snake_case field names match Python writers exactly so radar export /
 * consumers can join without renames.
 */
import type { BidOrder } from "../orderbook/types.js";
import type { Listing } from "../types.js";

/** Minimal card/offer shapes (avoid circular import with collectorcrypt.ts). */
export interface CcLakeCardLike {
  id?: string;
  itemName?: string;
  nftAddress?: string;
  category?: string;
  year?: number;
  grade?: string;
  gradeNum?: number;
  gradingCompany?: string;
  listedAt?: string;
  status?: string;
  set?: string;
  serial?: string;
  insuredValue?: string | number;
  suggestPrice?: string | number;
  nftStatus?: string;
  vault?: string;
  listing?: {
    createdAt?: string;
    currency?: string;
    price?: string | number;
    receiptId?: string;
    sellerId?: string;
    marketplace?: string;
  } | null;
  offers?: CcLakeOfferLike[] | null;
  owner?: { wallet?: string; name?: string; id?: string };
  [key: string]: unknown;
}

export interface CcLakeOfferLike {
  id?: string;
  price?: string | number;
  currency?: string;
  buyer?: string | { wallet?: string; name?: string | null; id?: string } | null;
  buyerId?: string;
  buyerWallet?: string;
  wallet?: string;
  status?: string;
  cardId?: string;
  createdAt?: string;
  updatedAt?: string;
  expiryDate?: number | string;
  receiptId?: string | null;
  [key: string]: unknown;
}

function parseFloatish(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function offerIdsPipe(card: CcLakeCardLike): string | null {
  const offers = card.offers ?? [];
  const ids: string[] = [];
  for (const o of offers) {
    if (o?.id) ids.push(String(o.id));
  }
  return ids.length ? ids.join("|") : null;
}

function countOfferRefsLocal(card: CcLakeCardLike): { refs: number; priced: number } {
  const offers = card.offers ?? [];
  let priced = 0;
  let refs = 0;
  for (const o of offers) {
    if (!o?.id) continue;
    refs += 1;
    const p = o.price == null ? null : Number(o.price);
    if (p != null && Number.isFinite(p) && p > 0) priced += 1;
  }
  return { refs, priced };
}

function bidderFromOfferLocal(o: CcLakeOfferLike): string | null {
  if (o.buyerWallet) return String(o.buyerWallet);
  if (o.wallet) return String(o.wallet);
  if (typeof o.buyer === "string" && o.buyer) return o.buyer;
  if (o.buyer && typeof o.buyer === "object" && o.buyer.wallet) {
    return String(o.buyer.wallet);
  }
  if (o.buyerId) return String(o.buyerId);
  return null;
}

/** One row = insured browse snapshot (Python `insured/latest.parquet`). */
export interface CcLakeListingRow {
  observed_at: string;
  nft_address: string;
  card_id: string;
  insured_value_usd: number | null;
  ask_usd: number | null;
  currency: string;
  has_listing: boolean;
  n_offers: number;
  offer_ids: string | null;
  suggest_price_usd: number | null;
  item_name: string | null;
  category: string | null;
  set_name: string | null;
  year: number | null;
  grader: string | null;
  grade: string | null;
  grade_num: number | null;
  serial: string | null;
  listed_at: string | null;
  listing_receipt_id: string | null;
  owner_wallet: string | null;
  status: string | null;
  nft_status: string | null;
  vault: string | null;
}

/** One row = single priced offer (Python `offers/latest_offers.parquet`). */
export interface CcLakeOfferRow {
  observed_at: string;
  nft_address: string;
  card_id: string | null;
  offer_id: string | null;
  price_usd: number | null;
  currency: string;
  status: string | null;
  buyer_wallet: string | null;
  buyer_name: string | null;
  created_at: string | null;
  expiry_date: number | string | null;
  receipt_id: string | null;
  insured_value_usd: number | null;
  ask_usd: number | null;
  item_name: string | null;
  category: string | null;
  bid_over_insured: number | null;
}

/** One row = mint bid summary (Python `offers/latest_by_mint.parquet`). */
export interface CcLakeMintBidSummary {
  observed_at: string;
  nft_address: string;
  card_id: string | null;
  item_name: string | null;
  category: string | null;
  insured_value_usd: number | null;
  ask_usd: number | null;
  n_offers_raw: number;
  n_active_bids: number;
  best_bid_usd: number | null;
  median_bid_usd: number | null;
  best_bid_over_insured: number | null;
  ask_over_insured: number | null;
  best_buyer_wallet: string | null;
  buyer_wallets: string | null;
}

export interface CcLakeContext {
  observed_at?: string;
  /** When true, emit listing rows for unlisted cards too (full insured book). */
  includeUnlisted?: boolean;
}

function observedNow(ctx?: CcLakeContext): string {
  return ctx?.observed_at ?? new Date().toISOString();
}

/**
 * Build lake listing row from a browse card.
 * Default: only when an ask exists (radar Buy-now path).
 * `includeUnlisted: true` matches full insured catalog export.
 */
export function lakeListingFromCcCard(
  card: CcLakeCardLike,
  ctx: CcLakeContext = {},
): CcLakeListingRow | null {
  const listing = card.listing ?? null;
  const ask = listing?.price != null ? parseFloatish(listing.price) : null;
  const hasListing = ask != null && Number.isFinite(ask) && ask > 0;
  if (!hasListing && !ctx.includeUnlisted) return null;

  const mint = (card.nftAddress ?? "").trim();
  const cardId = (card.id ?? "").trim();
  if (!mint && !cardId) return null;

  const refs = countOfferRefsLocal(card);
  const insured = parseFloatish(card.insuredValue);

  return {
    observed_at: observedNow(ctx),
    nft_address: mint,
    card_id: cardId,
    insured_value_usd: insured,
    ask_usd: hasListing ? ask : null,
    currency: (listing?.currency ?? "USDC").toString(),
    has_listing: hasListing,
    n_offers: refs.refs,
    offer_ids: offerIdsPipe(card),
    suggest_price_usd: parseFloatish(card.suggestPrice),
    item_name: card.itemName ?? null,
    category: card.category ?? null,
    set_name: card.set ?? null,
    year: card.year == null ? null : Number(card.year),
    grader: card.gradingCompany ?? null,
    grade: card.grade ?? null,
    grade_num: card.gradeNum == null ? null : Number(card.gradeNum),
    serial: card.serial ?? null,
    listed_at: listing?.createdAt ?? card.listedAt ?? null,
    listing_receipt_id: listing?.receiptId ?? null,
    owner_wallet: card.owner?.wallet ?? null,
    status: card.status ?? null,
    nft_status: card.nftStatus ?? null,
    vault: card.vault ?? null,
  };
}

export function lakeOfferFromCcOffer(
  o: CcLakeOfferLike,
  card: CcLakeCardLike,
  ctx: CcLakeContext = {},
): CcLakeOfferRow | null {
  if (!o?.id && o?.price == null) return null;
  const price = parseFloatish(o.price);
  const status = (o.status ?? null) as string | null;
  // Match Python: keep all rows; active filter is for summary
  if (price != null && price <= 0) return null;

  const buyer = o.buyer && typeof o.buyer === "object" ? o.buyer : null;
  const buyer_wallet = bidderFromOfferLocal(o);
  const buyer_name =
    buyer && typeof buyer.name === "string" ? buyer.name : null;
  const insured = parseFloatish(card.insuredValue);
  const ask =
    card.listing?.price != null ? parseFloatish(card.listing.price) : null;
  const mint = (card.nftAddress ?? "").trim();

  let bid_over_insured: number | null = null;
  if (price != null && price > 0 && insured != null && insured > 0) {
    bid_over_insured = price / insured;
  }

  return {
    observed_at: observedNow(ctx),
    nft_address: mint,
    card_id: card.id ?? (o.cardId != null ? String(o.cardId) : null),
    offer_id: o.id != null ? String(o.id) : null,
    price_usd: price,
    currency: (o.currency ?? "USDC").toString(),
    status,
    buyer_wallet,
    buyer_name,
    created_at: typeof o.createdAt === "string" ? o.createdAt : null,
    expiry_date: o.expiryDate ?? null,
    receipt_id: o.receiptId != null ? String(o.receiptId) : null,
    insured_value_usd: insured,
    ask_usd: ask,
    item_name: card.itemName ?? null,
    category: card.category ?? null,
    bid_over_insured,
  };
}

export function lakeOffersFromCcOffers(
  card: CcLakeCardLike,
  offers: CcLakeOfferLike[],
  ctx: CcLakeContext = {},
): CcLakeOfferRow[] {
  const out: CcLakeOfferRow[] = [];
  for (const o of offers) {
    const row = lakeOfferFromCcOffer(o, card, ctx);
    if (row) out.push(row);
  }
  return out;
}

export function summarizeLakeMintBids(
  card: CcLakeCardLike,
  offerRows: CcLakeOfferRow[],
  ctx: CcLakeContext = {},
): CcLakeMintBidSummary {
  const active = offerRows.filter((r) => {
    const st = (r.status ?? "Active").toString().toLowerCase();
    return (
      r.price_usd != null &&
      r.price_usd > 0 &&
      (st === "active" || st === "open" || st === "")
    );
  });
  const prices = active
    .map((r) => r.price_usd!)
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  const best = prices.length ? prices[prices.length - 1]! : null;
  const median = prices.length
    ? prices[Math.floor(prices.length / 2)]!
    : null;
  const insured = parseFloatish(card.insuredValue);
  const ask =
    card.listing?.price != null ? parseFloatish(card.listing.price) : null;
  const buyers = active
    .map((r) => r.buyer_wallet)
    .filter((w): w is string => Boolean(w));
  let best_buyer: string | null = null;
  if (best != null) {
    const hit = active.find((r) => r.price_usd === best && r.buyer_wallet);
    best_buyer = hit?.buyer_wallet ?? buyers[0] ?? null;
  }

  return {
    observed_at: observedNow(ctx),
    nft_address: (card.nftAddress ?? "").trim(),
    card_id: card.id ?? null,
    item_name: card.itemName ?? null,
    category: card.category ?? null,
    insured_value_usd: insured,
    ask_usd: ask,
    n_offers_raw: offerRows.length,
    n_active_bids: prices.length,
    best_bid_usd: best,
    median_bid_usd: median,
    best_bid_over_insured:
      best != null && insured != null && insured > 0 ? best / insured : null,
    ask_over_insured:
      ask != null && insured != null && insured > 0 ? ask / insured : null,
    best_buyer_wallet: best_buyer,
    buyer_wallets: buyers.length
      ? [...new Set(buyers)].join("|")
      : null,
  };
}

/** Attach lake listing columns onto a normalized Listing.raw */
export function attachLakeListingToRaw(
  listing: Listing,
  lake: CcLakeListingRow,
): Listing {
  const prev =
    listing.raw && typeof listing.raw === "object"
      ? (listing.raw as Record<string, unknown>)
      : {};
  return {
    ...listing,
    raw: {
      ...prev,
      // exact lake columns (1:1 with insured parquet)
      lake_listing: lake,
      n_offers: lake.n_offers,
      offer_ids: lake.offer_ids,
      offerCount: lake.n_offers,
      has_listing: lake.has_listing,
      insured_value_usd: lake.insured_value_usd,
      ask_usd: lake.ask_usd,
      suggest_price_usd: lake.suggest_price_usd,
      nft_status: lake.nft_status,
      vault: lake.vault,
      listing_receipt_id: lake.listing_receipt_id,
      owner_wallet: lake.owner_wallet,
    },
  };
}

/** Attach lake offer columns onto a BidOrder.raw */
export function attachLakeOfferToRaw(
  bid: BidOrder,
  lake: CcLakeOfferRow,
): BidOrder {
  const prev =
    bid.raw && typeof bid.raw === "object"
      ? (bid.raw as Record<string, unknown>)
      : {};
  return {
    ...bid,
    raw: {
      ...prev,
      lake_offer: lake,
      price_usd: lake.price_usd,
      buyer_wallet: lake.buyer_wallet,
      buyer_name: lake.buyer_name,
      bid_over_insured: lake.bid_over_insured,
      insured_value_usd: lake.insured_value_usd,
      ask_usd: lake.ask_usd,
      offer_id: lake.offer_id,
      status: lake.status,
      created_at: lake.created_at,
      expiry_date: lake.expiry_date,
      receipt_id: lake.receipt_id,
      nft_address: lake.nft_address,
      card_id: lake.card_id,
    },
  };
}

/** Pull lake listing rows out of a store Listing list. */
export function extractLakeListings(listings: Listing[]): CcLakeListingRow[] {
  const out: CcLakeListingRow[] = [];
  for (const l of listings) {
    const raw = l.raw as { lake_listing?: CcLakeListingRow } | undefined;
    if (raw?.lake_listing) out.push(raw.lake_listing);
  }
  return out;
}

/** Pull lake offer rows out of BidOrders. */
export function extractLakeOffers(bids: BidOrder[]): CcLakeOfferRow[] {
  const out: CcLakeOfferRow[] = [];
  for (const b of bids) {
    const raw = b.raw as { lake_offer?: CcLakeOfferRow } | undefined;
    if (raw?.lake_offer) out.push(raw.lake_offer);
  }
  return out;
}
