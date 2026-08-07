/**
 * Durable, queryable listing history on SQLite (node:sqlite — zero deps).
 *
 * Append-only price/lifecycle events per listing identity:
 *   - `new`     first time an id is observed with a price
 *   - `reprice` price changed since the last recorded event
 *   - `closed`  id left the retrievable set (delist / sold)
 *
 * 'seen' events are NOT written (they would spam every poll tick); the
 * event stream is the price/lifecycle story. `recordSyncResult` is idempotent
 * under re-runs (last-known price is tracked in-process per id).
 *
 * Fed from PollEngine (option `history`) and usable from the CLI:
 *   traded-listings history <tokenId> --db data/history.db
 */
import { DatabaseSync } from "node:sqlite";
import type { DelistEvent } from "../lifecycle/delist.js";
import type { SyncResult } from "../types.js";

export type HistoryEventKind = "new" | "reprice" | "closed";

export interface PricePoint {
  seenAt: string;
  event: HistoryEventKind;
  price: number | null;
  fmv: number | null;
  name: string | null;
  provider: string | null;
  listingId: string;
}

export interface CardLifetime {
  tokenId: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  firstPrice: number | null;
  lastPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  eventCount: number;
  repriceCount: number;
  delistedAt: string | null;
  isActive: boolean;
  venues: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  provider TEXT,
  token_id TEXT,
  name TEXT,
  price REAL,
  fmv REAL,
  event TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  last_best_ask REAL,
  last_best_bid REAL
);
CREATE INDEX IF NOT EXISTS idx_events_token ON listing_events(token_id, seen_at);
CREATE INDEX IF NOT EXISTS idx_events_listing ON listing_events(listing_id, seen_at);
`;

export class HistoryStore {
  private readonly db: DatabaseSync;
  /** listing_id → last recorded price (event dedupe across sync results). */
  private readonly lastPrice = new Map<string, number>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  /** Record new/reprice events for the listings in a sync result. */
  recordSyncResult(result: SyncResult, seenAt: string = new Date().toISOString()): number {
    let written = 0;
    const stmt = this.db.prepare(
      `INSERT INTO listing_events
         (listing_id, provider, token_id, name, price, fmv, event, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of result.listings) {
      const prev = this.lastPrice.get(l.id);
      const kind: HistoryEventKind | "seen" =
        prev === undefined ? "new" : prev !== l.price ? "reprice" : "seen";
      this.lastPrice.set(l.id, l.price);
      if (kind === "seen") continue;
      stmt.run(
        l.id,
        l.provider,
        l.tokenId ?? null,
        l.name ?? null,
        Number.isFinite(l.price) ? l.price : null,
        l.fmv ?? null,
        kind,
        seenAt,
      );
      written += 1;
    }
    return written;
  }

  /** Record closed events for delists (last known TOB preserved). */
  recordDelists(events: DelistEvent[], seenAt: string = new Date().toISOString()): number {
    const stmt = this.db.prepare(
      `INSERT INTO listing_events
         (listing_id, provider, token_id, name, price, event, seen_at, last_best_ask, last_best_bid)
       VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?)`,
    );
    const lastKnown = this.db.prepare(
      `SELECT token_id, name, provider FROM listing_events
       WHERE listing_id = ? ORDER BY id DESC LIMIT 1`,
    );
    for (const ev of events) {
      const prev = lastKnown.get(ev.listingId) as
        | { token_id: string | null; name: string | null; provider: string | null }
        | undefined;
      stmt.run(
        ev.listingId,
        prev?.provider ?? ev.provider,
        prev?.token_id ?? null,
        prev?.name ?? null,
        ev.lastBestAsk ?? null,
        seenAt,
        ev.lastBestAsk ?? null,
        ev.lastBestBid ?? null,
      );
      this.lastPrice.delete(ev.listingId);
    }
    return events.length;
  }

  /** Recent price/lifecycle events for a token (newest first). */
  priceHistory(tokenId: string, limit = 100): PricePoint[] {
    const rows = this.db
      .prepare(
        `SELECT listing_id, provider, token_id, name, price, fmv, event, seen_at
         FROM listing_events
         WHERE token_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(tokenId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seenAt: String(r.seen_at),
      event: r.event as HistoryEventKind,
      price: r.price == null ? null : Number(r.price),
      fmv: r.fmv == null ? null : Number(r.fmv),
      name: r.name == null ? null : String(r.name),
      provider: r.provider == null ? null : String(r.provider),
      listingId: String(r.listing_id),
    }));
  }

  /** Lifetime summary for a token across venues. */
  cardLifetime(tokenId: string): CardLifetime | null {
    const rows = this.db
      .prepare(
        `SELECT listing_id, provider, name, price, fmv, event, seen_at
         FROM listing_events
         WHERE token_id = ?
         ORDER BY id ASC`,
      )
      .all(tokenId) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const prices = rows
      .map((r) => Number(r.price))
      .filter((p) => Number.isFinite(p) && p > 0);
    const closes = rows.filter((r) => r.event === "closed") as Array<
      Record<string, unknown> & { id: number }
    >;
    const last = rows[rows.length - 1] as Record<string, unknown> & { id: number };
    const latestOpen = [...rows].reverse().find((r) => r.event !== "closed");
    return {
      tokenId,
      firstSeenAt: String(rows[0]!.seen_at),
      lastSeenAt: String(last.seen_at),
      firstPrice: rows[0]!.price == null ? null : Number(rows[0]!.price),
      lastPrice:
        latestOpen?.price == null ? null : Number(latestOpen.price),
      minPrice: prices.length ? Math.min(...prices) : null,
      maxPrice: prices.length ? Math.max(...prices) : null,
      eventCount: rows.length,
      repriceCount: rows.filter((r) => r.event === "reprice").length,
      delistedAt: closes.length ? String(closes[closes.length - 1]!.seen_at) : null,
      isActive: closes.length === 0 || closes[closes.length - 1]!.id < last.id,
      venues: [...new Set(rows.map((r) => String(r.provider)).filter(Boolean))],
    };
  }

  /** Newest events across all tokens (ops / feed). */
  recentEvents(limit = 50): PricePoint[] {
    const rows = this.db
      .prepare(
        `SELECT listing_id, provider, token_id, name, price, fmv, event, seen_at
         FROM listing_events
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seenAt: String(r.seen_at),
      event: r.event as HistoryEventKind,
      price: r.price == null ? null : Number(r.price),
      fmv: r.fmv == null ? null : Number(r.fmv),
      name: r.name == null ? null : String(r.name),
      provider: r.provider == null ? null : String(r.provider),
      listingId: String(r.listing_id),
    }));
  }

  /** Row count (tests / ops). */
  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM listing_events").get() as { n: number };
    return Number(row.n);
  }

  close(): void {
    this.db.close();
  }
}
