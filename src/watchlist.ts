import { readFileSync } from "node:fs";
import type { Listing } from "./types.js";
import { instrumentKeyFromListing } from "./orderbook/instrument.js";

/**
 * Client-side watchlist: keep listings that match any criterion (OR).
 * Empty / missing fields mean no restriction from that axis.
 * Fully empty watchlist matches everything.
 */
export interface Watchlist {
  /** Case-insensitive name substrings (name / setRaw / searchBlob). */
  names?: string[];
  /** Exact instrument keys (case-insensitive). */
  instrumentKeys?: string[];
  /**
   * Mint addresses, token ids, native listing ids, scrydex ids, or card numbers
   * (case-insensitive exact match against listing identity fields).
   */
  ids?: string[];
}

export function isWatchlistEmpty(w?: Watchlist | null): boolean {
  if (!w) return true;
  return (
    !(w.names?.length) &&
    !(w.instrumentKeys?.length) &&
    !(w.ids?.length)
  );
}

/** Normalize + dedupe string lists (trim, drop empties, lower for compare sets). */
function normalizeList(xs?: string[] | null): string[] {
  if (!xs?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of xs) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Merge multiple watchlists (union of criteria). */
export function mergeWatchlists(
  ...lists: Array<Watchlist | undefined | null>
): Watchlist {
  const names: string[] = [];
  const instrumentKeys: string[] = [];
  const ids: string[] = [];
  for (const w of lists) {
    if (!w) continue;
    if (w.names) names.push(...w.names);
    if (w.instrumentKeys) instrumentKeys.push(...w.instrumentKeys);
    if (w.ids) ids.push(...w.ids);
  }
  const out: Watchlist = {};
  const n = normalizeList(names);
  const k = normalizeList(instrumentKeys);
  const i = normalizeList(ids);
  if (n.length) out.names = n;
  if (k.length) out.instrumentKeys = k;
  if (i.length) out.ids = i;
  return out;
}

/**
 * True when listing hits any name substring, instrument key, or id.
 * Empty watchlist → true (no client restriction).
 */
export function listingMatchesWatchlist(
  listing: Listing,
  watchlist?: Watchlist | null,
): boolean {
  if (isWatchlistEmpty(watchlist)) return true;
  const w = watchlist!;

  if (w.names?.length) {
    const hay =
      `${listing.name} ${listing.setRaw ?? ""} ${listing.searchBlob ?? ""}`.toLowerCase();
    for (const n of w.names) {
      const needle = n.trim().toLowerCase();
      if (needle && hay.includes(needle)) return true;
    }
  }

  if (w.instrumentKeys?.length) {
    const key = instrumentKeyFromListing(listing).toLowerCase();
    for (const k of w.instrumentKeys) {
      if (k.trim().toLowerCase() === key) return true;
    }
  }

  if (w.ids?.length) {
    const candidates = [
      listing.tokenId,
      listing.nativeId,
      listing.id,
      listing.cardNumber,
      listing.canonical?.scrydex_id != null
        ? String(listing.canonical.scrydex_id)
        : null,
      listing.contractAddress,
    ]
      .filter((x): x is string => x != null && String(x).trim() !== "")
      .map((x) => String(x).toLowerCase());
    const candSet = new Set(candidates);
    for (const id of w.ids) {
      const needle = id.trim().toLowerCase();
      if (needle && candSet.has(needle)) return true;
    }
  }

  return false;
}

/**
 * Parse comma-separated CLI terms into a watchlist.
 * Prefixes (optional):
 *   name:foo / n:foo → names
 *   key:foo / ik:foo → instrumentKeys
 *   id:foo / mint:foo / card:foo → ids
 * Bare terms default to name substrings.
 */
export function parseWatchlistString(input: string): Watchlist {
  const names: string[] = [];
  const instrumentKeys: string[] = [];
  const ids: string[] = [];
  for (const part of input.split(/[,;\n]+/)) {
    const raw = part.trim();
    if (!raw || raw.startsWith("#")) continue;
    const colon = raw.indexOf(":");
    if (colon > 0) {
      const prefix = raw.slice(0, colon).toLowerCase();
      const rest = raw.slice(colon + 1).trim();
      if (!rest) continue;
      if (prefix === "name" || prefix === "n") {
        names.push(rest);
        continue;
      }
      if (prefix === "key" || prefix === "ik" || prefix === "instrument") {
        instrumentKeys.push(rest);
        continue;
      }
      if (
        prefix === "id" ||
        prefix === "mint" ||
        prefix === "card" ||
        prefix === "scry"
      ) {
        ids.push(rest);
        continue;
      }
    }
    // Bare: treat long base58-ish / hex as id, else name substring
    if (looksLikeId(raw)) ids.push(raw);
    else names.push(raw);
  }
  return mergeWatchlists({ names, instrumentKeys, ids });
}

/** Heuristic: Solana mint / long hex / UUID-like → id bucket. */
function looksLikeId(s: string): boolean {
  if (s.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return true; // base58
  if (s.length >= 32 && /^[0-9a-fA-F-]+$/.test(s)) return true; // hex/uuid
  return false;
}

/**
 * Load watchlist from file.
 * - JSON object with names / instrumentKeys / ids
 * - JSON string array → names
 * - Otherwise parseWatchlistString on full text (lines + commas)
 */
export function loadWatchlistFile(path: string): Watchlist {
  const text = readFileSync(path, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return mergeWatchlists({
          names: parsed.map((x) => String(x)),
        });
      }
      if (parsed && typeof parsed === "object") {
        const o = parsed as Record<string, unknown>;
        return mergeWatchlists({
          names: asStringArray(o.names ?? o.nameSubstrings),
          instrumentKeys: asStringArray(
            o.instrumentKeys ?? o.keys ?? o.instruments,
          ),
          ids: asStringArray(o.ids ?? o.mints ?? o.cardIds ?? o.mintOrCardIds),
        });
      }
    } catch {
      // fall through to line/csv parse
    }
  }
  return parseWatchlistString(text);
}

function asStringArray(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") return [v];
  return undefined;
}

/** Stable compact form for querySignature (sorted). */
export function watchlistSignature(w?: Watchlist | null): string | undefined {
  if (isWatchlistEmpty(w)) return undefined;
  const parts: string[] = [];
  const n = normalizeList(w!.names)
    .map((x) => x.toLowerCase())
    .sort();
  const k = normalizeList(w!.instrumentKeys)
    .map((x) => x.toLowerCase())
    .sort();
  const i = normalizeList(w!.ids)
    .map((x) => x.toLowerCase())
    .sort();
  if (n.length) parts.push(`n:${n.join(",")}`);
  if (k.length) parts.push(`k:${k.join(",")}`);
  if (i.length) parts.push(`i:${i.join(",")}`);
  return parts.join("|") || undefined;
}
