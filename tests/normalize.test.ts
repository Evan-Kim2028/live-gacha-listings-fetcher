import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeTradedRow,
  type TradedRadarResponse,
} from "../src/providers/tradedgg.js";
import { normalizeCcCard, type CcCard } from "../src/providers/collectorcrypt.js";
import { normalizeMeListing } from "../src/providers/magiceden.js";
import {
  normalizeBeezieRow,
  normalizeLongtailRow,
  normalizePhygitalsRow,
  normalizeRenaissRow,
  normalizeDyliRow,
} from "../src/providers/longtail.js";
import { listingId } from "../src/identity.js";
import {
  ccListingUrl,
  courtyardListingUrl,
  dyliListingUrl,
  formatOpenCommand,
  meListingUrl,
  originProvidedUrl,
  phygitalsListingUrl,
  renaissListingUrl,
} from "../src/externalUrl.js";
import { normalizeCourtyardRow } from "../src/providers/courtyard.js";

const fixturePath = join(__dirname, "..", "fixtures", "radar-sample.json");
const phyFixturePath = join(__dirname, "..", "fixtures", "phygitals-sample.json");
const beezieFixturePath = join(__dirname, "..", "fixtures", "beezie-sample.json");
const ccFixturePath = join(
  __dirname,
  "..",
  "fixtures",
  "collectorcrypt-sample.json",
);

describe("normalizeTradedRow against real fixture shape", () => {
  it("maps every fixture row to stable id + decision fields", () => {
    const body = JSON.parse(
      readFileSync(fixturePath, "utf8"),
    ) as TradedRadarResponse;
    expect(body.rows?.length).toBeGreaterThan(0);

    for (const row of body.rows!) {
      const listing = normalizeTradedRow(row);
      expect(listing.id).toBe(
        listingId({
          provider: "tradedgg",
          platform: row.platform,
          nativeId: row.instance_id,
        }),
      );
      expect(listing.price).toBeGreaterThan(0);
      expect(listing.platform).toBeTruthy();
      expect(listing.nativeId).toBe(row.instance_id);
      expect(listing.provider).toBe("tradedgg");
    }
  });
});

describe("externalUrl helpers + formatOpenCommand (deep-link only)", () => {
  it("builds CC / ME / Phygitals / Courtyard / Renaiss / DYLI public pages", () => {
    expect(ccListingUrl("MintABC")).toBe(
      "https://collectorcrypt.com/cards/MintABC",
    );
    expect(ccListingUrl(null)).toBeNull();
    expect(ccListingUrl("  ")).toBeNull();

    expect(meListingUrl("MintME")).toBe(
      "https://magiceden.io/item-details/MintME",
    );
    expect(meListingUrl("")).toBeNull();

    expect(phygitalsListingUrl("card-slug")).toBe(
      "https://www.phygitals.com/card/card-slug",
    );
    expect(phygitalsListingUrl("Addr111")).toBe(
      "https://www.phygitals.com/card/Addr111",
    );

    expect(courtyardListingUrl("tok1")).toBe(
      "https://courtyard.io/asset/tok1",
    );
    expect(courtyardListingUrl(null)).toBeNull();

    expect(renaissListingUrl("7441145821947309")).toBe(
      "https://www.renaiss.xyz/card/7441145821947309",
    );
    expect(renaissListingUrl("")).toBeNull();

    expect(dyliListingUrl(34073)).toBe("https://www.dyli.io/p/34073");
    expect(dyliListingUrl("d1")).toBe("https://www.dyli.io/p/d1");
    expect(dyliListingUrl(null)).toBeNull();
  });

  it("originProvidedUrl accepts http(s) fields only", () => {
    expect(
      originProvidedUrl({ url: "https://example.com/item/1" }),
    ).toBe("https://example.com/item/1");
    expect(originProvidedUrl({ external_url: "not-a-url" })).toBeNull();
    expect(originProvidedUrl({})).toBeNull();
  });

  it("formatOpenCommand is deep-link shell open (no tx)", () => {
    const url = "https://collectorcrypt.com/cards/Mint1";
    expect(formatOpenCommand(url, { platform: "linux" })).toBe(
      `xdg-open '${url}'`,
    );
    expect(formatOpenCommand(url, { platform: "darwin" })).toBe(
      `open '${url}'`,
    );
    expect(formatOpenCommand(url, { platform: "win32" })).toMatch(
      /^cmd \/c start "" '/,
    );
    expect(formatOpenCommand(null)).toBeNull();
    expect(formatOpenCommand("ftp://nope")).toBeNull();
    // shell-escape single quotes
    expect(formatOpenCommand("https://x.test/a'b", { platform: "linux" })).toBe(
      `xdg-open 'https://x.test/a'\\''b'`,
    );
  });
});

describe("normalize paths populate externalUrl when origin has public URL", () => {
  it("CC: externalUrl from nftAddress", () => {
    const card: CcCard = {
      id: "card_abc",
      itemName: "Test",
      nftAddress: "Mint111",
      category: "Pokemon",
      listing: {
        createdAt: "2026-08-01T00:00:00.000Z",
        currency: "USDC",
        price: 100,
        marketplace: "CC",
      },
    };
    const l = normalizeCcCard(card);
    expect(l).not.toBeNull();
    expect(l!.externalUrl).toBe(ccListingUrl("Mint111"));
    expect(l!.externalUrl).toMatch(/^https:\/\/collectorcrypt\.com\/cards\//);
    expect(formatOpenCommand(l!.externalUrl, { platform: "linux" })).toContain(
      "xdg-open",
    );
  });

  it("CC: externalUrl falls back to card id when mint missing", () => {
    const card: CcCard = {
      id: "card_no_mint",
      itemName: "No mint",
      listing: {
        createdAt: "2026-08-01T00:00:00.000Z",
        currency: "USDC",
        price: 10,
        marketplace: "CC",
      },
    };
    const l = normalizeCcCard(card);
    expect(l).not.toBeNull();
    // Documented /cards/{key} path; mint preferred, catalog id when mint absent.
    expect(l!.externalUrl).toBe(ccListingUrl("card_no_mint"));
    expect(l!.externalUrl).toBe(
      "https://collectorcrypt.com/cards/card_no_mint",
    );
    expect(formatOpenCommand(l!.externalUrl, { platform: "linux" })).toContain(
      "xdg-open",
    );
  });

  it("CC fixture rows always get clickable externalUrl", () => {
    const body = JSON.parse(
      readFileSync(ccFixturePath, "utf8"),
    ) as { filterNFtCard: CcCard[] };
    expect(body.filterNFtCard?.length).toBeGreaterThan(0);
    let normalized = 0;
    for (const card of body.filterNFtCard) {
      const l = normalizeCcCard(card);
      if (!l) continue;
      normalized += 1;
      expect(l.externalUrl).toMatch(
        /^https:\/\/collectorcrypt\.com\/cards\/.+/,
      );
      expect(formatOpenCommand(l.externalUrl)).toMatch(/^(xdg-open|open|cmd)/);
      if (card.nftAddress) {
        expect(l.externalUrl).toBe(ccListingUrl(card.nftAddress));
      } else {
        expect(l.externalUrl).toBe(ccListingUrl(card.id));
      }
    }
    expect(normalized).toBeGreaterThan(0);
  });

  it("ME: always mint page when token.externalUrl absent", () => {
    const n = normalizeMeListing(
      {
        tokenMint: "MintME1",
        price: 1,
        seller: "S1",
        pdaAddress: "Pda1",
        token: { name: "Card" },
      },
      { solPriceUsd: 100 },
    );
    expect(n).not.toBeNull();
    expect(n!.externalUrl).toBe(meListingUrl("MintME1"));
  });

  it("ME: prefers origin token.externalUrl when http(s)", () => {
    const n = normalizeMeListing(
      {
        tokenMint: "MintME2",
        price: 1,
        token: {
          name: "Card",
          externalUrl: "https://collectorcrypt.com/assets/solana/MintME2",
        },
      },
      { solPriceUsd: 100 },
    );
    expect(n!.externalUrl).toBe(
      "https://collectorcrypt.com/assets/solana/MintME2",
    );
  });

  it("ME: falls back when token.externalUrl is non-http", () => {
    const n = normalizeMeListing(
      {
        tokenMint: "MintME3",
        price: 1,
        token: { name: "Card", externalUrl: "relative/path" },
      },
      { solPriceUsd: 100 },
    );
    expect(n!.externalUrl).toBe(meListingUrl("MintME3"));
  });

  it("Phygitals: slug preferred; address fallback", () => {
    const withSlug = normalizePhygitalsRow({
      address: "MintPhy1",
      slug: "card-slug",
      name: "Card",
      price: "5000000",
      listed: true,
    });
    expect(withSlug!.externalUrl).toBe(phygitalsListingUrl("card-slug"));

    const noSlug = normalizePhygitalsRow({
      address: "MintPhy2",
      name: "Card2",
      price: "5000000",
      listed: true,
    });
    expect(noSlug!.externalUrl).toBe(phygitalsListingUrl("MintPhy2"));
  });

  it("Phygitals fixture rows always get externalUrl", () => {
    const body = JSON.parse(readFileSync(phyFixturePath, "utf8")) as {
      listings: Array<Record<string, unknown>>;
    };
    expect(body.listings.length).toBeGreaterThan(0);
    for (const row of body.listings) {
      const n = normalizePhygitalsRow(row);
      if (!n) continue;
      expect(n.externalUrl).toMatch(/^https:\/\/www\.phygitals\.com\/card\//);
    }
  });

  it("Courtyard: constructs asset URL; prefers origin when http(s)", () => {
    const built = normalizeCourtyardRow({
      token_id: "cy-tok-1",
      name: "C",
      price: 12,
    });
    expect(built!.externalUrl).toBe(courtyardListingUrl("cy-tok-1"));

    const fromOrigin = normalizeCourtyardRow({
      token_id: "cy-tok-2",
      name: "C2",
      price: 13,
      url: "https://courtyard.io/asset/override-tok",
    });
    expect(fromOrigin!.externalUrl).toBe(
      "https://courtyard.io/asset/override-tok",
    );
  });

  it("longtail generic path uses origin url fields", () => {
    const n = normalizeLongtailRow(
      {
        id: "lt1",
        name: "L",
        price: 5,
        url: "https://example.com/list/lt1",
      },
      "custom_lt",
      "custom_lt",
    );
    expect(n!.externalUrl).toBe("https://example.com/list/lt1");

    const bare = normalizeLongtailRow(
      { id: "lt2", name: "L2", price: 5 },
      "custom_lt",
      "custom_lt",
    );
    // No construct helper for generic longtail — null when origin omits URL.
    expect(bare!.externalUrl).toBeNull();
  });

  it("Beezie: uses origin URL when present; null otherwise (no stable path)", () => {
    const bare = normalizeBeezieRow({
      id: 1,
      tokenId: 2,
      owner: "0x027a1054714a70f26359b05201accdc791999ec0",
      metadata: { name: "X", attributes: [] },
      SellOrder: { amountUSDC: "10.00", createdAt: 1 },
    });
    // Beezie SPA has no documented stable /item/{id} public path we construct.
    expect(bare!.externalUrl).toBeNull();

    const withUrl = normalizeBeezieRow({
      id: 1,
      tokenId: 2,
      owner: "0x027a1054714a70f26359b05201accdc791999ec0",
      metadata: { name: "X", attributes: [] },
      SellOrder: { amountUSDC: "10.00", createdAt: 1 },
      external_url: "https://beezie.com/item/1",
    });
    expect(withUrl!.externalUrl).toBe("https://beezie.com/item/1");
  });

  it("Beezie fixture still normalizes (externalUrl optional)", () => {
    const body = JSON.parse(readFileSync(beezieFixturePath, "utf8")) as {
      dropItems: Array<Record<string, unknown>>;
    };
    const n = normalizeBeezieRow(body.dropItems[0]!);
    expect(n).not.toBeNull();
    expect(n!.price).toBe(22);
    expect(n!.externalUrl).toBeNull();
  });

  it("Renaiss: constructs /card/{tokenId}; prefers origin URL", () => {
    const built = normalizeRenaissRow({
      id: "uuid-1",
      tokenId: "7441145821947309",
      name: "R",
      askPriceInUSDT: "5",
    });
    expect(built!.externalUrl).toBe(renaissListingUrl("7441145821947309"));

    const fromOrigin = normalizeRenaissRow({
      id: "r1",
      tokenId: "t1",
      name: "R",
      askPriceInUSDT: "5",
      url: "https://www.renaiss.xyz/c/r1",
    });
    expect(fromOrigin!.externalUrl).toBe("https://www.renaiss.xyz/c/r1");

    // No tokenId and no origin URL → null (uuid id is not the public path key).
    const noToken = normalizeRenaissRow({
      id: "uuid-only",
      name: "R",
      askPriceInUSDT: "5",
    });
    expect(noToken!.externalUrl).toBeNull();
  });

  it("DYLI: constructs /p/{id}; prefers origin URL", () => {
    const built = normalizeDyliRow({
      id: "34073",
      name: "D",
      lowest_price: 3,
    });
    expect(built!.externalUrl).toBe(dyliListingUrl("34073"));

    const fromOrigin = normalizeDyliRow({
      id: "d1",
      name: "D",
      lowest_price: 3,
      externalUrl: "https://www.dyli.io/p/custom-slug",
    });
    expect(fromOrigin!.externalUrl).toBe("https://www.dyli.io/p/custom-slug");
  });
});
