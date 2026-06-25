// NetBeacon submitter — reports DNS abuse (phishing / malware / botnet /
// spam) to the DNS Abuse Institute's NetBeacon Reporter API, which
// normalizes the report to X-ARF, enriches it, and routes it to the correct
// participating registrar/registry for action.
//
// Why this over a per-registrar submitter: NetBeacon is an *aggregator*. One
// integration fans out to the whole participating-registrar network, instead
// of hand-writing (and maintaining) a client per registrar. It's the highest-
// leverage API target for domain takedowns. See
// docs/TAKEDOWN_PROVIDER_INTEGRATION_PLAN.md §3.4 / Phase P3.
//
// Contract note: NetBeacon's exact API host/path/auth-header are provisioned
// when a reporter is onboarded (the public docs only fix the *shape* — four
// abuse categories, X-ARF normalization, API-key auth, a trackable report
// id). So the host/path/category mapping live in clearly-marked constants and
// the base URL is overridable via env.NETBEACON_API_BASE — the operator points
// it at the onboarded endpoint with no code change. Until NETBEACON_API_KEY is
// set (and auto_submit_enabled flipped), canHandle() declines and the
// dispatcher falls back to the email channel.
//
// Gating mirrors webRiskSubmitter: live-send kill switch + credential +
// provider.abuse_api_type='netbeacon' + a resolvable domain. Sparrow Phase G's
// policy/entitlement/cap checks still front everything.

import type { Env } from "../../types";
import { logger } from "../logger";
import { isLiveSendMode } from "./email-send";
import { postJson, outcomeForStatus, truncate } from "./http";
import type {
  Submitter,
  SubmissionResult,
  TakedownRecord,
  ProviderRecord,
} from "./types";

const KIND = "api_netbeacon";
const DEFAULT_BASE = "https://api.netbeacon.org";

/** NetBeacon's four accepted DNS-abuse categories. */
type NetBeaconCategory = "phishing" | "malware" | "botnet" | "spam";

function netbeaconKey(env: Env): string | undefined {
  return (env as unknown as Record<string, string | undefined>).NETBEACON_API_KEY;
}

/** Extract the registrable domain NetBeacon acts on (it's registrar-routed). */
function resolveDomain(takedown: TakedownRecord): string | null {
  const raw =
    takedown.target_type === "domain"
      ? takedown.target_value
      : takedown.target_url ?? takedown.target_value;
  if (!raw) return null;
  try {
    // Strip scheme/path if a URL was supplied.
    const host = /^https?:\/\//i.test(raw) ? new URL(raw).hostname : raw.trim();
    return host && host.includes(".") ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Map our internal signal to a NetBeacon category. Brand-impersonation
 * domains are overwhelmingly phishing, so that's the default; the module key
 * and evidence text bump it to a more specific category when they clearly
 * indicate one.
 */
export function deriveNetBeaconCategory(takedown: TakedownRecord): NetBeaconCategory {
  const hay = `${takedown.module_key ?? ""} ${takedown.evidence_summary} ${takedown.evidence_detail ?? ""}`.toLowerCase();
  if (/\bbotnet|c2|command.and.control|\bc&c\b/.test(hay)) return "botnet";
  if (/\bmalware|trojan|ransomware|dropper|payload\b/.test(hay)) return "malware";
  if (/\bspam\b/.test(hay)) return "spam";
  return "phishing";
}

export const netbeaconSubmitter: Submitter = {
  kind: KIND,

  isConfigured(env: Env): boolean {
    return !!netbeaconKey(env);
  },

  canHandle(env: Env, takedown: TakedownRecord, provider: ProviderRecord): boolean {
    return (
      isLiveSendMode(env) &&
      provider.abuse_api_type === "netbeacon" &&
      !!netbeaconKey(env) &&
      resolveDomain(takedown) !== null
    );
  },

  async submit(env: Env, takedown: TakedownRecord, provider: ProviderRecord): Promise<SubmissionResult> {
    const start = Date.now();
    const domain = resolveDomain(takedown); // canHandle guarantees non-null
    const key = netbeaconKey(env);
    if (!domain || !key) {
      return {
        outcome:          "failed",
        submitter_kind:   KIND,
        submitter_target: provider.abuse_api_url,
        request_summary:  null,
        error_message:    !domain ? "No registrable domain on takedown" : "NETBEACON_API_KEY missing",
        duration_ms:      Date.now() - start,
      };
    }

    const base = (env as unknown as Record<string, string | undefined>).NETBEACON_API_BASE || provider.abuse_api_url || DEFAULT_BASE;
    const endpoint = `${base.replace(/\/$/, "")}/v1/reports`;
    const category = deriveNetBeaconCategory(takedown);

    // Report body — confirm exact field names at onboarding; isolated here so
    // a contract tweak is a one-line change.
    const payload = {
      category,
      domain,
      url:      takedown.target_url ?? `https://${domain}`,
      evidence: truncate(`${takedown.evidence_summary}\n\n${takedown.evidence_detail ?? ""}`.trim(), 2000),
      severity: takedown.severity,
      source:   "averrow",
    };

    const res = await postJson(endpoint, payload, {
      headers: { Authorization: `Bearer ${key}` },
    });

    const outcome = res.error ? "failed" : outcomeForStatus(res.status);
    // NetBeacon returns a report id used to track status (up to 7 days).
    const reportId =
      res.json && typeof res.json === "object"
        ? String(
            (res.json as Record<string, unknown>).report_id ??
            (res.json as Record<string, unknown>).id ??
            "",
          )
        : "";

    if (outcome !== "submitted") {
      logger.warn("netbeacon submit non-success", {
        takedown_id: takedown.id,
        status:      res.status,
        error:       res.error,
      });
    }

    return {
      outcome,
      submitter_kind:   KIND,
      submitter_target: endpoint,
      request_summary:  truncate(`NetBeacon ${category} report for ${domain}`),
      request_payload:  JSON.stringify(payload),
      response_status:  res.status,
      response_body:    res.bodyText,
      ticket_id:        reportId || null,
      error_message:    outcome === "submitted" ? null : (res.error ?? res.bodyText ?? `HTTP ${res.status}`),
      duration_ms:      Date.now() - start,
    };
  },
};
