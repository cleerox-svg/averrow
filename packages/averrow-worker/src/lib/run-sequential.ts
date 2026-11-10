// Sequential D1 fan-out + fail-soft sections.
//
// D1 runs one database's queries serially, so sending a dozen heavy reads
// at once in one `Promise.all` does not finish sooner — it queues them all
// inside the same ~10s resource window. On prod (2026-11-08) two such fans
// (the Threats aggregate refill, then platform-diagnostics) each tripped
// `D1 DB is overloaded. Too many resources consumed within a 10 second
// window` for every other request on the database, login included.
// Running the reads one after another lets other requests interleave
// between them.

/**
 * Run async tasks one after another (not in one `Promise.all`) and return
 * their results in order. Pass thunks, not promises — a promise has already
 * started its query.
 */
export async function runSequential<T extends Array<() => Promise<unknown>>>(
  tasks: [...T],
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const task of tasks) out.push(await task());
  return out as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

/** Resolve after `ms` (immediately for `ms <= 0`). */
export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Thrown by `withTimeout` when the work did not settle in time. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Race `fn()` against a timer. Rejects with `TimeoutError` when the timer
 * wins (the underlying work is not cancelled — a D1 query keeps running
 * server-side — but the caller stops waiting for it). The timer is always
 * cleared. `ms <= 0` disables the timeout.
 */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0)) return fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run `fn` up to `backoffMs.length + 1` times, sleeping `backoffMs[i]`
 * before retry i+1, and rethrow the last error. Only use it for work that is
 * safe to repeat (idempotent writes). D1's overload rejection
 * (`Too many resources consumed within a 10 second window`) clears only once
 * that window rolls over, so a backoff schedule meant to ride it out must
 * add up to more than 10 s.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  backoffMs: readonly number[],
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    if (attempt > 0) await sleep(backoffMs[attempt - 1] ?? 0);
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** `<section>_error` → message, filled by `softSection`. */
export type SectionErrors = Record<string, string>;

/**
 * Wrap one section's read so a failure degrades that section only: the
 * thunk resolves to `fallback` (or `fallback(message)`) and records the
 * message under `errors[`${section}_error`]` instead of rejecting. Several
 * reads may share a section; their messages are joined with `; `.
 * Synchronous throws (e.g. from `prepare`) are caught too.
 */
export function softSection<T>(
  errors: SectionErrors,
  section: string,
  fallback: T | ((message: string) => T),
  fn: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const key = `${section}_error`;
      errors[key] = errors[key] ? `${errors[key]}; ${message}` : message;
      return typeof fallback === "function"
        ? (fallback as (message: string) => T)(message)
        : fallback;
    }
  };
}
