/**
 * Microsoft Sentinel connector — via the Azure Log Analytics HTTP Data
 * Collector API (the workspace-key path every Sentinel customer can enable
 * without app registration).
 *
 * The customer supplies their Log Analytics workspace ID (a GUID) and a
 * primary/secondary shared key (base64). Events are POSTed as a JSON array to
 * `https://{workspace_id}.ods.opinsights.azure.com/api/logs`, into a custom
 * table named by `log_type` (Azure appends `_CL`). Auth is an HMAC-SHA256
 * signature over a canonical request string, SharedKey scheme.
 *
 * Reference: Azure Monitor HTTP Data Collector API (Authorization: SharedKey).
 */

import { validateOutboundWebhookUrl } from "../url-guard";
import {
  isRetryableStatus,
  base64ToBytes,
  bytesToBase64,
  utf8Length,
  type ConnectorResult,
  type OutboundEvent,
} from "./push-types";

export interface SentinelConfig {
  workspace_id: string; // Log Analytics workspace GUID
  shared_key: string;   // base64 primary/secondary key
  log_type: string;     // custom log table name (alphanumeric); Azure appends _CL
}

// Workspace ID lands in the request hostname — constrain it to a GUID so it
// can't be used to redirect the key-bearing request to another host.
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Log-Type header: Azure allows letters only (no spaces/numbers/symbols).
const LOG_TYPE_RE = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;

export function parseSentinelConfig(config: Record<string, unknown> | null): SentinelConfig | null {
  if (!config) return null;
  const workspace_id = typeof config.workspace_id === "string" ? config.workspace_id.trim() : null;
  const shared_key = typeof config.shared_key === "string" ? config.shared_key.trim() : null;
  const log_type = typeof config.log_type === "string" && config.log_type.trim()
    ? config.log_type.trim()
    : "AverrowEvent";
  if (!workspace_id || !shared_key) return null;
  if (!GUID_RE.test(workspace_id)) return null;
  if (!LOG_TYPE_RE.test(log_type)) return null;
  return { workspace_id, shared_key, log_type };
}

async function buildSignature(
  cfg: SentinelConfig,
  contentLength: number,
  rfc1123Date: string,
): Promise<string | null> {
  // Canonical string the Data Collector API signs.
  const stringToSign =
    `POST\n${contentLength}\napplication/json\nx-ms-date:${rfc1123Date}\n/api/logs`;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(cfg.shared_key);
  } catch {
    return null; // shared key not valid base64
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stringToSign));
  return `SharedKey ${cfg.workspace_id}:${bytesToBase64(new Uint8Array(sig))}`;
}

export async function deliverToSentinel(
  cfg: SentinelConfig,
  event: OutboundEvent,
): Promise<ConnectorResult> {
  const url = `https://${cfg.workspace_id}.ods.opinsights.azure.com/api/logs?api-version=2016-04-01`;
  const guard = validateOutboundWebhookUrl(url);
  if (!guard.ok) return { ok: false, error: `Sentinel URL rejected: ${guard.reason}` };

  // Data Collector ingests an array of flat records.
  const body = JSON.stringify([
    {
      event_type: event.event,
      org_id: event.org_id,
      timestamp: event.timestamp,
      ...event.data,
    },
  ]);
  const contentLength = utf8Length(body);
  const rfc1123Date = new Date().toUTCString();

  const authorization = await buildSignature(cfg, contentLength, rfc1123Date);
  if (!authorization) return { ok: false, error: "Sentinel shared_key is not valid base64" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Log-Type": cfg.log_type,
        "x-ms-date": rfc1123Date,
        "time-generated-field": "timestamp",
        Authorization: authorization,
        "User-Agent": "Averrow-Integration/1.0",
      },
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
      error: `Sentinel HTTP ${res.status}${detail}`,
      retryable: isRetryableStatus(res.status),
    };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
  }
}
