/**
 * IBM QRadar connector — via the QRadar HTTP Receiver log-source protocol.
 *
 * QRadar can ingest events over HTTPS: the customer stands up an "HTTP
 * Receiver" log source (JSON DSM) and gives us its receiver URL plus, if they
 * front it with an auth header, a token. We POST one JSON event per platform
 * event. This mirrors the Splunk HEC shape — a simple authenticated HTTPS
 * POST — which is the realistic push path for QRadar from a serverless worker
 * (raw TCP/UDP syslog isn't available to Workers fetch).
 */

import { validateOutboundWebhookUrl } from "../url-guard";
import { isRetryableStatus, type ConnectorResult, type OutboundEvent } from "./push-types";

export interface QRadarConfig {
  /** HTTP Receiver URL, e.g. https://qradar.acme.com:8443/console/... or a fronting collector. */
  receiver_url: string;
  /** Optional bearer/SEC token if the receiver is auth-gated. */
  auth_token?: string;
  /** Header to carry the token (default Authorization: Bearer <token>). */
  auth_header?: string;
}

function strOf(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function parseQRadarConfig(config: Record<string, unknown> | null): QRadarConfig | null {
  if (!config) return null;
  // The connect sheet stores the HTTP-receiver endpoint as `url` and the
  // optional token as `api_token`; accept the descriptive aliases too.
  const receiver_url = strOf(config.receiver_url, config.url);
  if (!receiver_url) return null;
  const auth_token = strOf(config.auth_token, config.api_token);
  const auth_header = strOf(config.auth_header);
  return { receiver_url, auth_token, auth_header };
}

export async function deliverToQRadar(
  cfg: QRadarConfig,
  event: OutboundEvent,
): Promise<ConnectorResult> {
  const guard = validateOutboundWebhookUrl(cfg.receiver_url);
  if (!guard.ok) return { ok: false, error: `QRadar URL rejected: ${guard.reason}` };

  const body = JSON.stringify({
    event_type: event.event,
    org_id: event.org_id,
    timestamp: event.timestamp,
    vendor: "Averrow",
    ...event.data,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Averrow-Integration/1.0",
  };
  if (cfg.auth_token) {
    if (cfg.auth_header) {
      // Custom header name → send the raw token value.
      headers[cfg.auth_header] = cfg.auth_token;
    } else {
      headers.Authorization = `Bearer ${cfg.auth_token}`;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(cfg.receiver_url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    clearTimeout(timeout);
    if (res.ok) return { ok: true, httpStatus: res.status };
    let detail = "";
    try {
      const t = await res.text();
      if (t) detail = ` — ${t.slice(0, 200)}`;
    } catch {
      /* no body */
    }
    return {
      ok: false,
      httpStatus: res.status,
      error: `QRadar HTTP ${res.status}${detail}`,
      retryable: isRetryableStatus(res.status),
    };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
  }
}
