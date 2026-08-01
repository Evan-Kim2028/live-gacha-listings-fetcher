import type { PullQuery } from "./providers/types.js";
import { watchlistSignature } from "./watchlist.js";

/**
 * Canonical query key for short-circuit + snapshot scope.
 * Includes all decision-relevant pull/filter fields — order-independent.
 */
export function querySignature(query: PullQuery = {}): string {
  const parts: [string, string][] = [];
  const add = (k: string, v: string | number | boolean | undefined | null) => {
    if (v === undefined || v === null || v === "") return;
    parts.push([k, String(v)]);
  };
  add("limit", query.limit);
  add("offset", query.offset);
  add("sort", query.sort);
  add("tcg", query.tcg);
  add("q", query.q);
  add("platform", query.platform);
  add("itemType", query.itemType);
  add("grader", query.grader);
  add("grade", query.grade);
  add("language", query.language);
  add("activity", query.activity);
  add("canonical", query.canonical);
  add("priceMin", query.priceMin);
  add("priceMax", query.priceMax);
  add("yearMin", query.yearMin);
  add("yearMax", query.yearMax);
  add("maxDelta", query.maxDelta);
  add("requireFmv", query.requireFmv ? "1" : undefined);
  add("watchlist", watchlistSignature(query.watchlist));
  add("fixturePath", query.fixturePath);
  add("offline", query.offline ? "1" : undefined);
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (parts.length === 0) return "";
  return parts.map(([k, v]) => `${k}=${v}`).join("&");
}

export function scopeKey(providerId: string, qsig: string): string {
  return qsig ? `${providerId}::${qsig}` : providerId;
}
