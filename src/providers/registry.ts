import { createCollectorCryptProvider } from "./collectorcrypt.js";
import { createCourtyardProvider } from "./courtyard.js";
import { createFixtureProvider, type FixtureProviderOptions } from "./fixture.js";
import {
  createBeezieProvider,
  createDyliProvider,
  createPhygitalsProvider,
  createRenaissProvider,
} from "./longtail.js";
import { createMagicEdenProvider, type MagicEdenOptions } from "./magiceden.js";
import { createTradedGgProvider, type TradedGgOptions } from "./tradedgg.js";
import type { ListingsProvider } from "./types.js";

export type ProviderFactory = () => ListingsProvider;

/**
 * Default product path: origin marketplaces only.
 * traded.gg is never in this list.
 */
export const DEFAULT_NATIVE_PROVIDER_IDS = [
  "collectorcrypt",
  "magiceden",
] as const;

/** Extended native set used by multi-source demos (still no traded.gg). */
export const NATIVE_PROVIDER_IDS = [
  "collectorcrypt",
  "magiceden",
  "courtyard",
  "beezie",
  "renaiss",
  "dyli",
  "phygitals",
] as const;

/**
 * Solana-native multi-source set for radar (default purity).
 * Default: collectorcrypt + magiceden(collector_crypt) + phygitals.
 * Excludes: Courtyard (Polygon), Renaiss, DYLI, traded.gg, and **Beezie** (EVM).
 * Opt into Beezie via createSolanaProviders({ includeBeezie: true }) or { includeEvm: true }.
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
   * Full multi-source set: CC + Courtyard + Beezie + Renaiss + DYLI
   * (+ Magic Eden unless `magiceden: false`). Never traded.gg.
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
  /** Same as `includeBeezie` — opt into EVM long-tail (Beezie) for breadth. */
  includeEvm?: boolean;
}

/**
 * Build the default native provider set for MultiSourceRadar.
 * Never includes traded.gg — that adapter is opt-in via getProvider("tradedgg").
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

  if (opts.all) {
    const out: ListingsProvider[] = [
      createCollectorCryptProvider(),
      createCourtyardProvider(),
      createBeezieProvider(),
      createRenaissProvider(),
      createDyliProvider(),
    ];
    if (includeMe) out.splice(1, 0, createMagicEdenProvider(meOpts));
    return out;
  }

  const out: ListingsProvider[] = [createCollectorCryptProvider()];
  if (includeMe) out.push(createMagicEdenProvider(meOpts));
  if (opts.courtyard) out.push(createCourtyardProvider());
  return out;
}

/**
 * Solana-native marketplace set (default purity).
 * Default: CC (Solana) + ME `collector_crypt` + Phygitals.
 * No Polygon Courtyard, no Renaiss/DYLI, no traded.gg, no Beezie (EVM).
 * Opt into Beezie: `{ includeBeezie: true }` or `{ includeEvm: true }`.
 * Use with MultiSourceRadar.syncAll (per-provider soft-fail via allSettled).
 */
export function createSolanaProviders(
  opts: SolanaProvidersOptions = {},
): ListingsProvider[] {
  const out: ListingsProvider[] = [
    // blockchain=Solana is also the CollectorCryptProvider default
    createCollectorCryptProvider({ blockchain: "Solana" }),
    createMagicEdenProvider({
      symbol: "collector_crypt",
      ...opts.magiceden,
    }),
    createPhygitalsProvider(),
  ];
  if (opts.includeBeezie || opts.includeEvm) {
    // Beezie after ME, before Phygitals — matches former default order
    out.splice(2, 0, createBeezieProvider());
  }
  return out;
}

/**
 * Built-in native sources first (Collector Crypt, Magic Eden).
 * traded.gg remains registered only as an optional reference adapter.
 */
export function registerBuiltins(opts?: {
  tradedgg?: TradedGgOptions;
  fixture?: FixtureProviderOptions;
}): void {
  registerProvider("collectorcrypt", () => createCollectorCryptProvider());
  registerProvider("magiceden", () => createMagicEdenProvider());
  registerProvider("courtyard", () => createCourtyardProvider());
  registerProvider("beezie", () => createBeezieProvider());
  registerProvider("renaiss", () => createRenaissProvider());
  registerProvider("dyli", () => createDyliProvider());
  registerProvider("phygitals", () => createPhygitalsProvider());
  // Reference only — not the system of record, never a default
  registerProvider("tradedgg", () => createTradedGgProvider(opts?.tradedgg));
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

// Auto-register on import for CLI convenience
registerBuiltins();
