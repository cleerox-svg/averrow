// Averrow — idempotent D1 write retry
//
// Cloudflare D1 auto-retries read-only queries (SELECT/EXPLAIN/WITH, up to
// 2 attempts) but NEVER retries writes — its docs explicitly recommend
// application-level retry for idempotent writes. We had none, so a single
// transient blip ("Network connection lost", "Internal error in D1 DB
// storage caused object to be reset") on any write failed the whole unit:
// agent runs left unfinalized in 'partial' (then reaped hours later as a
// false-positive stall), feed pulls counted as failures, agent bodies
// thrown out mid-write.
//
// These errors are transient and retryable per Cloudflare guidance. This
// helper retries ONLY on the known-transient signatures, with exponential
// backoff + jitter, and ONLY wraps statements that are safe to re-run
// (INSERT OR IGNORE, idempotent UPDATE ... WHERE id = ?, ON CONFLICT
// upserts, etc.). Do NOT wrap non-idempotent writes (bare INSERT of a row
// with a side effect, counter += 1 without a guard) — a retry after a
// partial-success ambiguous failure could double-apply.

const TRANSIENT_D1_PATTERNS: RegExp[] = [
  /network connection lost/i,
  /storage caused object to be reset/i,
  /object reset because its code was updated/i,
  /d1.*reset/i,
  /\boverloaded\b/i,
  /transient issue on remote node/i,
  /internal error in d1/i,
];

/**
 * D1 rejects every statement against a database for the rest of a rolling
 * 10-second window once that window's resource budget is spent ("D1 DB is
 * overloaded. Too many resources consumed within a 10 second window"). A
 * 50/100/200 ms backoff retries INSIDE that window and fails every attempt —
 * the mechanism that left agent runs unfinalized in prod (2026-11-09/10:
 * navigator :25/:55 ticks, daily_snapshots, cartographer — the body finished,
 * the finalize UPDATE and then the failure UPDATE were both rejected, and the
 * row sat 'partial' / 'running' until a reaper called it "worker terminated").
 * Callers that can afford to wait pass `overloadBaseMs` so an overload error
 * backs off past the window (3 s, 6 s, 12 s with the default below).
 */
export const D1_OVERLOAD_RETRY_BASE_MS = 3_000;

const OVERLOAD_PATTERN = /\boverloaded\b/i;

/** True for D1's 10-second-window overload rejection. */
export function isD1OverloadError(message: string): boolean {
  return OVERLOAD_PATTERN.test(message);
}

/** True if the error message matches a known-transient, retryable D1 failure. */
export function isTransientD1Error(message: string): boolean {
  return TRANSIENT_D1_PATTERNS.some((p) => p.test(message));
}

export interface D1RetryOptions {
  /** Max retry attempts AFTER the first try (default 3 → up to 4 total). */
  retries?: number;
  /** Base backoff in ms; attempt N waits ~base·2^N + jitter (default 50). */
  baseMs?: number;
  /** Optional label for diagnostic logging on each retry. */
  label?: string;
  /**
   * Explicit delay before each retry, ms. When set it replaces
   * `retries`/`baseMs`: `delaysMs.length` retries, retry i+1 after
   * `delaysMs[i]` (no jitter). Use a schedule summing to > 10 s to ride out
   * D1's overload window (`Too many resources consumed within a 10 second
   * window` clears only when the window rolls over).
   */
  delaysMs?: readonly number[];
  /**
   * Which errors are worth another attempt. Default: `isTransientD1Error`
   * on the message. Deterministic failures (no such column, CHECK,
   * SQLITE_TOOBIG) are re-thrown at once.
   */
  shouldRetry?: (err: unknown) => boolean;
  /**
   * Epoch ms: never start a retry whose delay would end after this — the
   * last error is re-thrown instead. Keeps a caller's wall-clock bounded.
   */
  deadline?: number;
  /**
   * Base backoff for an OVERLOAD error (see D1_OVERLOAD_RETRY_BASE_MS):
   * attempt N waits overloadBaseMs·2^N + up to overloadBaseMs/4 jitter.
   * Unset = overload errors use `baseMs` like any other transient error
   * (the pre-2026-11-10 behaviour; keep it for latency-sensitive paths).
   */
  overloadBaseMs?: number;
}

/** Backoff (ms) before retry `attempt` (0-based) for an error `message`. Pure
 *  apart from `random` (injectable for tests). */
export function d1RetryDelayMs(
  attempt: number,
  message: string,
  opts: Pick<D1RetryOptions, "baseMs" | "overloadBaseMs"> = {},
  random: () => number = Math.random,
): number {
  if (opts.overloadBaseMs !== undefined && opts.overloadBaseMs > 0 && isD1OverloadError(message)) {
    const base = opts.overloadBaseMs;
    return base * 2 ** attempt + Math.floor(random() * (base / 4));
  }
  const baseMs = opts.baseMs ?? 50;
  return baseMs * 2 ** attempt + Math.floor(random() * baseMs);
}

const defaultShouldRetry = (err: unknown): boolean =>
  isTransientD1Error(err instanceof Error ? err.message : String(err));

/**
 * Run an idempotent D1 operation, retrying on transient D1 errors with
 * exponential backoff + jitter. Non-transient errors (constraint
 * violations, syntax errors, auth) are re-thrown immediately — retrying
 * them is pointless and would mask real bugs.
 *
 * The caller's `fn` MUST be safe to execute more than once.
 */
export async function withD1Retry<T>(
  fn: () => Promise<T>,
  opts: D1RetryOptions = {},
): Promise<T> {
  const retries = opts.delaysMs ? opts.delaysMs.length : (opts.retries ?? 3);
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Last attempt, or a non-retryable error → give up and surface it.
      if (attempt === retries || !shouldRetry(err)) throw err;
      const delay = opts.delaysMs
        ? (opts.delaysMs[attempt] ?? 0)
        : d1RetryDelayMs(attempt, msg, opts);
      // Out of wall-clock budget → surface the error rather than sleep past it.
      if (opts.deadline !== undefined && Date.now() + delay > opts.deadline) throw err;
      if (opts.label) {
        console.warn(
          `[d1-retry] ${opts.label}: transient D1 error (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms — ${msg}`,
        );
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable (loop either returns or throws), but satisfies the type checker.
  throw lastErr;
}
