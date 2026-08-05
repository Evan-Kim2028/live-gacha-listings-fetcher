/**
 * Currencies whose unit price is directly comparable to a USD-denominated FMV.
 * Origin FMV (e.g. Collector Crypt `insuredValue`) is always USD, so a delta is
 * only meaningful when the listing price is USD-denominated too.
 */
const USD_EQUIVALENT_CURRENCIES = new Set(["USD", "USDC", "USDT"]);

/** True when `currency` is a USD-equivalent unit (case-insensitive). */
export function isUsdEquivalentCurrency(
  currency: string | null | undefined,
): boolean {
  if (currency == null) return false;
  return USD_EQUIVALENT_CURRENCIES.has(currency.trim().toUpperCase());
}

/**
 * Origin-compatible delta %: `round(((price - fmv) / fmv) * 100)`.
 * Returns null when fmv is missing, non-finite, or ≤ 0.
 *
 * Unit-blind: callers must ensure `price` and `fmv` share a denomination.
 * Prefer {@link deltaFromListing}, which enforces that.
 */
export function deltaFromPriceAndFmv(
  price: number,
  fmv: number | null | undefined,
): number | null {
  if (fmv == null || !Number.isFinite(fmv) || fmv <= 0) return null;
  if (!Number.isFinite(price)) return null;
  return Math.round(((price - fmv) / fmv) * 100);
}

/**
 * Delta % for a listing priced in `currency` against a USD `fmv`.
 *
 * Returns null for non-USD-denominated prices (SOL, ETH, ...) rather than
 * dividing a native-token price by a USD FMV — that comparison produced a
 * fake ~-97% "below FMV" on every SOL-priced row.
 */
export function deltaFromListing(
  price: number,
  fmv: number | null | undefined,
  currency: string | null | undefined,
): number | null {
  if (!isUsdEquivalentCurrency(currency)) return null;
  return deltaFromPriceAndFmv(price, fmv);
}
