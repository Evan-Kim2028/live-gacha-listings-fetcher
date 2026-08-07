/**
 * TCG card identity — the cross-venue identity layer.
 *
 * The same physical card exists on every venue with a DIFFERENT id (CC mint,
 * ME mint, Courtyard proofOfIntegrity, Beezie tokenId). Venue-scoped identity
 * (listingId) is exact; cross-venue identity is inferred.
 *
 * Strategy, in order of reliability:
 *   1. Structured attributes when the origin provides them (Beezie
 *      metadata.attributes trait_type/trait_value; Courtyard attributes
 *      name/value) — exact.
 *   2. Title parsing for venues without structured attrs (CC, ME):
 *      year / grader / grade / set+#number extraction, name = remainder.
 *
 * Identity deliberately EXCLUDES grader and grade — they are instrument
 * attributes (a PSA 9 and a CGC 9 of the same card are the same card, two
 * instruments), not card identity.
 */
import type { Listing } from "./types.js";

export interface CardIdentity {
  tcg: string | null;
  name: string | null;
  set: string | null;
  number: string | null;
  year: number | null;
  language: string | null;
  variant: string | null;
  /** Sealed / booster / box products are not cards — identity is weak. */
  sealed: boolean;
}

const GRADERS = /\b(PSA|CGC|BGS|TAG|Beckett|SGC)\b/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const NUMBER_RE = /#\s*(\d{1,4}(?:\/\d{1,4})?)\b/i;
const SEALED_RE = /booster|pack|sealed|box|case|sleeve|etb|elite trainer/i;

function norm(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? t : null;
}

/** Structured attributes from a listing's origin row, lowercased → value. */
export function structuredAttrs(listing: Listing): Map<string, string> {
  const out = new Map<string, string>();
  const raw = listing.raw as
    | {
        metadata?: { attributes?: Array<{ trait_type?: string; trait_value?: string }> };
        attributes?: Array<{ name?: string; value?: string }>;
      }
    | undefined;
  if (!raw || typeof raw !== "object") return out;
  for (const a of raw.metadata?.attributes ?? []) {
    if (a.trait_type && a.trait_value != null) {
      out.set(String(a.trait_type).toLowerCase(), String(a.trait_value));
    }
  }
  for (const a of raw.attributes ?? []) {
    if (a.name && a.value != null) {
      out.set(String(a.name).toLowerCase(), String(a.value));
    }
  }
  return out;
}

/**
 * Set-name dictionary for title parsing. Venues without structured attrs
 * (CC, ME) put set+name together before the `#number`; the boundary is only
 * resolvable with a set list. Seed via {@link seedSetDictionary} (Beezie's
 * /marketplace/cards/filters returns the authoritative set facet list).
 */
const DEFAULT_KNOWN_SETS = new Set([
  "base set", "evolutions", "obsidian flames", "pokemon 151", "team rocket",
  "evolving skies", "crown zenith", "scovillian skies",
]);
let KNOWN_SETS: ReadonlySet<string> = DEFAULT_KNOWN_SETS;

/** Replace the set-name dictionary (Beezie filters endpoint is a good source). */
export function seedSetDictionary(sets: Iterable<string>): void {
  KNOWN_SETS = new Set([...sets].map((s) => s.toLowerCase().trim()).filter(Boolean));
}

export function knownSets(): ReadonlySet<string> {
  return KNOWN_SETS;
}

/** Longest set-name match in a title (or null). */
function matchSet(title: string): { set: string; index: number; end: number } | null {
  const lower = title.toLowerCase();
  let best: { set: string; index: number; end: number } | null = null;
  for (const set of KNOWN_SETS) {
    const idx = lower.indexOf(set);
    if (idx < 0) continue;
    if (!best || set.length > best.set.length) {
      best = { set, index: idx, end: idx + set.length };
    }
  }
  return best;
}

/** Parse a raw marketplace title into a card identity (best effort). */
export function identityFromTitle(title: string): CardIdentity {
  const t = String(title ?? "").trim();
  const sealed = SEALED_RE.test(t);
  const yearMatch = t.match(YEAR_RE);
  const numberMatch = t.match(NUMBER_RE);
  const year = yearMatch ? Number(yearMatch[0]) : null;

  let name: string | null = null;
  let set: string | null = null;
  if (numberMatch) {
    const before = t.slice(0, numberMatch.index).trim();
    // Set/name boundary: longest set-name dictionary match wins; the
    // remainder before `#number` is the card name. Without a match we make
    // no set claim (name = whole prefix) — honest rather than wrong.
    const setMatch = matchSet(before);
    let preName: string | null = null;
    if (setMatch) {
      set = before.slice(setMatch.index, setMatch.end).trim() || null;
      preName =
        (before.slice(0, setMatch.index) + " " + before.slice(setMatch.end))
          .replace(YEAR_RE, "")
          .replace(/[-–—]\s*$/, "")
          .trim() || null;
    } else {
      set = null;
      preName = before.replace(YEAR_RE, "").replace(/[-–—]\s*$/, "").trim() || null;
    }
    // After-# remainder ("PSA 9", "(CGC 8 NM-MT)") is grader/grade noise;
    // use it only when the pre-# name is empty.
    const after = t.slice((numberMatch.index ?? 0) + numberMatch[0].length).trim();
    const cleaned = after
      .replace(GRADERS, "")
      .replace(/\b\d+(?:\.\d+)?\b/, "") // grade number
      .replace(/^[-–—\s]+/, "")
      .replace(/\(.*?\)/g, "")
      .replace(/^\s*[-–—]\s*/, "")
      .trim();
    name = preName || cleaned || null;
  } else {
    // No #number: treat the whole title minus year/grader as a loose name.
    name =
      t
        .replace(YEAR_RE, "")
        .replace(GRADERS, "")
        .replace(/\(.*?\)/g, "")
        .replace(/\s{2,}/g, " ")
        .trim() || null;
  }
  return {
    tcg: null,
    name: norm(name),
    set: norm(set),
    number: numberMatch ? norm(numberMatch[1]) : null,
    year,
    language: null,
    variant: null,
    sealed,
  };
}

/** Card identity for a normalized listing (structured attrs first). */
export function identityFromListing(listing: Listing): CardIdentity {
  const attrs = structuredAttrs(listing);
  const tcg =
    listing.tcg ??
    (attrs.has("category") ? attrs.get("category") : null) ??
    null;
  const yearRaw = attrs.get("year") ?? (listing.year != null ? String(listing.year) : null);
  const year = yearRaw ? Number(yearRaw) || null : null;
  const hasStructured =
    attrs.has("pokemon name") ||
    attrs.has("title/subject") ||
    attrs.has("title");
  if (hasStructured) {
    const name = attrs.get("pokemon name") ?? attrs.get("title/subject") ?? attrs.get("title");
    const set = attrs.get("set name") ?? attrs.get("set");
    const number = attrs.get("card number") ?? attrs.get("reference") ?? null;
    const language = attrs.get("language") ?? null;
    const variant = attrs.get("finish") ?? attrs.get("variant") ?? null;
    return {
      tcg,
      name: norm(name),
      set: norm(set),
      number: norm(number),
      year,
      language: norm(language),
      variant: norm(variant),
      sealed: SEALED_RE.test(listing.name ?? ""),
    };
  }
  return { ...identityFromTitle(listing.name ?? ""), tcg };
}

/** Deterministic cross-venue identity key (grade/grader intentionally excluded). */
export function identityKey(id: CardIdentity): string {
  const p = (s: string | number | null | undefined) =>
    String(s ?? "").toLowerCase().trim();
  return [p(id.tcg), p(id.set), p(id.number), p(id.name), p(id.year), p(id.language), p(id.variant)]
    .join("|")
    .replace(/\s+/g, " ");
}

/** Identity key for a listing, or null when nothing reliable was parsed. */
export function identityKeyFromListing(listing: Listing): string | null {
  const id = identityFromListing(listing);
  if (id.sealed) return null;
  if (!id.name && !id.set) return null;
  return identityKey(id);
}
