// Averrow — Abuse Mailbox rules-based determination (pure)
//
// Decides a verdict for a forwarded abuse report from deterministic
// evidence only — no AI, no I/O. Runs in the per-message
// AbuseMailboxTriageWorkflow (minutes after receipt) and in the hourly
// `17 * * * *` sweeper, BEFORE (and independently of) the AI classifier,
// so a report gets a real determination even under AI_MODE=rules_only.
//
// Malicious verdicts require positive evidence:
//
//   M1  ≥1 qualifying intel correlation: a threat row that is
//       status='active', NOT sourced from the abuse mailbox itself, and
//       either (a) an exact URL match, or (b) a domain match where the
//       threat is corroborated (VT malicious > 0, GSB flagged, or from a
//       curated phishing/malware feed). A domain-level match on shared
//       hosting never counts, and nothing on the reported brand's own
//       canonical domain ever counts.
//          → phishing / HIGH / takedown (brand-bound) or escalate / 90
//   M2  named-threat match via IOC (domain / URL / IP) or regex signature.
//       Keyword-only (technique + keywords) matches do NOT qualify.
//          → phishing / HIGH / escalate / 85
//   M3  device-code lure score >= 0.85 (endpoint + explicit code cue).
//          → phishing / HIGH / escalate / 85
//   M4  executable / script / disk-image attachment extension.
//          → malware / CRITICAL / escalate / 90
//
// Everything else lands as classification='ambiguous', classified_by=
// 'rules', severity MEDIUM, ai_action 'review', with a comma list of
// FIXED reason codes in classification_reason. The rules NEVER emit
// 'benign' or 'spam' — absence of a match is not evidence of safety.
// Email-auth results only ever push toward review, and only when they
// describe the original sender (forward-as-attachment).
//
// The AI path (lib/abuse-mailbox-classifier.ts) may later re-classify a
// rules REVIEW row (classification='ambiguous' AND classified_by='rules')
// but never a rules MALICIOUS row.

import { isSharedHostingHost } from "./brandDetect";
import { isTyposquatOf } from "./abuse-mailbox-brand-match";
import { detectDeviceCodePhishing, type DeviceCodeResult } from "./device-code-detector";
import { matchNamedThreat, type NamedThreatEntry, type NamedThreatMatch } from "./named-threat-matcher";

// ─── Constants ───────────────────────────────────────────────────

/** Feeds whose listing of a domain is, on its own, corroboration that
 *  the domain hosts phishing / malware (curated, low false-positive). */
export const CORROBORATING_FEEDS: ReadonlySet<string> = new Set([
  "openphish", "phishtank", "urlhaus", "threatfox", "phishing_database",
]);

/** Attachment extensions that deliver code or a mountable payload. */
export const RISKY_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe", ".scr", ".js", ".vbs", ".hta", ".iso", ".img", ".lnk", ".xll",
  ".bat", ".cmd", ".ps1", ".jar", ".msi", ".com", ".cpl", ".vhd", ".vhdx",
]);

/**
 * Shared collaboration / file-share / shortener hosts that are not in the
 * brandDetect platform list but are equally multi-tenant: one attacker
 * document on drive.google.com says nothing about another link there.
 * Matched as host === entry or host endsWith "." + entry.
 */
const EXTRA_SHARED_HOSTS: ReadonlyArray<string> = [
  "docs.google.com", "drive.google.com", "sites.google.com", "forms.gle",
  "storage.googleapis.com", "googleusercontent.com", "dropbox.com",
  "dropboxusercontent.com", "1drv.ms", "onedrive.live.com", "sharepoint.com",
  "forms.office.com", "box.com", "wetransfer.com", "we.tl", "notion.so",
  "amazonaws.com", "azureedge.net", "core.windows.net", "bit.ly", "t.co",
  "tinyurl.com", "ow.ly", "lnkd.in", "linktr.ee",
];

export const RULE_CONFIDENCE = { M1: 90, M2: 85, M3: 85, M4: 90, review: 50 } as const;
export const DEVICE_CODE_RULE_THRESHOLD = 0.85;
/** Max URLs promoted to `threats` from one rules verdict. */
export const RULES_PROMOTE_CAP = 20;

export type RuleId = "M1" | "M2" | "M3" | "M4";

// ─── Input snapshot ──────────────────────────────────────────────

export interface RulesThreatCandidate {
  id:               string;
  malicious_url:    string | null;
  malicious_domain: string | null;
  source_feed:      string;
  status:           string;
  vt_malicious:     number | null;
  gsb_flagged:      number | null;
}

export interface RulesSnapshot {
  brand:   { id: string; canonical_domain: string | null } | null;
  originalFrom: string | null;
  urls:    ReadonlyArray<{ url: string; domain: string | null }>;
  attachments: ReadonlyArray<{ filename: string; mime_type: string | null }>;
  /** SPF/DKIM/DMARC as parsed at intake. */
  authResults: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  /** True when the report was forwarded AS AN ATTACHMENT, i.e. the stored
   *  auth results describe the original sender. Inline forwards / fresh
   *  reports carry the reporter's own provider auth — meaningless here. */
  isAttachmentForward: boolean;
  /** Threat rows found for the message's URL domains (pre-filtered in SQL,
   *  re-checked here so the rule is testable without D1). */
  threatCandidates: ReadonlyArray<RulesThreatCandidate>;
  namedThreat: NamedThreatMatch | null;
  /** The catalog entry behind `namedThreat` — used only to tell which of
   *  the message's URLs sit on the matched IOC domains/URLs. */
  namedThreatEntry: NamedThreatEntry | null;
  deviceCode: DeviceCodeResult;
}

// ─── Output ──────────────────────────────────────────────────────

export interface RulesMaliciousVerdict {
  kind:            "malicious";
  primaryRule:     RuleId;
  firedRules:      RuleId[];
  classification:  "phishing" | "malware";
  severity:        "HIGH" | "CRITICAL";
  action:          "takedown" | "escalate";
  confidence:      number;
  /** Fixed reason codes, comma-joined into classification_reason. */
  reasonCodes:     string[];
  /** Threat ids that satisfied M1 (subset of threatCandidates). */
  qualifyingThreatIds: string[];
  /** URLs to promote into `threats` — only URLs on matched infrastructure,
   *  only from M1–M3, capped at RULES_PROMOTE_CAP. */
  promoteUrls:     string[];
}

export interface RulesReviewVerdict {
  kind:            "review";
  classification:  "ambiguous";
  severity:        "MEDIUM";
  action:          "review";
  confidence:      number;
  reasonCodes:     string[];
}

export type RulesVerdict = RulesMaliciousVerdict | RulesReviewVerdict;

// ─── Helpers ─────────────────────────────────────────────────────

function normHost(h: string | null | undefined): string | null {
  if (!h) return null;
  const v = h.trim().toLowerCase().replace(/\.$/, "");
  return v || null;
}

function hostFromUrl(u: string): string | null {
  try { return normHost(new URL(u).hostname); } catch { return null; }
}

/** Shared hosting per brandDetect's platform list + the extra list above. */
export function isSharedHost(host: string | null): boolean {
  if (!host) return false;
  if (isSharedHostingHost(host)) return true;
  return EXTRA_SHARED_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
}

/** True when `host` is the brand's canonical domain or a subdomain of it. */
export function isOwnBrandHost(host: string | null, canonical: string | null | undefined): boolean {
  const c = normHost(canonical);
  if (!host || !c) return false;
  return host === c || host.endsWith(`.${c}`);
}

/** Last extension of a filename, lower-cased with the leading dot. */
export function attachmentExtension(filename: string): string | null {
  const clean = filename.trim().toLowerCase().replace(/["'\s]+$/, "");
  const dot = clean.lastIndexOf(".");
  if (dot < 0 || dot === clean.length - 1) return null;
  return clean.slice(dot);
}

function isFail(v: string | null | undefined): boolean {
  return v === "fail" || v === "softfail" || v === "permerror";
}

/** Registrable-ish SLD label for the typosquat helper. */
function sldOf(domain: string): string {
  const parts = domain.split(".");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? domain) : domain;
}

/**
 * Run the two pure content detectors for a message. Exposed so the rules
 * runner and the AI path share one invocation shape.
 */
export function runContentDetectors(
  catalog: ReadonlyArray<NamedThreatEntry>,
  msg: {
    subject: string | null;
    body: string | null;
    urls: ReadonlyArray<{ url: string; domain: string | null }>;
    senderIp: string | null;
  },
): { deviceCode: DeviceCodeResult; namedThreat: NamedThreatMatch | null; namedThreatEntry: NamedThreatEntry | null } {
  const deviceCode = detectDeviceCodePhishing({ subject: msg.subject, body: msg.body, urls: msg.urls });
  const namedThreat = matchNamedThreat(catalog, {
    subject:   msg.subject,
    body:      msg.body,
    urls:      msg.urls,
    ips:       msg.senderIp ? [msg.senderIp] : [],
    technique: deviceCode.technique,
  });
  const namedThreatEntry = namedThreat ? catalog.find((e) => e.id === namedThreat.id) ?? null : null;
  return { deviceCode, namedThreat, namedThreatEntry };
}

/** A named-threat match qualifies for M2 only on an IOC or regex hit. */
export function isStrongNamedThreatMatch(m: NamedThreatMatch | null): boolean {
  if (!m) return false;
  return m.reasons.some((r) => r.startsWith("ioc_") || r === "regex");
}

// ─── The decision ────────────────────────────────────────────────

/**
 * Decide the rules verdict for one message. Pure — no I/O, no clock.
 */
export function decideAbuseMailboxRulesVerdict(s: RulesSnapshot): RulesVerdict {
  const canonical = s.brand?.canonical_domain ?? null;
  const urls = s.urls
    .map((u) => ({ url: u.url, host: normHost(u.domain) ?? hostFromUrl(u.url) }))
    .filter((u) => !!u.url);
  const urlSet = new Set(urls.map((u) => u.url.toLowerCase()));
  const msgHosts = new Set(urls.map((u) => u.host).filter((h): h is string => !!h));

  // ── M1: qualifying intel correlation ──
  const qualifyingThreatIds: string[] = [];
  const m1ExactUrls = new Set<string>();     // lower-cased URLs matched exactly
  const m1Domains = new Set<string>();       // domains matched at domain level
  for (const t of s.threatCandidates) {
    if (t.status !== "active") continue;
    if (t.source_feed === "abuse_mailbox") continue;
    const tHost = normHost(t.malicious_domain) ?? (t.malicious_url ? hostFromUrl(t.malicious_url) : null);
    if (isOwnBrandHost(tHost, canonical)) continue;
    const tUrl = t.malicious_url?.toLowerCase() ?? null;
    if (tUrl && urlSet.has(tUrl)) {
      const urlHost = hostFromUrl(tUrl);
      if (isOwnBrandHost(urlHost, canonical)) continue;
      m1ExactUrls.add(tUrl);
      qualifyingThreatIds.push(t.id);
      continue;
    }
    if (!tHost || !msgHosts.has(tHost)) continue;
    if (isSharedHost(tHost)) continue;
    const corroborated =
      (t.vt_malicious ?? 0) > 0 ||
      (t.gsb_flagged ?? 0) === 1 ||
      CORROBORATING_FEEDS.has(t.source_feed);
    if (!corroborated) continue;
    m1Domains.add(tHost);
    qualifyingThreatIds.push(t.id);
  }
  const m1 = qualifyingThreatIds.length > 0;

  // ── M2: strong named-threat match ──
  const m2 = isStrongNamedThreatMatch(s.namedThreat);
  const m2Domains = new Set<string>();
  const m2Urls = new Set<string>();
  if (m2 && s.namedThreatEntry) {
    const iocDomains = new Set(s.namedThreatEntry.ioc_domains.map((d) => d.toLowerCase()));
    const iocUrls = new Set(s.namedThreatEntry.ioc_urls.map((u) => u.toLowerCase()));
    for (const u of urls) {
      if (iocUrls.has(u.url.toLowerCase())) m2Urls.add(u.url.toLowerCase());
      if (u.host && iocDomains.has(u.host) && !isSharedHost(u.host)) m2Domains.add(u.host);
    }
  }

  // ── M3: high-specificity device-code lure ──
  const m3 = s.deviceCode.detected &&
    s.deviceCode.technique === "device_code_phishing" &&
    s.deviceCode.score >= DEVICE_CODE_RULE_THRESHOLD;

  // ── M4: risky attachment type ──
  let m4Ext: string | null = null;
  for (const a of s.attachments) {
    const ext = attachmentExtension(a.filename);
    if (ext && RISKY_ATTACHMENT_EXTENSIONS.has(ext)) { m4Ext = ext; break; }
  }
  const m4 = m4Ext !== null;

  const fired: RuleId[] = [];
  if (m4) fired.push("M4");
  if (m1) fired.push("M1");
  if (m2) fired.push("M2");
  if (m3) fired.push("M3");

  if (fired.length > 0) {
    // Highest-severity rule leads: M4 (CRITICAL malware) > M1 > M2 > M3.
    const primaryRule = fired[0]!;
    const reasonCodes: string[] = [];
    if (m4) reasonCodes.push(`m4_risky_attachment:${m4Ext!.slice(1)}`);
    if (m1) reasonCodes.push(`m1_intel_correlation:${qualifyingThreatIds.length}`);
    if (m2) reasonCodes.push(`m2_named_threat:${s.namedThreat!.id}`);
    if (m3) reasonCodes.push("m3_device_code");

    // Promotion: only URLs on matched infrastructure, only M1–M3.
    const legit = new Set(s.deviceCode.legitEndpointUrls.map((u) => u.toLowerCase()));
    const promote: string[] = [];
    for (const u of urls) {
      if (promote.length >= RULES_PROMOTE_CAP) break;
      const key = u.url.toLowerCase();
      if (legit.has(key)) continue;
      if (isOwnBrandHost(u.host, canonical)) continue;
      const onMatched =
        m1ExactUrls.has(key) ||
        (u.host !== null && m1Domains.has(u.host)) ||
        m2Urls.has(key) ||
        (u.host !== null && m2Domains.has(u.host));
      if (onMatched) promote.push(u.url);
    }

    const isMalware = primaryRule === "M4";
    return {
      kind:           "malicious",
      primaryRule,
      firedRules:     fired,
      classification: isMalware ? "malware" : "phishing",
      severity:       isMalware ? "CRITICAL" : "HIGH",
      action:         m1 && s.brand?.id ? "takedown" : "escalate",
      confidence:     RULE_CONFIDENCE[primaryRule],
      reasonCodes,
      qualifyingThreatIds,
      promoteUrls:    promote,
    };
  }

  // ── Review: fixed reason codes, never benign/spam ──
  const reasonCodes: string[] = [];
  if (s.isAttachmentForward && s.authResults) {
    if (isFail(s.authResults.dmarc)) reasonCodes.push("dmarc_fail");
    if (isFail(s.authResults.spf))   reasonCodes.push("spf_fail");
    if (isFail(s.authResults.dkim))  reasonCodes.push("dkim_fail");
  }
  const fromDomain = s.originalFrom?.split("@")[1]?.toLowerCase() ?? null;
  if (fromDomain && s.brand?.canonical_domain && !isOwnBrandHost(fromDomain, s.brand.canonical_domain) &&
      isTyposquatOf(sldOf(fromDomain), s.brand.canonical_domain.toLowerCase())) {
    reasonCodes.push(`from_typosquat:${s.brand.id}`);
  }
  if (s.namedThreat) reasonCodes.push("named_threat_weak");
  if (s.deviceCode.detected) reasonCodes.push("device_code_weak");
  if (s.threatCandidates.length > 0) reasonCodes.push("intel_match_unqualified");
  if (urls.length > 0) reasonCodes.push("has_urls");
  if (s.attachments.length > 0) reasonCodes.push("has_attachments");
  reasonCodes.push("no_intel_match");

  return {
    kind:           "review",
    classification: "ambiguous",
    severity:       "MEDIUM",
    action:         "review",
    confidence:     RULE_CONFIDENCE.review,
    reasonCodes,
  };
}

/** Primary rule recorded in a rules row's classification_reason, or
 *  'review' for a rules review row. Reads only the FIXED leading code. */
export function primaryRuleFromReason(reason: string | null | undefined): RuleId | "review" {
  const first = (reason ?? "").split(",")[0]?.trim() ?? "";
  if (first.startsWith("m1_")) return "M1";
  if (first.startsWith("m2_")) return "M2";
  if (first.startsWith("m3_")) return "M3";
  if (first.startsWith("m4_")) return "M4";
  return "review";
}
