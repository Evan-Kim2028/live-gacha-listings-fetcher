/**
 * Public listing deep-link helpers for origin marketplaces.
 *
 * This library is **read-only**: `externalUrl` and {@link formatOpenCommand}
 * exist so operators / UIs can open the origin listing page in a browser.
 * There is no buy / list / offer / broadcast / tx building here.
 */

/**
 * Collector Crypt public card page.
 * Documented web pattern: `https://collectorcrypt.com/cards/{nftAddress}`.
 * Same path also resolves for CC catalog card ids when mint is absent.
 * Deep-link only — no buy/list/offer tx.
 */
export function ccListingUrl(
  nftAddressOrCardId: string | null | undefined,
): string | null {
  if (nftAddressOrCardId == null) return null;
  const key = String(nftAddressOrCardId).trim();
  if (!key) return null;
  return `https://collectorcrypt.com/cards/${key}`;
}

/** Magic Eden item-details page (Solana mint). */
export function meListingUrl(mint: string | null | undefined): string | null {
  if (mint == null) return null;
  const m = String(mint).trim();
  if (!m) return null;
  return `https://magiceden.io/item-details/${m}`;
}

/**
 * Phygitals card page. Prefer human slug when present; fall back to mint address.
 */
export function phygitalsListingUrl(
  slugOrAddress: string | null | undefined,
): string | null {
  if (slugOrAddress == null) return null;
  const s = String(slugOrAddress).trim();
  if (!s) return null;
  return `https://www.phygitals.com/card/${s}`;
}

/** Courtyard asset page (proof-of-integrity / token id). */
export function courtyardListingUrl(
  tokenId: string | null | undefined,
): string | null {
  if (tokenId == null) return null;
  const t = String(tokenId).trim();
  if (!t) return null;
  return `https://courtyard.io/asset/${t}`;
}

/**
 * Renaiss public card page. Prefer on-chain `tokenId` (homepage links use
 * `/card/{tokenId}`); UUID `id` is not the public path key.
 */
export function renaissListingUrl(
  tokenId: string | null | undefined,
): string | null {
  if (tokenId == null) return null;
  const t = String(tokenId).trim();
  if (!t) return null;
  return `https://www.renaiss.xyz/card/${t}`;
}

/**
 * DYLI product page (`/p/[slug]` Next route). Product numeric/string `id`
 * works as the path segment when origin does not supply a URL.
 */
export function dyliListingUrl(
  productId: string | number | null | undefined,
): string | null {
  if (productId == null) return null;
  const id = String(productId).trim();
  if (!id) return null;
  return `https://www.dyli.io/p/${id}`;
}

/**
 * Prefer an explicit origin URL field; otherwise null.
 * Used when origin may carry `external_url` / `url`, and as the only option
 * for catalogs (Beezie) with no stable constructible public path from ids.
 */
export function originProvidedUrl(
  row: Record<string, unknown> | object | null | undefined,
): string | null {
  if (row == null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  for (const k of ["external_url", "externalUrl", "url", "href"] as const) {
    const v = r[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) {
      return v.trim();
    }
  }
  return null;
}

/**
 * Shell command that opens a listing deep-link in the default browser.
 * Deep-link **only** — never signs or submits marketplace transactions.
 *
 * @returns null when url is missing / not http(s)
 */
export function formatOpenCommand(
  url: string | null | undefined,
  opts?: { platform?: NodeJS.Platform },
): string | null {
  if (url == null) return null;
  const u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) return null;
  // Single-quote for POSIX shells; escape embedded quotes.
  const quoted = `'${u.replace(/'/g, `'\\''`)}'`;
  const p = opts?.platform ?? process.platform;
  if (p === "darwin") return `open ${quoted}`;
  if (p === "win32") return `cmd /c start "" ${quoted}`;
  return `xdg-open ${quoted}`;
}
