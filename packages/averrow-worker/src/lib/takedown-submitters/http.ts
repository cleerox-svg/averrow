// Shared HTTP helper for API-based takedown submitters.
//
// Every API submitter (Web Risk, future Cloudflare/APWG/etc.) needs the
// same envelope: a JSON POST with a timeout, a bounded summary/payload for
// the takedown_submissions audit row, and outcome mapping that matches the
// dispatcher's contract (2xx → submitted, 4xx → rejected, 5xx/network →
// failed). Centralizing it keeps each provider submitter ~50 lines and the
// failure semantics uniform.
//
// See docs/TAKEDOWN_PROVIDER_INTEGRATION_PLAN.md §2, §5.

const MAX_AUDIT_CHARS = 500;

/** Truncate a string for the audit columns (request_summary/response_body). */
export function truncate(s: string, max = MAX_AUDIT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export interface JsonPostResult {
  /** True on HTTP 2xx. */
  ok:       boolean;
  /** HTTP status, or null on network/timeout error (no response). */
  status:   number | null;
  /** Parsed JSON body when available, else null. */
  json:     unknown;
  /** Raw body text (truncated) for the audit trail. */
  bodyText: string | null;
  /** Error message on network/timeout failure. */
  error?:   string;
}

/**
 * JSON POST with a hard timeout. Never throws — network/timeout failures
 * come back as { ok:false, status:null, error }. The caller maps this onto
 * a SubmissionResult.
 */
export async function postJson(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<JsonPostResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bodyText = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      json = null;
    }
    return {
      ok:       res.ok,
      status:   res.status,
      json,
      bodyText: bodyText ? truncate(bodyText) : null,
    };
  } catch (err) {
    return {
      ok:       false,
      status:   null,
      json:     null,
      bodyText: null,
      error:    err instanceof Error ? err.message : String(err),
    };
  }
}

/** Map an HTTP status to the dispatcher's outcome vocabulary. */
export function outcomeForStatus(status: number | null): "submitted" | "rejected" | "failed" {
  if (status === null) return "failed";       // network / timeout — retryable
  if (status >= 200 && status < 300) return "submitted";
  if (status >= 400 && status < 500) return "rejected"; // provider said no
  return "failed";                             // 5xx — retryable
}
