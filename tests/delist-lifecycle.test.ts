import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCapture } from "../src/capture/RunCapture.js";
import {
  applyDelistsFromSync,
  type DelistEvent,
} from "../src/lifecycle/index.js";
import { listingToAsk, OrderbookStore } from "../src/orderbook/index.js";
import { createPhygitalsProvider } from "../src/providers/longtail.js";
import type { ListingsProvider, PullPage } from "../src/providers/types.js";
import { ListingStore } from "../src/store.js";
import { syncOnce } from "../src/sync.js";
import type { Listing } from "../src/types.js";

function listingStub(
  provider: string,
  nativeId: string,
  price = 10,
  extras: Partial<Listing> = {},
): Listing {
  return {
    id: `${provider}:cc:${nativeId}`,
    provider,
    platform: "cc",
    nativeId,
    tokenId: null,
    name: extras.name ?? `Card ${nativeId}`,
    price,
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
    itemType: null,
    grader: extras.grader ?? "PSA",
    grade: extras.grade ?? "10",
    gradeNum: extras.gradeNum ?? 10,
    language: null,
    setRaw: null,
    cardNumber: null,
    year: null,
    confidence: null,
    canonical: extras.canonical ?? {
      scrydex_id: `card-${nativeId}`,
      name: `Card ${nativeId}`,
    },
    contractAddress: null,
    ...extras,
  };
}

function page(
  provider: string,
  listings: Listing[],
  opts: {
    builtAt?: string;
    hasMore?: boolean;
  } = {},
): PullPage {
  return {
    listings,
    hasMore: opts.hasMore ?? false,
    meta: {
      provider,
      builtAt: opts.builtAt ?? `gen-${listings.map((l) => l.nativeId).join(",")}`,
      total: listings.length,
      universe: listings.length,
      fetchedAt: new Date().toISOString(),
      querySignature: "",
    },
  };
}

function mutableProvider(
  id: string,
  getPage: () => PullPage,
): ListingsProvider {
  return {
    id,
    lastError: null,
    async pull() {
      return getPage();
    },
  };
}

function readSoldJsonl(runDir: string): Array<{ kind: string; listingIds?: string[] }> {
  const p = join(runDir, "sold.jsonl");
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}

describe("delist lifecycle (prunedIds + applyDelistsFromSync)", () => {
  it("full scope then smaller complete page prunes + book clear + capture sold", async () => {
    const store = new ListingStore();
    const a = listingStub("delist_src", "a", 100);
    const b = listingStub("delist_src", "b", 200);
    const c = listingStub("delist_src", "c", 300);
    let phase: "full" | "smaller" = "full";

    const provider = mutableProvider("delist_src", () => {
      if (phase === "full") return page("delist_src", [a, b, c]);
      // Smaller complete page (hasMore false) → prune b
      return page("delist_src", [a, c], { builtAt: "gen-ac" });
    });

    const r1 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(r1.pruned).toBe(0);
    expect(r1.prunedIds).toEqual([]);
    expect(store.size("delist_src")).toBe(3);

    const book = new OrderbookStore();
    for (const l of [a, b, c]) {
      book.upsertAsk(listingToAsk(l));
    }
    // residual bid on B's instrument
    const bKey = listingToAsk(b).instrumentKey;
    book.upsertBid({
      id: "bid:b-residual",
      provider: "delist_src",
      instrumentKey: bKey,
      nativeId: "bid-b",
      side: "bid",
      price: 90,
      size: 1,
      currency: "USDC",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    expect(book.allAsks()).toHaveLength(3);
    expect(book.allBids()).toHaveLength(1);

    const runDir = mkdtempSync(join(tmpdir(), "delist-lifecycle-"));
    const capture = RunCapture.open(runDir);

    phase = "smaller";
    const r2 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(r2.pruned).toBe(1);
    expect(r2.prunedIds).toEqual([b.id]);
    expect(store.get(b.id)).toBeUndefined();
    expect(store.size("delist_src")).toBe(2);

    const events: DelistEvent[] = applyDelistsFromSync(r2, book, capture);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "delist_src",
      listingId: b.id,
      lastBestAsk: 200,
      lastBestBid: 90,
      reason: "missing_from_full_snapshot",
      source: "poll_diff",
    });
    expect(events[0]!.instrumentKey).toBe(bKey);

    // Ask + residual bids cleared for B
    expect(book.getAsk(`ask:${b.id}`)).toBeUndefined();
    expect(book.allBids().filter((x) => x.instrumentKey === bKey)).toHaveLength(0);
    // A and C still listed
    expect(book.getAsk(`ask:${a.id}`)).toBeDefined();
    expect(book.getAsk(`ask:${c.id}`)).toBeDefined();

    const sold = readSoldJsonl(runDir);
    expect(sold.length).toBeGreaterThanOrEqual(1);
    expect(sold.some((s) => s.listingIds?.includes(b.id))).toBe(true);
    capture.close();
  });

  it("soft-fail empty does not prune (prunedIds empty; applyDelists no-op)", async () => {
    const store = new ListingStore();
    const a = listingStub("soft_src", "keep", 42);
    let fail = false;
    const provider: ListingsProvider = {
      id: "soft_src",
      lastError: null,
      async pull() {
        if (fail) {
          this.lastError = "soft-fail HTTP 500 (test)";
          return page("soft_src", []);
        }
        this.lastError = null;
        return page("soft_src", [a], { builtAt: "gen-1" });
      },
    };

    await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(store.size("soft_src")).toBe(1);

    const book = new OrderbookStore();
    book.upsertAsk(listingToAsk(a));

    fail = true;
    const soft = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(soft.shortCircuited).toBe(true);
    expect(soft.pruned).toBe(0);
    expect(soft.prunedIds).toEqual([]);
    expect(store.get(a.id)).toBeDefined();

    const events = applyDelistsFromSync(soft, book);
    expect(events).toEqual([]);
    expect(book.getAsk(`ask:${a.id}`)).toBeDefined();
  });

  it("incomplete page (hasMore / partial) does not prune", async () => {
    const store = new ListingStore();
    const a = listingStub("inc_src", "a", 10);
    const b = listingStub("inc_src", "b", 20);
    const c = listingStub("inc_src", "c", 30);
    let phase: "full" | "incomplete" = "full";

    const provider = mutableProvider("inc_src", () => {
      if (phase === "full") return page("inc_src", [a, b, c], { builtAt: "full" });
      // Partial warm page: fewer ids + hasMore true → upsert only, no prune
      return page("inc_src", [a], { builtAt: "partial", hasMore: true });
    });

    await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(store.size("inc_src")).toBe(3);

    phase = "incomplete";
    const r = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(r.pruned).toBe(0);
    expect(r.prunedIds).toEqual([]);
    expect(store.size("inc_src")).toBe(3);
    expect(store.get(b.id)).toBeDefined();
    expect(store.get(c.id)).toBeDefined();

    const book = new OrderbookStore();
    for (const l of [a, b, c]) book.upsertAsk(listingToAsk(l));
    expect(applyDelistsFromSync(r, book)).toEqual([]);
    expect(book.allAsks()).toHaveLength(3);
  });

  it("replaceScopeSnapshot exposes prunedIds matching pruned count", () => {
    const store = new ListingStore();
    const a = listingStub("mem", "a", 1);
    const b = listingStub("mem", "b", 2);
    store.replaceScopeSnapshot("mem", "", [a, b]);
    const stats = store.replaceScopeSnapshot("mem", "", [a]);
    expect(stats.pruned).toBe(1);
    expect(stats.prunedIds).toEqual([b.id]);
  });
});

/** Minimal UniversalNFTData row for Phygitals mock API. */
function phyRow(
  address: string,
  priceMicro: string,
  slug?: string,
): Record<string, unknown> {
  return {
    address,
    slug: slug ?? address.slice(0, 12).toLowerCase(),
    name: `Card ${address.slice(0, 6)}`,
    image: "https://example.com/x.png",
    owner: "Owner1111111111111111111111111111111",
    price: priceMicro,
    listed: true,
    marketplace: "TENSOR",
    metadata: [
      { key: "Type", value: "Pokémon" },
      { key: "Grade", value: "10" },
      { key: "Grader", value: "PSA" },
    ],
  };
}

function phyListedResponse(rows: Record<string, unknown>[]): Response {
  return new Response(JSON.stringify({ listings: rows, amount: rows.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function phyFiltersOk(): Response {
  return new Response(
    JSON.stringify({
      filters: {
        metadata: {
          Type: [{ value: "Pokémon", count: 10 }],
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Phygitals delist path (soft-fail safety + listed shrink prune)", () => {
  const addrA = "6sRw5SiUSNu79Nvv2XFjVSJuHJE26X8HTDerV6TWJvQ";
  const addrB = "3mtLLYXGck2vM1od3gDTbVtSK9Nb3iyNGJ35L8NjyScs";
  const addrC = "AddrC1111111111111111111111111111111111";

  it("5xx soft-fail empty does NOT prune prior listed scope", async () => {
    let mode: "ok" | "fail" = "ok";
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/filters")) return phyFiltersOk();
      if (mode === "fail") {
        return new Response("Internal server error", { status: 500 });
      }
      // Successful listedStatus=listed page (complete)
      expect(url).toMatch(/listedStatus=listed|marketplace-listings/);
      return phyListedResponse([
        phyRow(addrA, "1000000", "card-a"),
        phyRow(addrB, "2000000", "card-b"),
      ]);
    };

    const p = createPhygitalsProvider({
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0,
      retryDelayMs: 1,
    });
    const store = new ListingStore();

    const cold = await syncOnce(store, p, {
      limit: 10,
      shortCircuitOnBuiltAt: false,
    });
    expect(cold.fetched).toBe(2);
    expect(cold.pruned).toBe(0);
    expect(store.size("phygitals")).toBe(2);
    expect(p.lastError).toBeNull();

    mode = "fail";
    const soft = await syncOnce(store, p, {
      limit: 10,
      shortCircuitOnBuiltAt: false,
    });
    expect(soft.shortCircuited).toBe(true);
    expect(soft.pruned).toBe(0);
    expect(soft.prunedIds).toEqual([]);
    expect(store.size("phygitals")).toBe(2);
    expect(p.lastError).toMatch(/soft-fail|HTTP 500/);
    expect(store.getWatermark("phygitals")?.lastError).toMatch(
      /soft-fail|HTTP 500/,
    );
    // Prior rows still present
    expect(
      store.list("phygitals").some((l) => l.nativeId === addrA),
    ).toBe(true);
    expect(
      store.list("phygitals").some((l) => l.nativeId === addrB),
    ).toBe(true);

    const book = new OrderbookStore();
    for (const l of store.list("phygitals")) book.upsertAsk(listingToAsk(l));
    expect(applyDelistsFromSync(soft, book)).toEqual([]);
    expect(book.allAsks()).toHaveLength(2);
  });

  it("successful full listedStatus=listed shrink may prune absences + applyDelists", async () => {
    let phase: "full" | "smaller" = "full";
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/filters")) return phyFiltersOk();
      // Prefer listedStatus=listed attempts (docs path)
      if (url.includes("listedStatus=any") && !url.includes("listedStatus=listed")) {
        // Still ok if attempt falls through; primary is listed
      }
      if (phase === "full") {
        return phyListedResponse([
          phyRow(addrA, "1000000", "card-a"),
          phyRow(addrB, "2000000", "card-b"),
          phyRow(addrC, "3000000", "card-c"),
        ]);
      }
      // Complete smaller listed page (hasMore false via amount === page size)
      return phyListedResponse([
        phyRow(addrA, "1000000", "card-a"),
        phyRow(addrC, "3000000", "card-c"),
      ]);
    };

    const p = createPhygitalsProvider({
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0,
      retryDelayMs: 1,
    });
    const store = new ListingStore();

    const r1 = await syncOnce(store, p, {
      limit: 10,
      shortCircuitOnBuiltAt: false,
    });
    expect(r1.pruned).toBe(0);
    expect(r1.prunedIds).toEqual([]);
    expect(store.size("phygitals")).toBe(3);
    expect(p.lastUrl).toMatch(/listedStatus=listed|itemsPerPage|page=/);

    const listings = store.list("phygitals");
    const gone = listings.find((l) => l.nativeId === addrB)!;
    expect(gone).toBeDefined();

    const book = new OrderbookStore();
    for (const l of listings) book.upsertAsk(listingToAsk(l));
    const bKey = listingToAsk(gone).instrumentKey;
    book.upsertBid({
      id: "bid:phy-b",
      provider: "phygitals",
      instrumentKey: bKey,
      nativeId: "bid-b",
      side: "bid",
      price: 1.5,
      size: 1,
      currency: "USDC",
      updatedAt: "2026-08-01T00:00:00Z",
    });

    phase = "smaller";
    const r2 = await syncOnce(store, p, {
      limit: 10,
      shortCircuitOnBuiltAt: false,
    });
    expect(r2.pruned).toBe(1);
    expect(r2.prunedIds).toEqual([gone.id]);
    expect(store.get(gone.id)).toBeUndefined();
    expect(store.size("phygitals")).toBe(2);
    expect(p.lastError).toBeNull();

    const events = applyDelistsFromSync(r2, book);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "phygitals",
      listingId: gone.id,
      reason: "missing_from_full_snapshot",
      source: "poll_diff",
      lastBestAsk: gone.price,
    });
    expect(book.getAsk(`ask:${gone.id}`)).toBeUndefined();
    expect(book.allBids().filter((x) => x.instrumentKey === bKey)).toHaveLength(
      0,
    );
  });
});
