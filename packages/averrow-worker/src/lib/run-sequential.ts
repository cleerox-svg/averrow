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

/**
 * `runSequential`'s signature with `Promise.all` semantics — for callers
 * that pick sequential or parallel at runtime with the same task list.
 */
export function runParallel<T extends Array<() => Promise<unknown>>>(
  tasks: [...T],
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  return Promise.all(tasks.map((task) => task())) as Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
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
 * True for our `TimeoutError` and for the runtime's `AbortSignal.timeout`
 * rejection (a DOMException named "TimeoutError").
 */
export function isTimeoutError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError";
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
