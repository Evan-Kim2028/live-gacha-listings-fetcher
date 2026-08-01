import type { Listing, SyncResult } from "../types.js";

/** Wire format of traded.gg `/api/radar/stream` data lines. */
export type TradedStreamWire =
  | { type: "new"; row: Record<string, unknown> }
  | { type: "reprice"; row: Record<string, unknown> }
  | {
      type: "closed";
      instance_id: string;
      platform: string;
      reason?: string;
    }
  | { type: string; [key: string]: unknown };

export type FeedStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "polling"
  | "stopped";

/** Consumer-facing stream events (decision-oriented). */
export type FeedEvent =
  | { kind: "status"; status: FeedStatus; at: string }
  | { kind: "snapshot"; result: SyncResult; at: string }
  | {
      kind: "upsert";
      event: "new" | "reprice";
      listing: Listing;
      changed: boolean;
      at: string;
    }
  | {
      kind: "close";
      id: string;
      platform: string;
      reason: string;
      removed: boolean;
      at: string;
    }
  | { kind: "error"; error: string; at: string };

export interface FeedStats {
  status: FeedStatus;
  snapshots: number;
  upserts: number;
  closes: number;
  errors: number;
  lastEventAt: string | null;
  lastBuiltAt: string | null;
}
