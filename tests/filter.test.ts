import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listingMatchesFilter, filterListings } from "../src/filter.js";
import { listingId } from "../src/identity.js";
import type { Listing } from "../src/types.js";
import { syncOnce } from "../src/sync.js";
import { ListingStore } from "../src/store.js";
import {
  listingMatchesWatchlist,
  loadWatchlistFile,
  parseWatchlistString,
  mergeWatchlists,
  isWatchlistEmpty,
} from "../src/watchlist.js";
import { instrumentKeyFromListing } from "../src/orderbook/instrument.js";
import { MultiSourceRadar } from "../src/aggregate/MultiSourceRadar.js";
import { createFixtureProvider } from "../src/providers/fixture.js";
import { OrderbookFeed } from "../src/orderbook/OrderbookFeed.js";

function L(partial: Partial<Listing> & Pick<Listing, "platform" | "nativeId" | "price" | "name">): Listing {
  const provider = partial.provider ?? "fixture";
  return {
    id: listingId({
      provider,
      platform: partial.platform,
      nativeId: partial.nativeId,
    }),
    provider,
    tokenId: null,
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
    tcg: null,
    itemType: null,
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

describe("listingMatchesFilter", () => {
  it("filters by tcg pokemon", () => {
    const pokemon = L({
      platform: "cc",
      nativeId: "1",
      name: "Pika",
      price: 10,
      tcg: "pokemon",
    });
    const op = L({
      platform: "cc",
      nativeId: "2",
      name: "Zoro",
      price: 10,
      tcg: "one_piece",
    });
    const unknown = L({
      platform: "me",
      nativeId: "3",
      name: "ME unknown tcg",
      price: 10,
      tcg: null,
    });
    expect(listingMatchesFilter(pokemon, { tcg: "pokemon" })).toBe(true);
    expect(listingMatchesFilter(op, { tcg: "pokemon" })).toBe(false);
    // Missing tcg keeps row (ME / long-tail)
    expect(listingMatchesFilter(unknown, { tcg: "pokemon" })).toBe(true);
    expect(filterListings([pokemon, op, unknown], { tcg: "pokemon" })).toHaveLength(2);
  });

  it("filters price band and platform", () => {
    const a = L({
      platform: "courtyard",
      nativeId: "a",
      name: "A",
      price: 50,
    });
    expect(listingMatchesFilter(a, { platform: "courtyard", priceMin: 40, priceMax: 60 })).toBe(
      true,
    );
    expect(listingMatchesFilter(a, { priceMin: 80 })).toBe(false);
  });
});

describe("server+client filtered sync", () => {
  it("fixture pull + client filter keeps only matching tcg", async () => {
    const store = new ListingStore();
    const fixturePath = join(__dirname, "..", "fixtures", "radar-sample.json");
    const provider = createFixtureProvider({
      path: fixturePath,
      providerId: "fixture",
    });
    await syncOnce(store, provider, {
      shortCircuitOnBuiltAt: false,
    });
    expect(store.size()).toBeGreaterThan(0);
    const rows = filterListings(store.list(), { tcg: "pokemon" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !r.tcg || r.tcg === "pokemon")).toBe(true);
  });
});

describe("listingMatchesWatchlist", () => {
  const charizard = L({
    platform: "cc",
    nativeId: "c1",
    name: "Charizard VMAX",
    price: 200,
    tcg: "pokemon",
    tokenId: "MintCharizard1111111111111111111111111",
    cardNumber: "20/189",
    canonical: { scrydex_id: "scry-char-1", name: "Charizard" },
  });
  const pikachu = L({
    platform: "me",
    nativeId: "p1",
    name: "Pikachu Illustrator",
    price: 500,
    tcg: "pokemon",
    tokenId: "MintPika2222222222222222222222222222",
  });
  const umbreon = L({
    platform: "cc",
    nativeId: "u1",
    name: "Umbreon VMAX",
    price: 150,
    tcg: "pokemon",
  });

  it("empty watchlist matches all", () => {
    expect(listingMatchesWatchlist(charizard)).toBe(true);
    expect(listingMatchesWatchlist(charizard, {})).toBe(true);
    expect(isWatchlistEmpty({})).toBe(true);
  });

  it("matches name substrings (case-insensitive)", () => {
    expect(listingMatchesWatchlist(charizard, { names: ["charizard"] })).toBe(
      true,
    );
    expect(listingMatchesWatchlist(pikachu, { names: ["charizard"] })).toBe(
      false,
    );
    expect(
      listingMatchesWatchlist(pikachu, { names: ["PIKA", "charizard"] }),
    ).toBe(true);
  });

  it("matches mint / card ids", () => {
    expect(
      listingMatchesWatchlist(charizard, {
        ids: ["MintCharizard1111111111111111111111111"],
      }),
    ).toBe(true);
    expect(listingMatchesWatchlist(charizard, { ids: ["scry-char-1"] })).toBe(
      true,
    );
    expect(listingMatchesWatchlist(charizard, { ids: ["20/189"] })).toBe(true);
    expect(listingMatchesWatchlist(charizard, { ids: ["c1"] })).toBe(true);
    expect(listingMatchesWatchlist(pikachu, { ids: ["c1"] })).toBe(false);
  });

  it("matches instrument keys", () => {
    const key = instrumentKeyFromListing(charizard);
    expect(
      listingMatchesWatchlist(charizard, { instrumentKeys: [key] }),
    ).toBe(true);
    expect(
      listingMatchesWatchlist(umbreon, { instrumentKeys: [key] }),
    ).toBe(false);
  });

  it("OR across criteria", () => {
    expect(
      listingMatchesWatchlist(umbreon, {
        names: ["charizard"],
        ids: ["u1"],
      }),
    ).toBe(true);
  });

  it("filterListings + PullQuery.watchlist", () => {
    const rows = [charizard, pikachu, umbreon];
    expect(
      filterListings(rows, { watchlist: { names: ["charizard", "pika"] } }),
    ).toHaveLength(2);
    expect(
      listingMatchesFilter(umbreon, {
        tcg: "pokemon",
        watchlist: { names: ["charizard"] },
      }),
    ).toBe(false);
    expect(
      listingMatchesFilter(charizard, {
        tcg: "pokemon",
        watchlist: { names: ["charizard"] },
      }),
    ).toBe(true);
  });

  it("parseWatchlistString + loadWatchlistFile", () => {
    const w = parseWatchlistString("charizard,pikachu,id:mintABC");
    expect(w.names).toEqual(expect.arrayContaining(["charizard", "pikachu"]));
    expect(w.ids).toEqual(["mintABC"]);

    const dir = mkdtempSync(join(tmpdir(), "wl-"));
    const jsonPath = join(dir, "w.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        names: ["umbreon"],
        instrumentKeys: ["name:pokemon|x|raw|raw"],
        ids: ["tok1"],
      }),
    );
    const fromJson = loadWatchlistFile(jsonPath);
    expect(fromJson.names).toEqual(["umbreon"]);
    expect(fromJson.ids).toEqual(["tok1"]);

    const txtPath = join(dir, "w.txt");
    writeFileSync(txtPath, "charizard\npikachu\n# comment\nkey:scry:abc|psa|10\n");
    const fromTxt = loadWatchlistFile(txtPath);
    expect(fromTxt.names).toEqual(expect.arrayContaining(["charizard", "pikachu"]));
    expect(fromTxt.instrumentKeys).toEqual(["scry:abc|psa|10"]);

    const merged = mergeWatchlists(w, fromJson);
    expect(merged.names?.length).toBeGreaterThanOrEqual(3);
  });

  it("MultiSourceRadar list applies watchlist", async () => {
    const fixturePath = join(__dirname, "..", "fixtures", "radar-sample.json");
    const radar = new MultiSourceRadar({
      providers: [
        createFixtureProvider({ path: fixturePath, providerId: "fixture" }),
      ],
      filter: { limit: 50 },
      watchlist: { names: ["zzzz-no-match-xyz"] },
    });
    await radar.syncAll();
    const filtered = radar.list({ clientFilter: true });
    expect(filtered).toHaveLength(0);
    expect(radar.list({ watchlist: true })).toHaveLength(0);
    expect(radar.list().length).toBeGreaterThan(0);
  });

  it("OrderbookFeed watchlist filters asks", async () => {
    const store = new ListingStore();
    store.upsertOne(charizard);
    store.upsertOne(pikachu);
    store.upsertOne(umbreon);
    const feed = new OrderbookFeed({
      listingStore: store,
      native: true,
      watchlist: { names: ["charizard"] },
    });
    await feed.start();
    const asks = feed.getOrderbookStore().allAsks();
    expect(asks).toHaveLength(1);
    expect(asks[0]!.price).toBe(200);
    expect(asks[0]!.nativeId).toBe("c1");
    feed.stop();
  });
});

