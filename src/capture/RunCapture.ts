import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { scopeKey } from "../querySignature.js";
import type { Listing, SyncResult } from "../types.js";
import { ListingChangeLog } from "./ListingChangeLog.js";
import type {
  BookChangeInput,
  BookChangeRecord,
  HealthRecord,
  ListingChangeEvent,
  OnSyncExtra,
  RunCaptureMode,
  RunCaptureOptions,
  ScopeRef,
  SnapshotFileBody,
  SoldRecord,
} from "./types.js";

/** FNV-1a 32-bit hex (matches contentFingerprint style, no crypto). */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function qsigHash(qsig: string): string {
  if (!qsig) return "default";
  return fnv1aHex(qsig);
}

function isoPathSafe(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

function bookFp(input: {
  instrumentKey: string;
  bestBid: number | null;
  bestAsk: number | null;
  currency?: string;
}): string {
  const s = `${input.instrumentKey}|${input.bestBid ?? ""}|${input.bestAsk ?? ""}|${input.currency ?? ""}`;
  return fnv1aHex(s);
}

function normalizeBook(input: BookChangeInput): {
  instrumentKey: string;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  mid: number | null;
  currency?: string;
} {
  if ("bids" in input || "asks" in input) {
    const b = input as {
      instrumentKey: string;
      bestBid: number | null;
      bestAsk: number | null;
      spread: number | null;
      mid: number | null;
    };
    return {
      instrumentKey: b.instrumentKey,
      bestBid: b.bestBid,
      bestAsk: b.bestAsk,
      spread: b.spread,
      mid: b.mid,
    };
  }
  const x = input as {
    instrumentKey: string;
    bestBid: number | null;
    bestAsk: number | null;
    spread?: number | null;
    mid?: number | null;
    currency?: string;
  };
  const bestBid = x.bestBid;
  const bestAsk = x.bestAsk;
  const spread =
    x.spread ??
    (bestBid != null && bestAsk != null ? bestAsk - bestBid : null);
  const mid =
    x.mid ??
    (bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null);
  return {
    instrumentKey: x.instrumentKey,
    bestBid,
    bestAsk,
    spread,
    mid,
    currency: x.currency,
  };
}

/**
 * Run-directory capture: append-only listing deltas, sparse per-scope
 * snapshots, top-of-book lines, health ticks.
 *
 * Layout (docs/RUNTIME_PROOF.md):
 *   full: meta.json, events.jsonl, books.jsonl, health.jsonl, sold.jsonl, snapshots/
 *   lean: meta.json, health.jsonl, sold.jsonl only (no events/books/run-snapshots)
 */
export class RunCapture {
  readonly runDir: string;
  readonly log: ListingChangeLog;
  readonly mode: RunCaptureMode;
  private readonly checkpointMs: number;
  private readonly now: () => Date;
  private readonly healthOnShortCircuit: boolean;
  private readonly bookFpByKey = new Map<string, string>();
  private readonly lastCheckpointAt = new Map<string, number>();
  private readonly hasSnapshotted = new Set<string>();
  private closed = false;
  private startedAt: string;

  private constructor(runDir: string, opts: RunCaptureOptions = {}) {
    this.runDir = runDir;
    this.mode =
      opts.mode === "lean" || opts.lean === true ? "lean" : "full";
    // Lean never retains full page copies for snapshots (saves dual-book RAM).
    this.log = new ListingChangeLog({
      retainScopeListings: this.mode === "full",
    });
    this.checkpointMs = opts.checkpointMs ?? 300_000;
    this.now = opts.now ?? (() => new Date());
    this.healthOnShortCircuit = opts.healthOnShortCircuit ?? true;
    this.startedAt = this.now().toISOString();
  }

  get lean(): boolean {
    return this.mode === "lean";
  }

  /** Create run directory, write meta.json, return ready capture handle. */
  static open(runDir: string, opts: RunCaptureOptions = {}): RunCapture {
    mkdirSync(runDir, { recursive: true });
    const cap = new RunCapture(runDir, opts);
    if (cap.mode === "full") {
      mkdirSync(join(runDir, "snapshots"), { recursive: true });
    }
    const meta = {
      startedAt: cap.startedAt,
      checkpointMs: cap.checkpointMs,
      mode: cap.mode,
      libNote:
        cap.mode === "lean"
          ? "RunCapture lean: health + sold only"
          : "RunCapture + ListingChangeLog",
      ...(opts.meta ?? {}),
    };
    writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    const files =
      cap.mode === "lean"
        ? (["health.jsonl", "sold.jsonl"] as const)
        : ([
            "events.jsonl",
            "health.jsonl",
            "books.jsonl",
            "sold.jsonl",
          ] as const);
    for (const name of files) {
      const p = join(runDir, name);
      if (!existsSync(p)) writeFileSync(p, "");
    }
    return cap;
  }

  /**
   * Record instrument leaving the book (sold/delisted). Appends sold.jsonl
   * and (full mode only) a mirror line on events.jsonl.
   */
  onSold(rec: Omit<SoldRecord, "ts" | "kind"> & { ts?: string }): SoldRecord {
    this.assertOpen();
    const full: SoldRecord = {
      ts: this.ts(rec.ts),
      kind: "sold",
      instrumentKey: rec.instrumentKey,
      lastBestBid: rec.lastBestBid,
      lastBestAsk: rec.lastBestAsk,
      currency: rec.currency,
      listingIds: rec.listingIds,
      reason: rec.reason,
    };
    this.appendJsonl("sold.jsonl", full);
    if (this.mode === "full") {
      this.appendJsonl("events.jsonl", full);
    }
    return full;
  }

  private ts(override?: string): string {
    return override ?? this.now().toISOString();
  }

  private appendJsonl(file: string, obj: unknown): void {
    appendFileSync(join(this.runDir, file), JSON.stringify(obj) + "\n", "utf8");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("RunCapture is closed");
  }

  /**
   * Process a SyncResult: health always (unless short-circuit health off),
   * listing deltas only in full mode when not short-circuited; soft_fail skips diff.
   * Lean: health only (sold goes through {@link onSold}).
   */
  onSyncResult(result: SyncResult, extra: OnSyncExtra = {}): ListingChangeEvent[] {
    this.assertOpen();
    const ts = this.ts(extra.ts);

    const wm = extra.watermark;
    const health: HealthRecord = {
      ts,
      provider: result.provider,
      durationMs: result.durationMs,
      shortCircuited: result.shortCircuited,
      fetched: result.fetched,
      upserted: result.upserted,
      unchanged: result.unchanged,
      pruned: result.pruned,
      activeCount: result.activeCount,
      builtAt: result.builtAt,
      querySignature: result.querySignature,
      softFail: extra.softFail === true || Boolean(extra.lastError),
      lastError: extra.lastError ?? wm?.lastError ?? null,
      lastSuccessfulPullAt: wm?.lastSuccessfulPullAt ?? null,
      lastRowCount: wm?.lastRowCount,
    };

    if (!result.shortCircuited || this.healthOnShortCircuit) {
      this.onHealth(health);
    }

    // Lean: no events.jsonl, no listing-diff log, no run snapshots.
    if (this.mode === "lean") {
      return [];
    }

    if (extra.softFail || extra.lastError) {
      const ev = this.log.softFail(result.provider, String(extra.lastError ?? "soft_fail"), {
        lastSuccessfulPullAt: wm?.lastSuccessfulPullAt ?? null,
        lastRowCount: wm?.lastRowCount,
        qsig: result.querySignature || undefined,
        ts,
      });
      this.appendJsonl("events.jsonl", ev);
      return [ev];
    }

    if (result.shortCircuited) return [];

    return this.onListingsDiff(
      result.listings,
      {
        provider: result.provider,
        querySignature: result.querySignature,
      },
      ts,
    );
  }

  /**
   * Diff listings against last known by id (price, listedAt, seller).
   * Writes deltas only to events.jsonl. Returns emitted events.
   * No-op in lean mode.
   */
  onListingsDiff(
    listings: Listing[],
    scope: ScopeRef,
    ts?: string,
  ): ListingChangeEvent[] {
    this.assertOpen();
    if (this.mode === "lean") return [];
    const at = this.ts(ts);
    const events = this.log.onListingsDiff(listings, scope, at);
    for (const ev of events) {
      this.appendJsonl("events.jsonl", ev);
    }
    const qsig = scope.querySignature ?? "";
    this.maybeCheckpoint(scope.provider, qsig, at);
    return events;
  }

  /**
   * Append books.jsonl only when top-of-book fingerprint changes.
   * No-op in lean mode (durable book lives under book-out / saveBook).
   */
  onBookChange(input: BookChangeInput, ts?: string): BookChangeRecord | null {
    this.assertOpen();
    if (this.mode === "lean") return null;
    const at = this.ts(ts);
    const b = normalizeBook(input);
    const fp = bookFp(b);
    const prev = this.bookFpByKey.get(b.instrumentKey);
    if (prev === fp) return null;
    this.bookFpByKey.set(b.instrumentKey, fp);
    const rec: BookChangeRecord = {
      ts: at,
      instrumentKey: b.instrumentKey,
      bestBid: b.bestBid,
      bestAsk: b.bestAsk,
      spread: b.spread,
      mid: b.mid,
      currency: b.currency,
      fp,
    };
    this.appendJsonl("books.jsonl", rec);
    return rec;
  }

  /** Append one health.jsonl line. */
  onHealth(record: HealthRecord | SyncResult, ts?: string): void {
    this.assertOpen();
    const at = this.ts(ts);
    if ("durationMs" in record && "shortCircuited" in record && "fetched" in record && "listings" in record) {
      const r = record as SyncResult;
      this.appendJsonl("health.jsonl", {
        ts: at,
        provider: r.provider,
        durationMs: r.durationMs,
        shortCircuited: r.shortCircuited,
        fetched: r.fetched,
        upserted: r.upserted,
        unchanged: r.unchanged,
        pruned: r.pruned,
        activeCount: r.activeCount,
        builtAt: r.builtAt,
        querySignature: r.querySignature,
      } satisfies HealthRecord);
      return;
    }
    const h = record as HealthRecord;
    this.appendJsonl("health.jsonl", { ...h, ts: h.ts || at });
  }

  /**
   * Write sparse snapshot JSON for a scope when dirty and either first
   * snapshot or checkpointMs elapsed since last write.
   * No-op in lean mode.
   */
  maybeCheckpoint(
    provider: string,
    querySignature = "",
    ts?: string,
  ): string | null {
    this.assertOpen();
    if (this.mode === "lean") return null;
    const at = this.ts(ts);
    const sk = scopeKey(provider, querySignature);
    const listings = this.log.listScope(provider, querySignature);
    const isFirst = !this.hasSnapshotted.has(sk);
    const dirty = this.log.isDirty(provider, querySignature);

    if (listings.length === 0) return null;
    if (!isFirst && !dirty) return null;

    const lastAt = this.lastCheckpointAt.get(sk);
    const nowMs = this.now().getTime();
    if (!isFirst && lastAt != null && nowMs - lastAt < this.checkpointMs) {
      return null;
    }

    return this.writeSnapshot(provider, querySignature, listings, at);
  }

  /** Force snapshot write for a scope (used on close). No-op path in lean mode. */
  writeSnapshot(
    provider: string,
    querySignature = "",
    listings?: Listing[],
    ts?: string,
  ): string {
    this.assertOpen();
    if (this.mode === "lean") return "";
    const at = this.ts(ts);
    const rows = listings ?? this.log.listScope(provider, querySignature);
    const sk = scopeKey(provider, querySignature);
    const file = `snapshots/${provider}__${qsigHash(querySignature)}__${isoPathSafe(new Date(at))}.json`;
    const body: SnapshotFileBody = {
      ts: at,
      provider,
      querySignature,
      listings: rows,
    };
    const abs = join(this.runDir, file);
    writeFileSync(abs, JSON.stringify(body) + "\n", "utf8");
    this.lastCheckpointAt.set(sk, this.now().getTime());
    this.hasSnapshotted.add(sk);
    this.log.clearDirty(provider, querySignature);
    return file;
  }

  /** Final dirty-scope snapshots (full mode) + meta.endedAt. Idempotent after first close. */
  close(): void {
    if (this.closed) return;
    if (this.mode === "full") {
      for (const sk of this.log.dirtyScopeKeys()) {
        const { provider, querySignature } = ListingChangeLog.parseScopeKey(sk);
        const listings = this.log.listScope(provider, querySignature);
        if (listings.length === 0 && !this.log.isDirty(provider, querySignature))
          continue;
        this.writeSnapshot(provider, querySignature, listings);
      }
    }
    const metaPath = join(this.runDir, "meta.json");
    try {
      const prev = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      prev.endedAt = this.now().toISOString();
      writeFileSync(metaPath, JSON.stringify(prev, null, 2) + "\n");
    } catch {
      writeFileSync(
        metaPath,
        JSON.stringify(
          { startedAt: this.startedAt, endedAt: this.now().toISOString() },
          null,
          2,
        ) + "\n",
      );
    }
    this.closed = true;
  }

  /** Read helpers for tests. */
  readEvents(): ListingChangeEvent[] {
    return readJsonl<ListingChangeEvent>(join(this.runDir, "events.jsonl"));
  }

  readHealth(): HealthRecord[] {
    return readJsonl<HealthRecord>(join(this.runDir, "health.jsonl"));
  }

  readBooks(): BookChangeRecord[] {
    return readJsonl<BookChangeRecord>(join(this.runDir, "books.jsonl"));
  }

  readSold(): SoldRecord[] {
    return readJsonl<SoldRecord>(join(this.runDir, "sold.jsonl"));
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}


