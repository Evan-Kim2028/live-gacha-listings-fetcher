import { describe, expect, it } from "vitest";
import { listingId } from "../src/identity.js";
import {
  formatOpenHint,
  listingOpenUrl,
} from "../src/trader/deepLinks.js";
import {
  formatOpenCommand,
  meListingUrl,
  ccListingUrl,
} from "../src/externalUrl.js";
import type { Listing } from "../src/types.js";

function L(
  partial: Partial<Listing> &
    Pick<Listing, "platform" | "nativeId"> & { provider?: string },
): Listing {
  const provider = partial.provider ?? "fixture";
  return {
    id: listingId({
      provider,
      platform: partial.platform,
      nativeId: partial.nativeId,
    }),
    provider,
    tokenId: null,
    name: partial.name ?? "Card",
    price: partial.price ?? 10,
    currency: "USDC",
    fmv: null,
    delta: null,
    market: null,
    seller: null,
    externalUrl: null,
    imageUrl: null,
    listedAt: null,
    firstListedAt: null,
    lastEvent: null,
    tcg: "pokemon",
    itemType: "card",
    grader: null,
    grade: null,
    gradeNum: null,
    language: null,
    setRaw: null,
    cardNumber: null,
    year: null,
    confidence: null,
    canonical: null,
    contractAddress: null,
    ...partial,
  };
}

describe("listingOpenUrl (prefer externalUrl; fallback builders)", () => {
  it("prefers listing.externalUrl when http(s)", () => {
    const l = L({
      provider: "magiceden",
      platform: "me",
      nativeId: "Mint1",
      tokenId: "Mint1",
      externalUrl: "https://collectorcrypt.com/assets/solana/Mint1",
    });
    expect(listingOpenUrl(l)).toBe(
      "https://collectorcrypt.com/assets/solana/Mint1",
    );
  });

  it("rejects non-http externalUrl and falls back to builder", () => {
    const l = L({
      provider: "magiceden",
      platform: "me",
      nativeId: "Mint2",
      tokenId: "Mint2",
      externalUrl: "not-a-url",
    });
    expect(listingOpenUrl(l)).toBe(meListingUrl("Mint2"));
  });

  it("CC: rebuilds from tokenId then nativeId", () => {
    expect(
      listingOpenUrl(
        L({
          provider: "collectorcrypt",
          platform: "cc",
          nativeId: "card_1",
          tokenId: "MintCC",
          externalUrl: null,
        }),
      ),
    ).toBe(ccListingUrl("MintCC"));

    expect(
      listingOpenUrl(
        L({
          provider: "collectorcrypt",
          platform: "cc",
          nativeId: "card_only",
          tokenId: null,
          externalUrl: null,
        }),
      ),
    ).toBe(ccListingUrl("card_only"));
  });

  it("ME / courtyard / phygitals / renaiss / dyli rebuild when externalUrl null", () => {
    expect(
      listingOpenUrl(
        L({
          provider: "magiceden",
          platform: "me",
          nativeId: "pda1",
          tokenId: "MintME",
        }),
      ),
    ).toBe("https://magiceden.io/item-details/MintME");

    expect(
      listingOpenUrl(
        L({
          provider: "courtyard",
          platform: "courtyard",
          nativeId: "tok-cy",
          tokenId: "tok-cy",
        }),
      ),
    ).toBe("https://courtyard.io/asset/tok-cy");

    expect(
      listingOpenUrl(
        L({
          provider: "phygitals",
          platform: "phygitals",
          nativeId: "slug-or-mint",
        }),
      ),
    ).toBe("https://www.phygitals.com/card/slug-or-mint");

    expect(
      listingOpenUrl(
        L({
          provider: "renaiss",
          platform: "renaiss",
          nativeId: "uuid-not-path",
          tokenId: "7441145821947309",
        }),
      ),
    ).toBe("https://www.renaiss.xyz/card/7441145821947309");

    expect(
      listingOpenUrl(
        L({
          provider: "dyli",
          platform: "dyli",
          nativeId: "34073",
        }),
      ),
    ).toBe("https://www.dyli.io/p/34073");
  });

  it("beezie / unknown without externalUrl → null", () => {
    expect(
      listingOpenUrl(
        L({
          provider: "beezie",
          platform: "beezie",
          nativeId: "99",
          externalUrl: null,
        }),
      ),
    ).toBeNull();

    expect(
      listingOpenUrl(
        L({
          provider: "fixture",
          platform: "fixture",
          nativeId: "x",
          externalUrl: null,
        }),
      ),
    ).toBeNull();
  });

  it("matches provider id when platform empty-ish via provider fallback", () => {
    // platform still required by identity; use provider-key path via platform=provider slug
    expect(
      listingOpenUrl(
        L({
          provider: "collectorcrypt",
          platform: "collectorcrypt",
          nativeId: "N1",
          tokenId: "N1",
        }),
      ),
    ).toBe(ccListingUrl("N1"));
  });
});

describe("formatOpenHint (CLI deep-link only)", () => {
  it("returns platform open shell string from resolved URL", () => {
    const l = L({
      provider: "collectorcrypt",
      platform: "cc",
      nativeId: "MintX",
      tokenId: "MintX",
      externalUrl: "https://collectorcrypt.com/cards/MintX",
    });
    expect(formatOpenHint(l, { platform: "linux" })).toBe(
      `xdg-open 'https://collectorcrypt.com/cards/MintX'`,
    );
    expect(formatOpenHint(l, { platform: "darwin" })).toBe(
      `open 'https://collectorcrypt.com/cards/MintX'`,
    );
    expect(formatOpenHint(l, { platform: "linux" })).toBe(
      formatOpenCommand(listingOpenUrl(l), { platform: "linux" }),
    );
  });

  it("null when no URL resolvable", () => {
    expect(
      formatOpenHint(
        L({ provider: "beezie", platform: "beezie", nativeId: "1" }),
        { platform: "linux" },
      ),
    ).toBeNull();
  });
});
