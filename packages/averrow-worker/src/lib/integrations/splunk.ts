/**
 * Splunk HTTP Event Collector (HEC) connector.
 *
 * The cheapest, most common SIEM destination: an HTTPS POST of a JSON event
 * envelope to the customer's HEC endpoint, authenticated with an HEC token.
 * The customer provisions the HEC endpoint + token in their Splunk and
 * stores them on the org_integrations row (encrypted).
 *
 * HEC reference: POST {hec_url} with `Authorization: Splunk <token>`; the
 * body's top-level fields are HEC metadata and `event` is the payload.
 */

import { validateOutboundWebhookUrl } from "../url-guard";
import { isRetryableStatus, type ConnectorResult, type OutboundEvent } from "./push-types";

export type { ConnectorResult, OutboundEvent };

export interface SplunkConfig {
  /** Full HEC collector URL, e.g. https://http-inputs-acme.splunkcloud.com/services/collector/event */
  hec_url: string;
  hec_token: string;
  index?: string;
  source?: string;
  sourcetype?: string;
}

export function parseSplunkConfig(config: Record<string, unknown> | null): SplunkConfig | null {
  if (!config) return null;
  const hec_url = typeof config.hec_url === "string" ? config.hec_url : null;
  const hec_token = typeof config.hec_token === "string" ? config.hec_token : null;
  if (!hec_url || !hec_token) return null;
  return {
    hec_url,
    hec_token,
    index: typeof config.index === "string" ? config.index : undefined,
    source: typeof config.source === "string" ? config.source : undefined,
    sourcetype: typeof config.sourcetype === "string" ? config.sourcetype : "averrow:event",
  };
}

export async function deliverToSplunk(
  cfg: SplunkConfig,
  event: OutboundEvent,
): Promise<ConnectorResult> {
  // SSRF defense in depth — the HEC URL must be a public https endpoint.
  const guard = validateOutboundWebhookUrl(cfg.hec_url);
  if (!guard.ok) return { ok: false, error: `HEC URL rejected: ${guard.reason}` };

  const epochSeconds = Math.floor(Date.parse(event.timestamp) / 1000);
  const body = JSON.stringify({
    ...(Number.isFinite(epochSeconds) ? { time: epochSeconds } : {}),
    sourcetype: cfg.sourcetype,
    source: cfg.source ?? "averrow",
    ...(cfg.index ? { index: cfg.index } : {}),
    event: {
      event_type: event.event,
      org_id: event.org_id,
      ...event.data,
    },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(cfg.hec_url, {
      method: "POST",
      headers: {
        Authorization: `Splunk ${cfg.hec_token}`,
        "Content-Type": "application/json",
        "User-Agent": "Averrow-Integration/1.0",
      },
      body,
      signal: controller.signal,
      // A customer endpoint must not be able to bounce the token-bearing
      // payload to an internal address.
      redirect: "manual",
    });
    clearTimeout(timeout);
    if (res.ok) return { ok: true, httpStatus: res.status };
    // Splunk HEC returns JSON {text, code} on error.
    let detail = "";
    try {
      const j = (await res.json()) as { text?: string };
      if (j?.text) detail = ` — ${j.text}`;
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, httpStatus: res.status, error: `HEC HTTP ${res.status}${detail}`, retryable: isRetryableStatus(res.status) };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
  }
}
