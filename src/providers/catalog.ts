/**
 * Declarative provider catalog — the single add-point for a new marketplace.
 *
 * Adding a venue today:
 *   1. Write the provider class (subclass LongtailProvider for browse APIs,
 *      or implement ListingsProvider directly).
 *   2. Add one entry here (id, label, chains, capabilities, factory).
 *   3. Add the id to the relevant set order array in registry.ts.
 *
 * Capabilities are introspected by the CLI (`card` iterates entries with
 * supportsGetByTokenId) and by operators — no duck-typing.
 */
import { createCollectorCryptProvider } from "./collectorcrypt.js";
import { createCourtyardProvider } from "./courtyard.js";
import { createMagicEdenProvider } from "./magiceden.js";
import {
  createBeezieProvider,
  createBeezieSolanaProvider,
} from "./beezieProvider.js";
import { createPhygitalsProvider } from "./phygitalsProvider.js";
import { createDyliProvider, createRenaissProvider } from "./renaissDyli.js";
import type { ListingsProvider } from "./types.js";

export interface CatalogCreateOpts {
  /** Beezie venues: walk every /dropItems/categories instead of pokemon only. */
  allCategories?: boolean;
  /** Magic Eden options — passed through to the ME factory. */
  me?: object;
}

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  /** Settlement chain(s): "solana" | "evm-base" | "polygon" | … */
  chains: string[];
  /** Venue can enumerate every category (not just pokemon). */
  supportsAllCategories: boolean;
  /** Venue has a public per-token lookup (getByTokenId). */
  supportsGetByTokenId: boolean;
  /** Venue provides priced bids (BidsProvider available). */
  supportsBids: boolean;
  /** Factory honoring CatalogCreateOpts. */
  create: (opts?: CatalogCreateOpts) => ListingsProvider;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: "collectorcrypt",
    label: "Collector Crypt",
    chains: ["solana"],
    supportsAllCategories: false,
    supportsGetByTokenId: true,
    supportsBids: true,
    create: () => createCollectorCryptProvider({ blockchain: "Solana" }),
  },
  {
    id: "magiceden",
    label: "Magic Eden",
    chains: ["solana"],
    supportsAllCategories: false,
    supportsGetByTokenId: true,
    supportsBids: true,
    create: (o) => createMagicEdenProvider(o?.me as never),
  },
  {
    id: "courtyard",
    label: "Courtyard",
    chains: ["polygon"],
    supportsAllCategories: true,
    supportsGetByTokenId: true,
    supportsBids: true,
    create: () => createCourtyardProvider(),
  },
  {
    id: "beezie",
    label: "Beezie (Base)",
    chains: ["evm-base"],
    supportsAllCategories: true,
    supportsGetByTokenId: true,
    supportsBids: false,
    create: (o) => createBeezieProvider({ allBeezieCategories: o?.allCategories }),
  },
  {
    id: "beezie-solana",
    label: "Beezie (Solana)",
    chains: ["solana"],
    supportsAllCategories: true,
    supportsGetByTokenId: true,
    supportsBids: false,
    create: (o) =>
      createBeezieSolanaProvider({ allBeezieCategories: o?.allCategories }),
  },
  {
    id: "renaiss",
    label: "Renaiss",
    chains: ["solana"],
    supportsAllCategories: false,
    supportsGetByTokenId: false,
    supportsBids: false,
    create: () => createRenaissProvider(),
  },
  {
    id: "dyli",
    label: "DYLI",
    chains: ["solana"],
    supportsAllCategories: false,
    supportsGetByTokenId: false,
    supportsBids: false,
    create: () => createDyliProvider(),
  },
  {
    id: "phygitals",
    label: "Phygitals",
    chains: ["solana"],
    supportsAllCategories: true,
    supportsGetByTokenId: false,
    supportsBids: false,
    create: () => createPhygitalsProvider(),
  },
];

/** Catalog entry by id (undefined for unregistered / dynamic ids). */
export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id);
}

/** Venues with a per-token lookup — used by `traded-listings card`. */
export function catalogWithGetByTokenId(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter((e) => e.supportsGetByTokenId);
}
