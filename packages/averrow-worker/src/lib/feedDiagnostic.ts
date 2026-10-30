/**
 * Feed Diagnostic Logger — writes diagnostic entries to agent_outputs
 * for each feed pull attempt, capturing URL, HTTP status, response body
 * preview, and any error messages.
 */

import type { Env } from "../types";

export interface DiagnosticEntry {
  feedName: string;
  url: string;
  method: string;
  httpStatus: number | null;
  bodyPreview: string;
  errorMessage: string | null;
}

/**
 * Log a diagnostic entry to agent_outputs with type='diagnostic'.
 * Non-fatal — swallows errors so it never breaks the feed.
 */
export async function logFeedDiagnostic(
  db: D1Database,
  entry: DiagnosticEntry,
): Promise<void> {
  try {
    const id = `diag-${entry.feedName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const summary = [
      `[${entry.feedName}] ${entry.method} ${entry.url}`,
      `HTTP ${entry.httpStatus ?? "N/A"}`,
      entry.errorMessage ? `ERROR: ${entry.errorMessage}` : null,
      `Body (first 200 chars): ${entry.bodyPreview}`,
    ]
      .filter(Boolean)
      .join("\n");

    await db.prepare(
      `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, created_at)
       VALUES (?, 'feed_diagnostics', 'diagnostic', ?, ?, datetime('now'))`,
    )
      .bind(
        id,
        summary,
        entry.errorMessage ? "high" : "info",
      )
      .run();
  } catch {
    // Diagnostic logging must never crash the feed
  }
}

/**
 * Wraps fetch() with diagnostic logging. Returns the Response.
 * On network errors, logs the error and re-throws.
 *
 * `secret` — pass the credential when it is embedded in the URL path or
 * query. Every occurrence (raw and URI-encoded) is replaced with
 * REDACTED in the diagnostic row (URL, body preview, error text — the
 * row lands in agent_outputs.summary in plaintext), and a network error
 * is re-thrown with the redacted message so feedRunner never stores it.
 */
export async function diagnosticFetch(
  db: D1Database,
  feedName: string,
  fetchUrl: string,
  init?: RequestInit,
  secret?: string,
): Promise<Response> {
  const method = init?.method ?? "GET";
  const redact = (s: string): string => {
    if (!secret) return s;
    return s.split(secret).join("REDACTED").split(encodeURIComponent(secret)).join("REDACTED");
  };
  const url = redact(fetchUrl);
  let res: Response;

  try {
    res = await fetch(fetchUrl, init);
  } catch (err) {
    const errorMessage = redact(err instanceof Error ? err.message : String(err));
    await logFeedDiagnostic(db, {
      feedName,
      url,
      method,
      httpStatus: null,
      bodyPreview: "",
      errorMessage,
    });
    if (secret) throw new Error(errorMessage);
    throw err;
  }

  // Clone the response so we can peek at the body without consuming it
  const clone = res.clone();
  let bodyPreview: string;
  try {
    const text = await clone.text();
    bodyPreview = redact(text.slice(0, 200));
  } catch {
    bodyPreview = "<could not read body>";
  }

  await logFeedDiagnostic(db, {
    feedName,
    url,
    method,
    httpStatus: res.status,
    bodyPreview,
    errorMessage: res.ok ? null : redact(`HTTP ${res.status} ${res.statusText}`),
  });

  return res;
}
