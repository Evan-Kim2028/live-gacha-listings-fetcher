import { describe, expect, it } from "vitest";
import { listingId, parseListingId, sameListing } from "../src/identity.js";
import { normalizeTradedRow } from "../src/providers/tradedgg.js";
import type { TradedRadarRow } from "../src/providers/tradedgg.js";

describe("listingId identity attribution", () => {
  it("is deterministic for same source fields", () => {
    const a = listingId({
      provider: "tradedgg",
      platform: "courtyard",
      nativeId: "fcc81a2b-4d14-5122-8ccd-6bc916a59536",
    });
    const b = listingId({
      provider: "tradedgg",
      platform: "Courtyard",
      nativeId: "fcc81a2b-4d14-5122-8ccd-6bc916a59536",
    });
    expect(a).toBe(b);
    expect(a).toBe(
      "tradedgg:courtyard:fcc81a2b-4d14-5122-8ccd-6bc916a59536",
    );
  });

  it("differs across platforms with same native uuid", () => {
    const courtyard = listingId({
      provider: "tradedgg",
      platform: "courtyard",
      nativeId: "same-uuid",
    });
    const cc = listingId({
      provider: "tradedgg",
      platform: "cc",
      nativeId: "same-uuid",
    });
    expect(courtyard).not.toBe(cc);
  });

  it("does not use array index", () => {
    const id = listingId({
      provider: "tradedgg",
      platform: "cc",
      nativeId: "token-abc",
    });
    expect(id.includes("0")).toBe(false);
    expect(id).toBe("tradedgg:cc:token-abc");
  });

  it("round-trips parseListingId", () => {
    const id = listingId({
      provider: "tradedgg",
      platform: "beezie",
      nativeId: "x:y:z",
    });
    const parts = parseListingId(id);
    expect(parts.provider).toBe("tradedgg");
    expect(parts.platform).toBe("beezie");
    expect(parts.nativeId).toBe("x:y:z");
  });

  it("sameListing compares identity parts", () => {
    expect(
      sameListing(
        { provider: "tradedgg", platform: "cc", nativeId: "1" },
        { provider: "tradedgg", platform: "CC", nativeId: "1" },
      ),
    ).toBe(true);
  });

  it("normalizeTradedRow multi-platform fixture rows get stable distinct ids", () => {
    const base: TradedRadarRow = {
      instance_id: "id-1",
      platform: "courtyard",
      name: "A",
      price: 10,
      currency: "USDC",
    };
    const cy = normalizeTradedRow({ ...base, platform: "courtyard" });
    const cc = normalizeTradedRow({
      ...base,
      platform: "cc",
      instance_id: "id-2",
    });
    expect(cy.id).toBe("tradedgg:courtyard:id-1");
    expect(cc.id).toBe("tradedgg:cc:id-2");
    expect(cy.id).not.toBe(cc.id);
  });
});
