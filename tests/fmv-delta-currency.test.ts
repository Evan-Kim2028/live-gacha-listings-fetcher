import { describe, expect, it } from "vitest";
import {
  deltaFromListing,
  deltaFromPriceAndFmv,
  isUsdEquivalentCurrency,
} from "../src/fmv/index.js";
import { normalizeCcCard } from "../src/providers/collectorcrypt.js";

describe("isUsdEquivalentCurrency", () => {
  it("accepts USD-equivalent units case-insensitively", () => {
    for (const c of ["USDC", "usdc", " USDT ", "USD", "usd"]) {
      expect(isUsdEquivalentCurrency(c)).toBe(true);
    }
  });

  it("rejects native tokens and empties", () => {
    for (const c of ["SOL", "sol", "ETH", "APE", "", null, undefined]) {
      expect(isUsdEquivalentCurrency(c)).toBe(false);
    }
  });
});

describe("deltaFromListing", () => {
  it("matches deltaFromPriceAndFmv for USD-denominated prices", () => {
    expect(deltaFromListing(133, 100, "USDC")).toBe(
      deltaFromPriceAndFmv(133, 100),
    );
    expect(deltaFromListing(133, 100, "USDC")).toBe(33);
  });

  it("returns null for SOL prices instead of a fake discount", () => {
    // 2.5 SOL vs a $100 USD insured value would read as -97% if divided raw.
    expect(deltaFromPriceAndFmv(2.5, 100)).toBe(-97);
    expect(deltaFromListing(2.5, 100, "SOL")).toBeNull();
  });

  it("still returns null on missing / non-positive fmv", () => {
    expect(deltaFromListing(10, null, "USDC")).toBeNull();
    expect(deltaFromListing(10, 0, "USDC")).toBeNull();
    expect(deltaFromListing(10, Number.NaN, "USDC")).toBeNull();
  });
});

describe("collectorcrypt normalize", () => {
  const card = {
    id: "cc-1",
    itemName: "Charizard",
    nftAddress: "MintAddr1",
    insuredValue: "100",
  };

  it("computes delta for a USDC listing", () => {
    const l = normalizeCcCard({
      ...card,
      listing: { price: 133, currency: "USDC" },
    } as never);
    expect(l?.currency).toBe("USDC");
    expect(l?.fmv).toBe(100);
    expect(l?.delta).toBe(33);
  });

  it("keeps USD fmv but nulls delta for a SOL listing", () => {
    const l = normalizeCcCard({
      ...card,
      listing: { price: 2.5, currency: "SOL" },
    } as never);
    expect(l?.currency).toBe("SOL");
    expect(l?.fmv).toBe(100);
    expect(l?.delta).toBeNull();
  });
});
