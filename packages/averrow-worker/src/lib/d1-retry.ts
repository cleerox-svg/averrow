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
}

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
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 50;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Last attempt, or a non-transient error → give up and surface it.
      if (attempt === retries || !isTransientD1Error(msg)) throw err;
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
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
