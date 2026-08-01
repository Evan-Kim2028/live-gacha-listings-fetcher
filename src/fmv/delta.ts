/**
 * Origin-compatible delta %: `round(((price - fmv) / fmv) * 100)`.
 * Returns null when fmv is missing, non-finite, or ≤ 0.
 */
export function deltaFromPriceAndFmv(
  price: number,
  fmv: number | null | undefined,
): number | null {
  if (fmv == null || !Number.isFinite(fmv) || fmv <= 0) return null;
  if (!Number.isFinite(price)) return null;
  return Math.round(((price - fmv) / fmv) * 100);
}
