/**
 * Trader ops health summary — ListingStore watermarks + PollEngine metrics.
 * Printable HUD for monitors / run proofs.
 */
import type { ListingStore } from "../store.js";
import type { MetricsSnapshot } from "../http/metrics.js";
import type {
  PollStatsSnapshot,
  ProviderPollStats,
} from "../aggregate/PollEngine.js";
import type { ProviderWatermark } from "../types.js";

/** Structural poll surface (avoids hard cycle on PollEngine class). */
export interface PollHealthSource {
  getMetrics(): MetricsSnapshot;
  getPollStats(): PollStatsSnapshot;
}

export interface ProviderHealthRow {
  provider: string;
  lastSuccessfulPullAt: string | null;
  lastError: string | null;
  lastRowCount: number;
  lastBuiltAt: string | null;
  /** HTTP / pull counters from metrics (0 if never recorded). */
  pulls: number;
  errors: number;
  latencyMs: number;
  /** PollEngine sync count when available. */
  syncs: number;
  /** PollEngine short-circuit count when available. */
  shortCircuits: number;
  /**
   * shortCircuits / syncs when syncs > 0; null when poll stats unavailable
   * or no syncs yet.
   */
  shortCircuitRate: number | null;
}

export interface TraderHealthSummary {
  at: string;
  providers: ProviderHealthRow[];
  totalActive: number;
}

export interface TraderHealthOptions {
  store: ListingStore;
  /** Prefer this for metrics + short-circuit rates. */
  poll?: PollHealthSource | null;
  /** Explicit metrics snapshot (else poll.getMetrics() / empty). */
  metrics?: MetricsSnapshot | null;
  /** Explicit poll stats (else poll.getPollStats() / empty). */
  pollStats?: PollStatsSnapshot | null;
  /**
   * Provider ids to include. Default: union of watermarks, metrics keys,
   * pollStats keys, sorted.
   */
  providerIds?: string[];
  at?: string;
}

function emptyPollStats(): ProviderPollStats {
  return { syncs: 0, shortCircuits: 0 };
}

function rate(shortCircuits: number, syncs: number): number | null {
  if (syncs <= 0) return null;
  return shortCircuits / syncs;
}

function emptyWatermark(provider: string): ProviderWatermark {
  return {
    provider,
    lastSuccessfulPullAt: null,
    lastBuiltAt: null,
    lastRowCount: 0,
    lastError: null,
  };
}

/**
 * Build per-provider health from ListingStore watermarks and optional
 * PollEngine / HTTP metrics (including short-circuit rate when tracked).
 */
export function traderHealthSummary(
  opts: TraderHealthOptions,
): TraderHealthSummary {
  const metrics: MetricsSnapshot =
    opts.metrics ?? opts.poll?.getMetrics() ?? {};
  const pollStats: PollStatsSnapshot =
    opts.pollStats ?? opts.poll?.getPollStats() ?? {};

  let ids = opts.providerIds;
  if (!ids || ids.length === 0) {
    const set = new Set<string>();
    for (const wm of opts.store.listWatermarks()) set.add(wm.provider);
    for (const id of Object.keys(metrics)) set.add(id);
    for (const id of Object.keys(pollStats)) set.add(id);
    ids = [...set].sort();
  }

  const providers: ProviderHealthRow[] = ids.map((provider) => {
    const wm = opts.store.getWatermark(provider) ?? emptyWatermark(provider);
    const m = metrics[provider];
    const ps = pollStats[provider] ?? emptyPollStats();
    const hasPollStats = pollStats[provider] != null;
    return {
      provider,
      lastSuccessfulPullAt: wm.lastSuccessfulPullAt,
      lastError: wm.lastError,
      lastRowCount: wm.lastRowCount,
      lastBuiltAt: wm.lastBuiltAt,
      pulls: m?.pulls ?? 0,
      errors: m?.errors ?? 0,
      latencyMs: m?.latency_ms ?? 0,
      syncs: ps.syncs,
      shortCircuits: ps.shortCircuits,
      shortCircuitRate: hasPollStats ? rate(ps.shortCircuits, ps.syncs) : null,
    };
  });

  return {
    at: opts.at ?? new Date().toISOString(),
    providers,
    totalActive: opts.store.size(),
  };
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function fmtRate(r: number | null): string {
  if (r == null) return "-";
  return `${(r * 100).toFixed(1)}%`;
}

function fmtTs(iso: string | null): string {
  if (!iso) return "-";
  // Compact: drop ms, keep Z
  return iso.replace(/\.\d{3}Z$/, "Z");
}

function fmtErr(err: string | null): string {
  if (!err) return "-";
  const one = err.replace(/\s+/g, " ").trim();
  return one.length > 48 ? `${one.slice(0, 45)}...` : one;
}

/**
 * Printable multi-line HUD for operator terminals / runtime monitors.
 */
export function formatHealthHud(summary: TraderHealthSummary): string {
  const lines: string[] = [];
  lines.push(`=== Trader Health ${fmtTs(summary.at)} ===`);
  lines.push(
    pad("provider", 16) +
      pad("ok", 5) +
      pad("rows", 6) +
      pad("lastPull", 22) +
      pad("scRate", 8) +
      pad("syncs", 7) +
      pad("pulls", 7) +
      pad("err", 5) +
      pad("latMs", 7) +
      "lastError",
  );

  for (const row of summary.providers) {
    const ok = row.lastError ? "ERR" : row.lastSuccessfulPullAt ? "OK" : "?";
    const sc =
      row.shortCircuitRate != null
        ? fmtRate(row.shortCircuitRate)
        : row.syncs > 0
          ? fmtRate(rate(row.shortCircuits, row.syncs))
          : "-";
    lines.push(
      pad(row.provider, 16) +
        pad(ok, 5) +
        pad(String(row.lastRowCount), 6) +
        pad(fmtTs(row.lastSuccessfulPullAt), 22) +
        pad(sc, 8) +
        pad(String(row.syncs), 7) +
        pad(String(row.pulls), 7) +
        pad(String(row.errors), 5) +
        pad(String(row.latencyMs), 7) +
        fmtErr(row.lastError),
    );
  }

  lines.push(`total active listings: ${summary.totalActive}`);
  return lines.join("\n");
}
