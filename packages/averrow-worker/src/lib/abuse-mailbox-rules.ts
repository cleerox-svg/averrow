// Averrow — Abuse Mailbox rules-based determination (pure)
//
// Decides a verdict for a forwarded abuse report from deterministic
// evidence only — no AI, no I/O. Runs in the per-message
// AbuseMailboxTriageWorkflow (minutes after receipt) and in the hourly
// `17 * * * *` sweeper, BEFORE (and independently of) the AI classifier,
// so a report gets a real determination even under AI_MODE=rules_only.
//
// Message URLs are first unwrapped from link-protection / redirect
// wrappers (Outlook safelinks, Proofpoint urldefense v1-v3, google.com/url,
// l.facebook.com) — the wrapped target is the real link.
//
// Malicious verdicts require positive evidence:
//
//   M1  ≥1 qualifying intel correlation: a threat row that is
//       status='active', NOT sourced from the abuse mailbox itself, and
//       either
//         (a) an EXACT URL match (any feed), or
//         (b) a DOMAIN-level match where the threat's malicious_domain IS
//             the message host (the feed listed that host itself) AND the
//             feed is a domain-level phishing feed (openphish, phishtank,
//             phishing_database) or VT malicious > 0 / GSB flagged.
//             urlhaus / threatfox list payload URLs, so they only ever
//             count via (a).
//       Domain-level matches never count on multi-tenant / redirector /
//       shared hosts (brandDetect.isMultiTenantHost — a platform TENANT
//       subdomain like x.pages.dev is not shared), and nothing on the
//       reported brand's own domain or a brand safe domain ever counts.
//          → phishing / HIGH / takedown (brand-bound) or escalate / 90
//   M2  named-threat match on STRONG evidence (matchStrongestNamedThreat):
//       IOC domain / IOC url / regex. IP-only IOC hits, keyword/technique
//       scoring, and regex hits on device_code_phishing entries (those
//       match the real Microsoft endpoint — M3 owns that case) don't count.
//          → phishing / HIGH / escalate / 85
//   M3  device-code lure score >= 0.85 (endpoint + explicit code cue).
//          → phishing / HIGH / escalate / 85
//   M4  executable / script / disk-image attachment extension.
//          → malware / CRITICAL / escalate / 90
//
// Promotion to `threats`: EXACT matched URLs only (M1 exact-URL hits and
// M2 IOC-url hits). A domain-level match never promotes, and M3 / M4 never
// promote — a lure or an attachment says nothing about the other links.
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

import { isMultiTenantHost } from "./brandDetect";
import { isTyposquatOf, sldLabel } from "./abuse-mailbox-brand-match";
import { isSafeDomain } from "./safeDomains";
import { isAuthFail, type AuthTriple } from "./abuse-mailbox-shared";
import { detectDeviceCodePhishing, type DeviceCodeResult } from "./device-code-detector";
import {
  matchNamedThreat, matchStrongestNamedThreat, DEVICE_CODE_TECHNIQUE,
  type NamedThreatEntry, type NamedThreatMatch,
} from "./named-threat-matcher";

// ─── Constants ───────────────────────────────────────────────────

/** Feeds that list phishing at the DOMAIN level — their listing of a host
 *  is, on its own, corroboration that the host is attacker-operated.
 *  urlhaus / threatfox are deliberately absent: they list payload URLs
 *  (often on compromised or multi-tenant hosts), so they count for an
 *  exact-URL match only. */
export const DOMAIN_LEVEL_FEEDS: ReadonlySet<string> = new Set([
  "openphish", "phishtank", "phishing_database",
]);

/** Attachment extensions that deliver code or a mountable payload.
 *  `.com` is deliberately absent: "amazon.com" / "invoice-acme.com" style
 *  filenames are common in benign mail and would fire constantly. */
export const RISKY_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe", ".scr", ".js", ".vbs", ".hta", ".iso", ".img", ".lnk", ".xll",
  ".bat", ".cmd", ".ps1", ".jar", ".msi", ".cpl", ".vhd", ".vhdx",
]);

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
  /** brand_safe_domains (lib/safeDomains.ts format, wildcards allowed).
   *  A host in this set never counts as intel evidence and is never
   *  promoted. Optional — absent means no safe-domain filtering. */
  safeDomains?: ReadonlySet<string> | null;
  originalFrom: string | null;
  urls:    ReadonlyArray<{ url: string; domain: string | null }>;
  attachments: ReadonlyArray<{ filename: string; mime_type: string | null }>;
  /** SPF/DKIM/DMARC as parsed at intake. */
  authResults: AuthTriple | null;
  /** True when the report was forwarded AS AN ATTACHMENT, i.e. the stored
   *  auth results describe the original sender. Inline forwards / fresh
   *  reports carry the reporter's own provider auth — meaningless here. */
  isAttachmentForward: boolean;
  /** Threat rows found for the message's URL hosts (pre-filtered in SQL,
   *  re-checked here so the rule is testable without D1). */
  threatCandidates: ReadonlyArray<RulesThreatCandidate>;
  /** Best catalog match by any evidence (matchNamedThreat) — operator
   *  telemetry; on its own only ever a review reason code. */
  namedThreat: NamedThreatMatch | null;
  /** Best catalog match by STRONG evidence (matchStrongestNamedThreat) —
   *  the only input to M2, re-verified here. */
  strongNamedThreat: NamedThreatMatch | null;
  /** The catalog entry behind `strongNamedThreat`. */
  strongNamedThreatEntry: NamedThreatEntry | null;
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
  /** URLs to promote into `threats` — exact matched URLs only (M1
   *  exact-URL / M2 IOC-url), capped at RULES_PROMOTE_CAP. */
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

/** Lower-cased host without trailing dot or leading "www." — the same
 *  normalisation threats.malicious_domain uses (domain-utils.extractDomain). */
export function normHost(h: string | null | undefined): string | null {
  if (!h) return null;
  const v = h.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return v || null;
}

function hostFromUrl(u: string): string | null {
  try { return normHost(new URL(u).hostname); } catch { return null; }
}

/** Multi-tenant / redirector / shared host (brandDetect.isMultiTenantHost):
 *  a domain-level intel match here is never evidence. */
export function isSharedHost(host: string | null): boolean {
  if (!host) return false;
  return isMultiTenantHost(host);
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

const MAX_UNWRAP_DEPTH = 3;

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** One unwrap step, or null when `u` is not a recognised wrapper. */
function unwrapOnce(u: string): string | null {
  let parsed: URL;
  try { parsed = new URL(u); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const param = (name: string): string | null => parsed.searchParams.get(name);

  // Outlook / Defender for Office 365 Safe Links: ?url=<encoded target>
  if (host === "safelinks.protection.outlook.com" || host.endsWith(".safelinks.protection.outlook.com")) {
    return param("url");
  }
  // Proofpoint URL Defense.
  if (host === "urldefense.proofpoint.com" || host === "urldefense.com") {
    // v3: /v3/__<target>__;<checksum>
    const v3 = /\/v3\/__(.+?)__;/.exec(u);
    if (v3?.[1]) return v3[1];
    // v2: ?u=<target with '-'→'%' and '_'→'/'>
    if (path.startsWith("/v2/url")) {
      const enc = param("u");
      if (!enc) return null;
      try { return decodeURIComponent(enc.replace(/-/g, "%").replace(/_/g, "/")); } catch { return null; }
    }
    // v1: ?u=<percent-encoded target>
    if (path.startsWith("/v1/url")) return param("u");
    return null;
  }
  // google.com/url?q=<target> (also ?url=)
  if ((host === "google.com" || host === "www.google.com") && path === "/url") {
    return param("q") ?? param("url");
  }
  // Facebook link shim.
  if ((host === "l.facebook.com" || host === "lm.facebook.com") && path === "/l.php") {
    return param("u");
  }
  return null;
}

/**
 * Unwrap link-protection / redirect wrappers (Outlook safelinks, Proofpoint
 * urldefense v1/v2/v3, google.com/url, l.facebook.com) to the real target.
 * Returns the input unchanged when it is not a wrapper or the target is not
 * an http(s) URL. Nested wrappers are unwrapped up to MAX_UNWRAP_DEPTH.
 */
export function unwrapRedirectorUrl(url: string): string {
  let current = url;
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    const next = unwrapOnce(current);
    if (!next || !isHttpUrl(next) || next === current) break;
    current = next;
  }
  return current;
}

/**
 * Normalise a message's URL list for the rules: unwrap wrappers, recompute
 * the host from the (unwrapped) URL, dedupe case-insensitively. Idempotent.
 */
export function normalizeMessageUrls(
  urls: ReadonlyArray<{ url: string; domain: string | null }>,
): Array<{ url: string; domain: string | null }> {
  const out: Array<{ url: string; domain: string | null }> = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (!u?.url) continue;
    const target = unwrapRedirectorUrl(u.url);
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const host = target === u.url ? (normHost(u.domain) ?? hostFromUrl(target)) : hostFromUrl(target);
    out.push({ url: target, domain: host });
  }
  return out;
}

/**
 * Run the content detectors for a message. Exposed so the rules runner
 * and the AI path share one invocation shape.
 *   - namedThreat: best match by any evidence (operator telemetry)
 *   - strongNamedThreat: best match by strong evidence (M2 input); domain
 *     IOC hits on multi-tenant hosts are ignored
 */
export function runContentDetectors(
  catalog: ReadonlyArray<NamedThreatEntry>,
  msg: {
    subject: string | null;
    body: string | null;
    urls: ReadonlyArray<{ url: string; domain: string | null }>;
    senderIp: string | null;
  },
): {
  deviceCode: DeviceCodeResult;
  namedThreat: NamedThreatMatch | null;
  strongNamedThreat: NamedThreatMatch | null;
  strongNamedThreatEntry: NamedThreatEntry | null;
} {
  const deviceCode = detectDeviceCodePhishing({ subject: msg.subject, body: msg.body, urls: msg.urls });
  const candidate = {
    subject:   msg.subject,
    body:      msg.body,
    urls:      msg.urls,
    ips:       msg.senderIp ? [msg.senderIp] : [],
    technique: deviceCode.technique,
  };
  const namedThreat = matchNamedThreat(catalog, candidate);
  const strongNamedThreat = matchStrongestNamedThreat(catalog, candidate, { ignoreDomain: isSharedHost });
  const strongNamedThreatEntry = strongNamedThreat
    ? catalog.find((e) => e.id === strongNamedThreat.id) ?? null
    : null;
  return { deviceCode, namedThreat, strongNamedThreat, strongNamedThreatEntry };
}

/**
 * A named-threat match qualifies for M2 only on an IOC domain / IOC url hit,
 * or a regex hit on an entry that is NOT a device-code entry. IP-only and
 * keyword/technique matches never qualify.
 */
export function isStrongNamedThreatMatch(
  m: NamedThreatMatch | null,
  entry: NamedThreatEntry | null,
): boolean {
  if (!m) return false;
  const deviceCodeEntry = (entry?.technique ?? m.technique) === DEVICE_CODE_TECHNIQUE;
  return m.reasons.some((r) =>
    r.startsWith("ioc_domain:") || r === "ioc_url" || (r === "regex" && !deviceCodeEntry));
}

// ─── The decision ────────────────────────────────────────────────

/**
 * Decide the rules verdict for one message. Pure — no I/O, no clock.
 */
export function decideAbuseMailboxRulesVerdict(s: RulesSnapshot): RulesVerdict {
  const canonical = s.brand?.canonical_domain ?? null;
  const safe = s.safeDomains ?? null;
  /** Hosts that are never evidence and never promoted. */
  const isExcludedHost = (h: string | null): boolean =>
    !!h && (isOwnBrandHost(h, canonical) || (safe !== null && isSafeDomain(h, safe as Set<string>)));

  const urls = normalizeMessageUrls(s.urls).map((u) => ({ url: u.url, host: normHost(u.domain) }));
  const urlSet = new Set(urls.map((u) => u.url.toLowerCase()));
  const msgHosts = new Set(urls.map((u) => u.host).filter((h): h is string => !!h));

  // ── M1: qualifying intel correlation ──
  const qualifyingThreatIds: string[] = [];
  const m1ExactUrls = new Set<string>();     // lower-cased URLs matched exactly
  for (const t of s.threatCandidates) {
    if (t.status !== "active") continue;
    if (t.source_feed === "abuse_mailbox") continue;

    // (a) exact URL — any corroborating feed.
    const tUrl = t.malicious_url?.toLowerCase() ?? null;
    if (tUrl && urlSet.has(tUrl)) {
      if (isExcludedHost(hostFromUrl(tUrl))) continue;
      m1ExactUrls.add(tUrl);
      qualifyingThreatIds.push(t.id);
      continue;
    }

    // (b) domain level — the feed listed this exact host.
    const tDomain = normHost(t.malicious_domain);
    if (!tDomain || !msgHosts.has(tDomain)) continue;
    if (isExcludedHost(tDomain)) continue;
    if (isSharedHost(tDomain)) continue;
    if (t.malicious_url) {
      const listedHost = hostFromUrl(t.malicious_url);
      if (listedHost !== null && listedHost !== tDomain) continue;
    }
    const corroborated =
      (t.vt_malicious ?? 0) > 0 ||
      (t.gsb_flagged ?? 0) === 1 ||
      DOMAIN_LEVEL_FEEDS.has(t.source_feed);
    if (!corroborated) continue;
    qualifyingThreatIds.push(t.id);
  }
  const m1 = qualifyingThreatIds.length > 0;

  // ── M2: strong named-threat match ──
  const m2 = isStrongNamedThreatMatch(s.strongNamedThreat, s.strongNamedThreatEntry);
  const m2Urls = new Set<string>();
  if (m2 && s.strongNamedThreatEntry) {
    const iocUrls = new Set(s.strongNamedThreatEntry.ioc_urls.map((u) => u.toLowerCase()));
    for (const u of urls) {
      if (iocUrls.has(u.url.toLowerCase())) m2Urls.add(u.url.toLowerCase());
    }
  }

  // ── M3: high-specificity device-code lure ──
  const m3 = s.deviceCode.detected &&
    s.deviceCode.technique === DEVICE_CODE_TECHNIQUE &&
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
    if (m2) reasonCodes.push(`m2_named_threat:${s.strongNamedThreat!.id}`);
    if (m3) reasonCodes.push("m3_device_code");

    // Promotion: exact matched URLs only (M1 exact-URL, M2 IOC-url).
    const legit = new Set(s.deviceCode.legitEndpointUrls.map((u) => u.toLowerCase()));
    const promote: string[] = [];
    for (const u of urls) {
      if (promote.length >= RULES_PROMOTE_CAP) break;
      const key = u.url.toLowerCase();
      if (legit.has(key)) continue;
      if (isExcludedHost(u.host)) continue;
      if (m1ExactUrls.has(key) || m2Urls.has(key)) promote.push(u.url);
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
    if (isAuthFail(s.authResults.dmarc)) reasonCodes.push("dmarc_fail");
    if (isAuthFail(s.authResults.spf))   reasonCodes.push("spf_fail");
    if (isAuthFail(s.authResults.dkim))  reasonCodes.push("dkim_fail");
  }
  const fromDomain = s.originalFrom?.split("@")[1]?.toLowerCase() ?? null;
  if (fromDomain && s.brand?.canonical_domain && !isOwnBrandHost(fromDomain, s.brand.canonical_domain) &&
      isTyposquatOf(sldLabel(fromDomain), s.brand.canonical_domain.toLowerCase())) {
    reasonCodes.push(`from_typosquat:${s.brand.id}`);
  }
  if (s.namedThreat || s.strongNamedThreat) reasonCodes.push("named_threat_weak");
  if (s.deviceCode.detected) reasonCodes.push("device_code_weak");
  if (urls.length > 0) reasonCodes.push("has_urls");
  if (s.attachments.length > 0) reasonCodes.push("has_attachments");
  // Exactly one intel code: candidates existed but none qualified, or none.
  reasonCodes.push(s.threatCandidates.length > 0 ? "intel_match_unqualified" : "no_intel_match");

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
