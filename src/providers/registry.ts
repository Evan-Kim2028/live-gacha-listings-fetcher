import { createFixtureProvider, type FixtureProviderOptions } from "./fixture.js";
import {
  catalogEntry,
  PROVIDER_CATALOG,
  type CatalogCreateOpts,
} from "./catalog.js";
import type { MagicEdenOptions } from "./magiceden.js";
import type { ListingsProvider } from "./types.js";

export type ProviderFactory = () => ListingsProvider;

/**
 * Default product path: origin marketplaces only.
 */
export const DEFAULT_NATIVE_PROVIDER_IDS = [
  "collectorcrypt",
  "magiceden",
] as const;

/** Extended native set used by multi-source demos. */
export const NATIVE_PROVIDER_IDS = [
  "collectorcrypt",
  "magiceden",
  "courtyard",
  "beezie",
  "beezie-solana",
  "renaiss",
  "dyli",
  "phygitals",
] as const;

/**
 * Solana-native multi-source set for radar (default purity).
 * Default: collectorcrypt + magiceden(collector_crypt) + phygitals.
 * Excludes: Courtyard (Polygon), Renaiss, DYLI, and **Beezie EVM**.
 * Beezie has a native Solana marketplace (solana.beezie.com) — opt in via
 * `{ includeBeezieSolana: true }` (thin live book, cheap full pulls).
 */
export const SOLANA_PROVIDER_IDS = [
  "collectorcrypt",
  "magiceden",
  "phygitals",
] as const;

const registry = new Map<string, ProviderFactory>();

/** Register or replace a provider factory by id. */
export function registerProvider(id: string, factory: ProviderFactory): void {
  registry.set(id, factory);
}

export function getProvider(id: string): ListingsProvider {
  const factory = registry.get(id);
  if (!factory) {
    throw new Error(
      `Unknown listings provider "${id}". Registered: ${[...registry.keys()].join(", ") || "(none)"}`,
    );
  }
  return factory();
}

export function listProviders(): string[] {
  return [...registry.keys()].sort();
}

export interface DefaultProvidersOptions {
  /**
   * Magic Eden options, or `false` to omit ME.
   * When omitted, ME is included (minimal path and `--all` both default ME on).
   */
  magiceden?: MagicEdenOptions | false;
  /** Include Courtyard Algolia feed (default false for minimal path). */
  courtyard?: boolean;
  /**
   * Beezie venues walk **all** categories instead of only Pokémon.
   * Pair with a tcg-less filter (`--tcg all`).
   */
  beezieAllCategories?: boolean;
  /**
   * Full multi-source set: CC + Courtyard + Beezie + Renaiss + DYLI
   * (+ Magic Eden unless `magiceden: false`).
   */
  all?: boolean;
}

export interface SolanaProvidersOptions {
  magiceden?: MagicEdenOptions;
  /**
   * Include Beezie (EVM catalog). Default false — Beezie is not Solana-native.
   * Alias: `includeEvm: true` also enables Beezie for old multi-venue breadth.
   */
  includeBeezie?: boolean;
  /**
   * Include Beezie Solana marketplace (solana.beezie.com) — Solana-native,
   * pokemon category, USDC SellOrders. Thin live book; full pull is cheap.
   * Default false (default purity set unchanged).
   */
  includeBeezieSolana?: boolean;
  /** Same as `includeBeezie` — opt into EVM long-tail (Beezie) for breadth. */
  includeEvm?: boolean;
  /**
   * Include Courtyard (Polygon, Algolia listings + on-chain orderbook bids).
   * Not Solana-native — opt in when cross-chain breadth is wanted.
   */
  courtyard?: boolean;
  /**
   * When true, Beezie venues walk **all** categories (GET /dropItems/categories)
   * instead of only Pokémon (categoryId 1). Pair with a tcg-less filter
   * (`--tcg all`) so other venues also skip their category facet.
   */
  beezieAllCategories?: boolean;
}

/**
 * Build the default native provider set for MultiSourceRadar.
 *
 * - Default: collectorcrypt + magiceden (+ courtyard if `courtyard: true`)
 * - `all: true`: CC + Courtyard + Beezie + Renaiss + DYLI (+ ME unless `magiceden: false`)
 */
export function createDefaultProviders(
  opts: DefaultProvidersOptions = {},
): ListingsProvider[] {
  const includeMe = opts.magiceden !== false;
  const meOpts =
    opts.magiceden === false || opts.magiceden === undefined
      ? undefined
      : opts.magiceden;

  const allCategories: CatalogCreateOpts = opts.beezieAllCategories
    ? { allCategories: true }
    : {};
  if (opts.all) {
    const order = [
      "collectorcrypt",
      ...(includeMe ? ["magiceden"] : []),
      "courtyard",
      "beezie",
      "beezie-solana",
      "renaiss",
      "dyli",
    ];
    return order.map((id) => {
      const e = catalogEntry(id)!;
      return e.create({ ...allCategories, me: meOpts });
    });
  }

  const minimal: ListingsProvider[] = [catalogEntry("collectorcrypt")!.create()];
  if (includeMe) minimal.push(catalogEntry("magiceden")!.create({ me: meOpts }));
  if (opts.courtyard) minimal.push(catalogEntry("courtyard")!.create());
  return minimal;
}

/**
 * Solana-native marketplace set (default purity).
 * Default: CC (Solana) + ME `collector_crypt` + Phygitals.
 * No Polygon Courtyard, no Renaiss/DYLI, no Beezie EVM.
 * Opt into EVM Beezie: `{ includeBeezie: true }` / `{ includeEvm: true }`.
 * Opt into Beezie Solana (native): `{ includeBeezieSolana: true }`.
 * Use with MultiSourceRadar.syncAll (per-provider soft-fail via allSettled).
 */
export function createSolanaProviders(
  opts: SolanaProvidersOptions = {},
): ListingsProvider[] {
  const allCategories: CatalogCreateOpts = opts.beezieAllCategories
    ? { allCategories: true }
    : {};
  const meOpts = opts.magiceden
    ? { symbol: "collector_crypt", ...opts.magiceden }
    : { symbol: "collector_crypt" };
  // Ordering is contractual (tests assert it). Legacy splice semantics:
  // beezie inserts before Phygitals; beezie-solana inserts AFTER Phygitals
  // unless beezie is also included (then it lands before Phygitals).
  const hasBeezie = opts.includeBeezie || opts.includeEvm;
  const hasBeezieSolana = Boolean(opts.includeBeezieSolana);
  const order = [
    "collectorcrypt",
    "magiceden",
    ...(hasBeezie ? ["beezie"] : []),
    ...(hasBeezie && hasBeezieSolana ? ["beezie-solana"] : []),
    "phygitals",
    ...(hasBeezieSolana && !hasBeezie ? ["beezie-solana"] : []),
    ...(opts.courtyard ? ["courtyard"] : []),
  ];
  return order.map((id) => {
    const e = catalogEntry(id)!;
    return e.create({ ...allCategories, me: meOpts });
  });
}

/**
 * Built-in native sources (Collector Crypt, Magic Eden, long-tail venues, fixture).
 */
export function registerBuiltins(opts?: {
  fixture?: FixtureProviderOptions;
}): void {
  // Catalog-driven: every entry registers itself.
  for (const e of PROVIDER_CATALOG) {
    registerProvider(e.id, () => e.create());
  }
  if (opts?.fixture) {
    const fixtureOpts = opts.fixture;
    registerProvider("fixture", () => createFixtureProvider(fixtureOpts));
  } else {
    registerProvider("fixture", () =>
      createFixtureProvider({
        path: "fixtures/radar-sample.json",
        providerId: "fixture",
      }),
    );
  }
}

// Auto-register on import so getProvider works out of the box.
registerBuiltins();
