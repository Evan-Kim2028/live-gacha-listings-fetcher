import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MultiSourceRadar,
  createFixtureProvider,
  saveBook,
  loadBook,
  resolveBookDir,
  decisionFilter,
  querySignature,
  ListingStore,
  syncOnce,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fix = join(root, "fixtures", "radar-sample.json");
const tmpRoot = join(root, "data", "books", "_test-bootstrap");

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("book persist + bootstrapAll", () => {
  it("bootstrapAll sets bootstrap and fills store from fixtures", async () => {
    const providers = [
      createFixtureProvider({ path: fix, providerId: "fixture" }),
      createFixtureProvider({ path: fix, providerId: "fixture_b" }),
    ];
    const filter = decisionFilter({ tcg: "pokemon", limit: 10, sort: "new" });
    const radar = new MultiSourceRadar({ providers, filter });
    const r = await radar.bootstrapAll({ maxPages: 1 });
    expect(r.query.bootstrap).toBe(true);
    expect(r.totalActive).toBeGreaterThan(0);
    expect(r.byProvider.fixture).toBeGreaterThan(0);
  });

  it("saveBook / loadBook round-trip preserves scope and signature", async () => {
    const providers = [
      createFixtureProvider({ path: fix, providerId: "fixture" }),
    ];
    const filter = decisionFilter({ tcg: "pokemon", limit: 5, sort: "new" });
    const qsig = querySignature(filter);
    const radar = new MultiSourceRadar({ providers, filter });
    await radar.bootstrapAll({ maxPages: 1 });
    const outDir = resolveBookDir({
      filter,
      providers: ["fixture"],
      outDir: join(tmpRoot, "roundtrip"),
    });
    const meta = saveBook({
      store: radar.store,
      filter,
      providers: ["fixture"],
      outDir,
    });
    expect(meta.rowCount).toBeGreaterThan(0);
    expect(meta.querySignature).toBe(qsig);

    const store2 = new ListingStore();
    const loaded = loadBook({
      store: store2,
      outDir,
      filter,
      maxAgeMs: 60_000,
    });
    expect(loaded.loaded).toBe(true);
    expect(loaded.fresh).toBe(true);
    expect(store2.size("fixture")).toBe(radar.store.size("fixture"));
    expect(store2.listScope("fixture", qsig).length).toBe(
      radar.store.listScope("fixture", qsig).length,
    );
  });

  it("syncOnce with bootstrap:true uses pullAll path on fixture", async () => {
    const store = new ListingStore();
    const p = createFixtureProvider({ path: fix, providerId: "fixture" });
    const r = await syncOnce(store, p, {
      tcg: "pokemon",
      limit: 3,
      bootstrap: true,
      maxPages: 1,
      shortCircuitOnBuiltAt: false,
    });
    expect(r.fetched).toBeGreaterThan(0);
    expect(r.shortCircuited).toBe(false);
  });

  it("loadBook rejects signature mismatch", async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const providers = [
      createFixtureProvider({ path: fix, providerId: "fixture" }),
    ];
    const filter = decisionFilter({ tcg: "pokemon", limit: 5, sort: "new" });
    const radar = new MultiSourceRadar({ providers, filter });
    await radar.bootstrapAll();
    const outDir = join(tmpRoot, "mismatch");
    saveBook({
      store: radar.store,
      filter,
      providers: ["fixture"],
      outDir,
    });
    const other = decisionFilter({ tcg: "one_piece", limit: 5, sort: "new" });
    const loaded = loadBook({
      store: new ListingStore(),
      outDir,
      filter: other,
    });
    expect(loaded.loaded).toBe(false);
    expect(loaded.reason).toMatch(/mismatch/);
  });
});
