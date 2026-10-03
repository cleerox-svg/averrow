// Averrow — Abuse Mailbox operator notifications
//
// Shared by the rules pass (lib/abuse-mailbox-rules-runner.ts) and the AI
// classifier (lib/abuse-mailbox-classifier.ts) so both verdict sources emit
// identical in-app notifications. Both helpers are best-effort: failures are
// logged and swallowed — a notification must never break triage.

import type { Env } from "../types";
import { logger } from "./logger";

export interface NamedThreatNotice {
  messageId:      string;
  namedThreatId:  string;
  namedThreatName: string | null;
  namedThreatSeverity: string | null;
  technique:      string | null;
  /** Short verdict label for the operator ("phishing @ 90%", "rules M2"). */
  verdictLabel:   string;
  deviceCodeScore: number;
  deviceCodeSignals: string[];
}

/** High-signal operator alert: a named threat was identified. Deduped per
 *  named threat per day so one campaign doesn't flood. */
export async function notifyNamedThreatIdentified(env: Env, n: NamedThreatNotice): Promise<void> {
  try {
    const { createNotification } = await import("./notifications");
    const today = new Date().toISOString().slice(0, 10);
    await createNotification(env, {
      type: "named_threat_identified",
      severity: n.namedThreatSeverity === "critical" ? "high" : "medium",
      title: `Named threat identified: ${n.namedThreatName}`,
      message: `Abuse-mailbox submission matched ${n.namedThreatName}` +
        (n.technique ? ` (${n.technique.replace(/_/g, " ")})` : "") +
        `. Verdict: ${n.verdictLabel}.`,
      link: "/admin/abuse-mailbox",
      audience: "super_admin",
      groupKey: `named_threat_identified:${n.namedThreatId}:${today}`,
      reasonText: "An incoming abuse-mailbox report matched a known named threat in the catalog.",
      recommendedAction: "Review the captured message and any promoted indicators in the Abuse Mailbox.",
      metadata: {
        message_id: n.messageId,
        named_threat_id: n.namedThreatId,
        named_threat_name: n.namedThreatName,
        technique: n.technique,
        device_code_score: n.deviceCodeScore,
        device_code_signals: n.deviceCodeSignals,
      },
    });
  } catch (err) {
    logger.warn("abuse_mailbox_named_threat_notify_failed", {
      message_id: n.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface VerdictNotice {
  messageId:      string;
  orgId:          number;
  brandId:        string | null;
  inboundAlias:   string | null;
  classification: "phishing" | "malware";
  severity:       "HIGH" | "CRITICAL";
  confidence:     number;
  action:         string;
  /** Operator-facing message body (AI reasoning, or a fixed rules sentence). */
  message:        string;
  classifiedBy:   "ai" | "rules";
  /** Rules H1 heuristic tier: say "likely", never "confirmed". */
  likely?:        boolean;
}

/**
 * In-app notification for HIGH/CRITICAL phishing|malware verdicts.
 * Audience: brand-bound capture → 'tenant', restricted to active
 * org_members of the message's org (plus opted-in super_admins, per the
 * standard tenant rules) — a capture is the reporting org's data, so a
 * subscriber to the same brand in ANOTHER org must never see it. Unbound
 * capture → 'super_admin'. Dedup per message via group_key.
 *
 * The forwarded subject is attacker-controlled and is deliberately NOT
 * put in the title (it would surface in push notifications and lock
 * screens); the operator opens the message for details.
 */
export async function notifyAbuseVerdict(env: Env, v: VerdictNotice): Promise<void> {
  try {
    const { createNotification } = await import("./notifications");
    const audience: "tenant" | "super_admin" = v.brandId ? "tenant" : "super_admin";
    // Link paths are basename-relative because both SPAs use
    // <BrowserRouter basename="..."> — `/v2/admin/...` would get
    // double-prefixed to `/v2/v2/admin/...` and 404.
    const link = audience === "super_admin"
      ? `/admin/abuse-mailbox#msg-${v.messageId}`
      : `/modules/abuse-mailbox#msg-${v.messageId}`;
    await createNotification(env, {
      type: "abuse_mailbox_verdict",
      severity: v.severity === "CRITICAL" ? "critical" : "high",
      title: v.likely
        ? "Likely phishing — abuse mailbox report"
        : `${v.classification === "phishing" ? "Phishing" : "Malware"} confirmed — abuse mailbox report`,
      message: v.message,
      link,
      audience,
      brandId: v.brandId,
      orgId: String(v.orgId),
      restrictToOrgMembers: audience === "tenant" ? v.orgId : null,
      groupKey: `abuse_mailbox_verdict:${v.messageId}`,
      reasonText: v.likely
        ? (v.brandId
          ? "A capture targeting one of your monitored brands shows several phishing hallmarks (not yet confirmed by threat intelligence)."
          : "A capture sent to your abuse alias shows several phishing hallmarks (not yet confirmed by threat intelligence).")
        : v.brandId
          ? "A capture targeting one of your monitored brands was classified as a confirmed threat."
          : "A capture sent to your abuse alias was classified as a confirmed threat.",
      recommendedAction: "Open the message in the Abuse Mailbox to review indicators and take action.",
      metadata: {
        message_id: v.messageId,
        inbound_alias: v.inboundAlias,
        classification: v.classification,
        confidence: v.confidence,
        ai_action: v.action,
        classified_by: v.classifiedBy,
      },
    });
  } catch (err) {
    logger.warn("abuse_mailbox_verdict_notify_failed", {
      message_id: v.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
