import { listingMatchesFilter } from "../filter.js";
import { listingId } from "../identity.js";
import type { PullQuery } from "../providers/types.js";
import {
  normalizeTradedRow,
  type TradedRadarRow,
} from "../providers/tradedgg.js";
import { querySignature } from "../querySignature.js";
import type { ListingStore } from "../store.js";
import type { FeedEvent, TradedStreamWire } from "./types.js";

const STREAM_SCOPE = "__stream__";

export function streamScope(
  filter: PullQuery = {},
): { provider: string; querySignature: string } {
  const qsig = querySignature(filter);
  // Dedicated stream namespace so filtered sessions don't share scope keys
  return {
    provider: "tradedgg",
    querySignature: qsig ? `${STREAM_SCOPE}&${qsig}` : STREAM_SCOPE,
  };
}

export interface ApplyDeltaOptions {
  /** Client-side subset (e.g. tcg=pokemon). SSE is unfiltered at source. */
  filter?: PullQuery;
  at?: string;
}

/**
 * Apply one traded.gg SSE wire message to the store.
 * When filter is set, non-matching upserts are ignored (closes still remove).
 */
export function applyTradedDelta(
  store: ListingStore,
  wire: TradedStreamWire,
  atOrOpts: string | ApplyDeltaOptions = new Date().toISOString(),
): FeedEvent | null {
  const opts: ApplyDeltaOptions =
    typeof atOrOpts === "string" ? { at: atOrOpts } : atOrOpts;
  const at = opts.at ?? new Date().toISOString();
  const filter = opts.filter ?? {};
  const scope = streamScope(filter);

  if (wire.type === "new" || wire.type === "reprice") {
    const row = wire.row as unknown as TradedRadarRow;
    if (!row?.instance_id || !row?.platform) return null;
    const listing = normalizeTradedRow(row, "tradedgg");
    if (!listingMatchesFilter(listing, filter)) {
      // If filtered out after reprice, drop from our subset scope
      if (wire.type === "reprice") {
        store.removeOne(listing.id);
      }
      return null;
    }
    const { changed } = store.upsertOne(listing, scope, at);
    const stored = store.get(listing.id) ?? listing;
    return {
      kind: "upsert",
      event: wire.type,
      listing: stored,
      changed,
      at,
    };
  }

  if (wire.type === "closed") {
    const instanceId = String(
      (wire as { instance_id?: string }).instance_id ?? "",
    );
    const platform = String((wire as { platform?: string }).platform ?? "");
    const reason = String((wire as { reason?: string }).reason ?? "unknown");
    if (!instanceId || !platform) return null;
    const id = listingId({
      provider: "tradedgg",
      platform,
      nativeId: instanceId,
    });
    const removed = store.removeOne(id);
    return {
      kind: "close",
      id,
      platform,
      reason,
      removed,
      at,
    };
  }

  return null;
}

export { STREAM_SCOPE };
