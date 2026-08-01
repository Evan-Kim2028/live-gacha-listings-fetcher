/**
 * Optional lightweight per-provider pull counters for native radar / PollEngine.
 * In-process only; reset between tests with resetMetrics().
 */

export interface ProviderMetricCounters {
  /** Successful or soft-completed pulls (including soft-empty). */
  pulls: number;
  /** Pulls that threw. */
  errors: number;
  /** Last pull duration in ms. */
  latency_ms: number;
  /** Cumulative latency across pulls (for avg = total_latency_ms / pulls). */
  total_latency_ms: number;
}

export type MetricsSnapshot = Record<string, ProviderMetricCounters>;

const store = new Map<string, ProviderMetricCounters>();

function empty(): ProviderMetricCounters {
  return { pulls: 0, errors: 0, latency_ms: 0, total_latency_ms: 0 };
}

function ensure(providerId: string): ProviderMetricCounters {
  let row = store.get(providerId);
  if (!row) {
    row = empty();
    store.set(providerId, row);
  }
  return row;
}

/**
 * Record one provider pull attempt.
 * @param error true when the pull threw (not soft lastError).
 */
export function recordPull(
  providerId: string,
  latencyMs: number,
  error = false,
): void {
  const row = ensure(providerId);
  const ms =
    Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : 0;
  row.pulls += 1;
  if (error) row.errors += 1;
  row.latency_ms = ms;
  row.total_latency_ms += ms;
}

/** Snapshot of all provider counters (plain object copy). */
export function getMetrics(): MetricsSnapshot {
  const out: MetricsSnapshot = {};
  for (const [id, row] of store) {
    out[id] = { ...row };
  }
  return out;
}

/** Counters for one provider, or zeros if never recorded. */
export function getProviderMetrics(providerId: string): ProviderMetricCounters {
  const row = store.get(providerId);
  return row ? { ...row } : empty();
}

/** Clear all counters (tests / process recycle). */
export function resetMetrics(): void {
  store.clear();
}
