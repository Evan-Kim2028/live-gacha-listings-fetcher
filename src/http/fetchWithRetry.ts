/**
 * Shared HTTP helper for native marketplace clients.
 * Exponential backoff on 429 / 5xx (and optional network errors), maxRetries default 3.
 * Optional ETag / If-None-Match for CDN-friendly conditional GETs (304 = not modified).
 */

export interface FetchWithRetryOptions {
  fetchImpl?: typeof fetch;
  /**
   * Retries after the first attempt on 429 / 5xx (and network when enabled).
   * Default 3 → up to 4 total attempts.
   */
  maxRetries?: number;
  /** Base delay ms; wait = min(maxDelayMs, base * 2^attempt), floored by Retry-After. Default 500. */
  baseDelayMs?: number;
  /** Cap a single backoff wait (default 30_000). */
  maxDelayMs?: number;
  /** Retry thrown network/fetch failures (default true). */
  retryNetwork?: boolean;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * When set, send as `If-None-Match` unless the request already has that header.
   * Origins that return 304 (Not Modified) skip the response body (CDN-friendly).
   * Soft: omit when no prior ETag is known.
   */
  ifNoneMatch?: string | null;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * True for rate-limit / transient blocks and server errors that are safe to retry.
 * Includes 403: public marketplace CDNs often use 403 for short WAF/rate windows
 * (Collector Crypt live); permanent ACL 403 still fails after maxRetries.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 403 || status >= 500;
}

/** HTTP 304 Not Modified (conditional GET / ETag hit). */
export function isNotModifiedStatus(status: number): boolean {
  return status === 304;
}

/** Read `ETag` response header (null if absent or empty). */
export function getResponseEtag(res: Response): string | null {
  const etag = res.headers.get("etag");
  if (etag == null) return null;
  const trimmed = etag.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Merge optional If-None-Match into RequestInit headers (does not overwrite existing). */
export function withIfNoneMatch(
  init: RequestInit | undefined,
  ifNoneMatch: string | null | undefined,
): RequestInit | undefined {
  if (ifNoneMatch == null || ifNoneMatch === "") return init;
  const headers = new Headers(init?.headers);
  if (!headers.has("If-None-Match")) {
    headers.set("If-None-Match", ifNoneMatch);
  }
  return { ...init, headers };
}

/**
 * Exponential backoff delay for attempt `attempt` (0-based after a failed try).
 * Honors Retry-After (seconds or HTTP-date) when a Response is available.
 */
export function computeRetryDelayMs(
  res: Response | null,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): number {
  let delay = baseDelayMs * 2 ** Math.max(0, attempt);
  if (res) {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const asSec = Number(retryAfter);
      if (Number.isFinite(asSec) && asSec >= 0) {
        delay = Math.max(delay, asSec * 1000);
      } else {
        const when = Date.parse(retryAfter);
        if (Number.isFinite(when)) {
          delay = Math.max(delay, Math.max(0, when - Date.now()));
        }
      }
    }
  }
  return Math.min(delay, maxDelayMs);
}

function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|aborted/i.test(
    msg,
  );
}

/**
 * fetch() with exponential backoff on 429/5xx (and network errors by default).
 * Returns the last Response when retries are exhausted (caller checks `ok` / status).
 * Re-throws only when the final attempt is a network/throw failure.
 * 304 is returned as-is (not retryable); pair with {@link getResponseEtag} / provider
 * `notModified` short-circuit.
 */
export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const retryNetwork = opts.retryNetwork !== false;
  const sleep = opts.sleep ?? defaultSleep;
  const requestInit = withIfNoneMatch(init, opts.ifNoneMatch);

  let lastNetworkErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchImpl(input, requestInit);
      if (isRetryableStatus(res.status) && attempt < maxRetries) {
        await sleep(computeRetryDelayMs(res, attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      return res;
    } catch (e) {
      lastNetworkErr = e;
      if (retryNetwork && attempt < maxRetries && isNetworkError(e)) {
        await sleep(computeRetryDelayMs(null, attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastNetworkErr instanceof Error
    ? lastNetworkErr
    : new Error("fetchWithRetry: exhausted retries");
}
