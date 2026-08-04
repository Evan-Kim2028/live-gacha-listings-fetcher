/**
 * Stable listing identity attribution.
 *
 * Primary key is NOT array index. It is derived only from source fields:
 *   provider + platform + nativeId
 *
 * Other adapters: map their stable listing id into nativeId.
 */

export interface IdentityParts {
  provider: string;
  platform: string;
  nativeId: string;
}

const SEP = ":";

function scrub(part: string): string {
  return part.trim().toLowerCase().replace(/\s+/g, "_");
}

/** Build deterministic primary key. Throws if any part empty. */
export function listingId(parts: IdentityParts): string {
  const provider = scrub(parts.provider);
  const platform = scrub(parts.platform);
  const nativeId = parts.nativeId.trim();
  if (!provider || !platform || !nativeId) {
    throw new Error(
      `listingId requires non-empty provider, platform, nativeId; got ${JSON.stringify(parts)}`,
    );
  }
  // Keep nativeId case as provided (UUIDs / mints) but strip surrounding space.
  return `${provider}${SEP}${platform}${SEP}${nativeId}`;
}

/** Parse a listing id back into parts (nativeId may contain ':' — join remainder). */
export function parseListingId(id: string): IdentityParts {
  const first = id.indexOf(SEP);
  const second = id.indexOf(SEP, first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`invalid listing id: ${id}`);
  }
  return {
    provider: id.slice(0, first),
    platform: id.slice(first + 1, second),
    nativeId: id.slice(second + 1),
  };
}

/** Same logical listing from two observations? */
export function sameListing(a: IdentityParts, b: IdentityParts): boolean {
  return listingId(a) === listingId(b);
}
