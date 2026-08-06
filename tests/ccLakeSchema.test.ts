import { describe, expect, it } from "vitest";
import {
  lakeListingFromCcCard,
  lakeOffersFromCcOffers,
  summarizeLakeMintBids,
  type CcLakeCardLike,
} from "../src/providers/ccLakeSchema.js";

const card: CcLakeCardLike = {
  id: "c1",
  nftAddress: "MintA",
  itemName: "Card A",
  category: "Pokemon",
  set: "Base",
  year: 1999,
  gradingCompany: "PSA",
  grade: "10",
  gradeNum: 10,
  serial: "4",
  insuredValue: 1000,
  suggestPrice: 990,
  nftStatus: "Valid",
  vault: "PWCC",
  status: "Transferred",
  owner: { wallet: "Owner1" },
  listing: {
    price: 1100,
    currency: "USDC",
    createdAt: "2026-08-01T00:00:00.000Z",
    receiptId: "v2_abc",
  },
  offers: [{ id: "o1" }, { id: "o2" }],
};

describe("ccLakeSchema 1:1 columns", () => {
  it("listing row matches insured parquet field set", () => {
    const row = lakeListingFromCcCard(card, {
      observed_at: "2026-08-06T00:00:00.000Z",
    });
    expect(row).toEqual({
      observed_at: "2026-08-06T00:00:00.000Z",
      nft_address: "MintA",
      card_id: "c1",
      insured_value_usd: 1000,
      ask_usd: 1100,
      currency: "USDC",
      has_listing: true,
      n_offers: 2,
      offer_ids: "o1|o2",
      suggest_price_usd: 990,
      item_name: "Card A",
      category: "Pokemon",
      set_name: "Base",
      year: 1999,
      grader: "PSA",
      grade: "10",
      grade_num: 10,
      serial: "4",
      listed_at: "2026-08-01T00:00:00.000Z",
      listing_receipt_id: "v2_abc",
      owner_wallet: "Owner1",
      status: "Transferred",
      nft_status: "Valid",
      vault: "PWCC",
    });
  });

  it("offer long + mint summary match offers parquet fields", () => {
    const priced = [
      {
        id: "bid1",
        price: "850",
        currency: "USDC",
        status: "Active",
        buyer: { wallet: "W1", name: "bot" },
        createdAt: "2026-08-05T00:00:00.000Z",
      },
      {
        id: "bid2",
        price: "900",
        currency: "USDC",
        status: "Active",
        buyer: { wallet: "W2", name: "BEST OFFER" },
      },
    ];
    const long = lakeOffersFromCcOffers(card, priced, {
      observed_at: "t0",
    });
    expect(long).toHaveLength(2);
    expect(long[1]).toMatchObject({
      nft_address: "MintA",
      offer_id: "bid2",
      price_usd: 900,
      buyer_wallet: "W2",
      bid_over_insured: 0.9,
      insured_value_usd: 1000,
      ask_usd: 1100,
    });
    const sum = summarizeLakeMintBids(card, long, { observed_at: "t0" });
    expect(sum.best_bid_usd).toBe(900);
    expect(sum.n_active_bids).toBe(2);
    expect(sum.best_bid_over_insured).toBe(0.9);
    expect(sum.best_buyer_wallet).toBe("W2");
    expect(sum.ask_over_insured).toBe(1.1);
  });
});
