import { beforeAll, describe, expect, it } from "vitest";
import {
  identityFromListing,
  identityFromTitle,
  identityKey,
  identityKeyFromListing,
  seedSetDictionary,
} from "../src/cardIdentity.js";
import { sameCardListings } from "../src/canonical.js";
import type { Listing } from "../src/types.js";

function listing(over: Partial<Listing> & { id: string; tokenId: string; name: string }): Listing {
  return {
    provider: "x", platform: "x", nativeId: over.id, price: 10, currency: "USDC",
    fmv: null, delta: null, market: "X", seller: null, externalUrl: null,
    imageUrl: null, listedAt: null, firstListedAt: null, lastEvent: "LIST",
    tcg: "pokemon", itemType: "card", grader: null, grade: null, gradeNum: null,
    language: null, setRaw: null, cardNumber: null, year: null, confidence: null,
    canonical: null, contractAddress: null, searchBlob: over.name,
    ...over,
  };
}

describe("TCG identity (roadmap #2)", () => {
  beforeAll(() => {
    seedSetDictionary(["Evolutions", "Base Set", "Obsidian Flames", "Pokemon 151"]);
  });

  it("parses Beezie-style titles", () => {
    const id = identityFromTitle("2016 Evolutions Charizard EX #12 PSA 9");
    expect(id.year).toBe(2016);
    expect(id.set).toBe("Evolutions");
    expect(id.number).toBe("12");
    // name = pre-# remainder minus set/year, grader/grade stripped from after
    expect(id.name).toContain("Charizard");
  });

  it("parses Courtyard-style titles with number/set and grade", () => {
    const id = identityFromTitle("1999 Base Set #10/102 Mewtwo - Holo (CGC 9.5 MINT+)");
    expect(id.year).toBe(1999);
    expect(id.set).toBe("Base Set");
    expect(id.number).toBe("10/102");
    expect(id.name).toBe("Mewtwo - Holo");
  });

  it("uses structured attributes when present (exact)", () => {
    const l = listing({
      id: "1", tokenId: "mint1", name: "Whatever",
      raw: {
        metadata: {
          attributes: [
            { trait_type: "year", trait_value: "2023" },
            { trait_type: "grader", trait_value: "PSA" },
            { trait_type: "grade", trait_value: "10" },
            { trait_type: "pokemon name", trait_value: "Charizard ex" },
            { trait_type: "set name", trait_value: "Obsidian Flames" },
            { trait_type: "card number", trait_value: "228" },
            { trait_type: "language", trait_value: "Japanese" },
          ],
        },
      },
    });
    const id = identityFromListing(l);
    expect(id.name).toBe("Charizard ex");
    expect(id.set).toBe("Obsidian Flames");
    expect(id.number).toBe("228");
    expect(id.year).toBe(2023);
    expect(id.language).toBe("Japanese");
  });

  it("identity key is grade-agnostic: PSA 9 and CGC 9 cluster as one card", () => {
    const a = identityKeyFromListing(listing({ id: "a", tokenId: "m1", name: "2016 Evolutions Charizard EX #12 PSA 9", grader: "PSA", grade: "9" }))!;
    const b = identityKeyFromListing(listing({ id: "b", tokenId: "m2", name: "2016 Evolutions Charizard EX #12 CGC 9", grader: "CGC", grade: "9" }))!;
    expect(a).toBe(b);
    // ...but a different set does NOT cluster
    const c = identityKeyFromListing(listing({ id: "c", tokenId: "m3", name: "2023 Obsidian Flames Charizard EX #228 PSA 9", grader: "PSA", grade: "9" }))!;
    expect(c).not.toBe(a);
  });

  it("sameCardListings clusters across venues via identity, not just name", () => {
    const rows = [
      listing({ id: "cc", tokenId: "mintA", name: "2016 Evolutions Charizard EX #12 PSA 9", provider: "collectorcrypt" }),
      listing({ id: "me", tokenId: "mintB", name: "2016 Evolutions Charizard EX #12 CGC 9", provider: "magiceden" }),
      listing({ id: "other", tokenId: "mintC", name: "2023 Obsidian Flames Charizard EX #228 PSA 9", provider: "courtyard" }),
    ];
    const same = sameCardListings("mintA", rows);
    expect(same.map((l) => l.tokenId).sort()).toEqual(["mintA", "mintB"]);
  });

  it("sealed products yield no identity", () => {
    const id = identityFromListing(listing({ id: "s", tokenId: "s1", name: "Pokémon Japanese Sword & Shield Explosive Walker (1 Booster Pack - Art May Vary)" }));
    expect(id.sealed).toBe(true);
    expect(identityKeyFromListing(listing({ id: "s", tokenId: "s1", name: "Pokémon Japanese Sword & Shield Explosive Walker (1 Booster Pack - Art May Vary)" }))).toBeNull();
    expect(identityKey(id)).toBeTruthy(); // key still exists for identity() (sealed) — but unused
  });
});
