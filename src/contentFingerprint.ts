/**
 * Stable content generation for native adapters that lack server builtAt.
 * Keys on id|price|listedAt (cheaper proxy than full listingsEqual).
 * Published as SnapshotMeta.contentFingerprint and as builtAt (fp:…) so
 * generation short-circuit works even when HTTP ETag is absent.
 */

export type FingerprintRow = {
  id: string;
  price: number;
  listedAt?: string | null;
};

/** FNV-1a 32-bit → hex (no node:crypto dependency for browser-friendly builds). */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * `fp:<hex>` of sorted `id|price|listedAt` lines.
 * Empty listing set → stable `fp:empty`.
 */
export function contentFingerprint(listings: FingerprintRow[]): string {
  if (listings.length === 0) return "fp:empty";
  const payload = listings
    .map((r) => `${r.id}|${r.price}|${r.listedAt ?? ""}`)
    .sort()
    .join("\n");
  return `fp:${fnv1aHex(payload)}`;
}
