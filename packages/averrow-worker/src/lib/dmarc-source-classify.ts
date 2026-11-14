// Averrow — classify one DMARC aggregate-report (RUA) row into a sending-
// source class for the brand whose exact domain is the RFC5322.From domain.
//
// Pure: no I/O, no Env. Inputs are the already-parsed row fields (see
// DmarcRecordEvidence). The result is METADATA / EVIDENCE. In particular
// `spoof_candidate` means "this row fails DMARC and carries none of the
// evidence we know of that legitimate mail leaves behind" — it is a
// candidate for an analyst, never a confirmed spoofing finding, and must
// not be rendered to a customer as one.
//
// What RUA can and cannot show (see the feeds research, "Email
// authentication becomes a first-party spoofing sensor"): only mail that
// uses the customer's EXACT header-from domain, and only from receivers
// that send reports. Lookalike-domain mail never appears here.
//
// ─── Aggregate-report format: RFC 7489 Appendix C vs RFC 9990 ────────────
// RFC 9990 ("DMARC Aggregate Reporting", May 2026) is the DMARCbis
// reporting document that replaces RFC 7489's reporting sections. A parser
// must tolerate BOTH shapes, because receivers will keep sending 7489-style
// XML for a long time. Each item below was checked this session against the
// spec text on rfc-editor.org (rfc7489.html Appendix C, rfc9990.html)
// unless marked UNVERIFIED.
//
//  1. Namespace. VERIFIED: RFC 9990 requires the root element's namespace
//     to be `urn:ietf:params:xml:ns:dmarc-2.0`. VERIFIED: RFC 7489's schema
//     declares targetNamespace `http://dmarc.org/dmarc-xml/0.1`.
//     UNVERIFIED (prior knowledge): many real 7489-era reports carry no
//     xmlns at all, and some generators use a prefixed root
//     (`<dmarc:feedback>`) — a tag-name regex parser must not assume either
//     a namespace or its absence, and should match local names.
//  2. `<version>`. VERIFIED: RFC 7489 has `version` (xs:decimal) as the
//     first child of `feedback`, and the text says reports use "1.0".
//     VERIFIED: RFC 9990 keeps an OPTIONAL `version` (0..1) that MUST be
//     "1.0" — so the namespace, not `version`, distinguishes the formats,
//     and a missing `version` is valid.
//  3. `policy_published`. VERIFIED: RFC 7489 = domain, adkim, aspf, p, sp,
//     pct, fo. VERIFIED: RFC 9990 = domain, p (required), sp, np, fo, adkim,
//     aspf, testing ("y"|"n", the value of the new `t` tag),
//     discovery_method ("psl"|"treewalk") — all optional. `pct` is GONE
//     from RFC 9990's policy_published; a parser must treat pct as optional
//     and np / testing / discovery_method as possibly present.
//  4. Override reason types. VERIFIED: RFC 7489 PolicyOverrideType =
//     forwarded, sampled_out, trusted_forwarder, mailing_list, local_policy,
//     other. VERIFIED: RFC 9990 = local_policy, mailing_list, other,
//     policy_test_mode, trusted_forwarder — `forwarded` and `sampled_out`
//     are removed and `policy_test_mode` is new. Accept the union.
//  5. Disposition. VERIFIED: RFC 9990's policy_evaluated disposition adds
//     "pass" (no action, passing DMARC with an enforcing policy) beside
//     none / quarantine / reject. Don't treat "pass" as unknown.
//  6. auth_results. VERIFIED: RFC 7489 DKIM `selector` is optional
//     (minOccurs 0); RFC 9990 makes `selector` required when a DKIM
//     signature is reported. VERIFIED: RFC 9990 SPF `scope` is optional and
//     only "mfrom" is valid (RFC 7489 allowed "helo" | "mfrom"); `spf` is
//     0..1. VERIFIED: RFC 9990 SPFResultType adds "policy" (7489's did not
//     list it); DKIMResultType is unchanged (none, pass, fail, policy,
//     neutral, temperror, permerror).
//  7. Identifiers. VERIFIED: RFC 9990 `identifiers` = header_from
//     (required), envelope_from and envelope_to (optional).
//  8. Metadata / extensions. VERIFIED: RFC 9990 report_metadata adds an
//     optional `generator`; file-level `<extension>` sits after
//     policy_published and record-level extensions after auth_results;
//     unknown extensions SHOULD be ignored.
//  9. Discard rule. VERIFIED: RFC 9990 §3.1.1 says an evaluator SHOULD
//     discard a non-conforming document but MAY use some of its data —
//     i.e. tolerating the 7489 shape is permitted.
//
// ─── Classification rules (first match wins) ────────────────────────────
//  R1 aligned_pass      DMARC passed: policy_evaluated dkim OR spf = pass.
//  R2 forwarder_likely  The receiver itself said so: an override reason of
//                       forwarded / trusted_forwarder / mailing_list.
//  R3 forwarder_likely  A raw DKIM PASS for a brand-related domain.
//  R4 forwarder_likely  A raw SPF PASS for a brand-related domain.
//  R5 forwarder_likely  A brand-related DKIM signature with raw result
//                       `fail` AND a raw SPF pass for a NON-brand domain
//                       (the classic forward / list shape).
//  R6 unaligned_shared_esp  Source ASN is shared sending infrastructure
//                       (MULTI_TENANT_ASNS ∪ ESP_SENDER_ASNS), OR a raw
//                       DKIM pass for a known ESP signing domain.
//  R7 spoof_candidate   Everything else.
// Each rule's reasoning is next to its code below.
//
// "forwarder_likely" is the bucket for "evidence that this was the brand's
// own mail and DMARC broke for a non-spoofing reason" — in transit (R2, R5)
// or by alignment mode (R3, R4: strict adkim/aspf with a subdomain
// identifier). The name is kept for the interface; the reason string from
// explainDmarcSource() says which.
//
// Unknown ASN (`asn: null`):
//  - aligned_pass and forwarder_likely never read the ASN — unaffected.
//  - unaligned_shared_esp can still be reached through an ESP DKIM signing
//    domain (R6, second arm), but not through the ASN arm.
//  - otherwise the row falls to spoof_candidate. This is deliberate: an
//    unknown network must not be assumed benign. Downstream should show
//    the ASN as unknown so an analyst can weigh it.
//
// Organizational domain: we use lib/registrable-domain.ts (a built-in
// public-suffix table). DMARCbis replaced the PSL with a DNS tree walk
// (discovery_method "treewalk"), so for exotic suffixes our org domain can
// differ from the receiver's. It only affects whether a NON-aligned signal
// counts as "brand-related" (R3-R5), never R1.

import { MULTI_TENANT_ASNS, SINGLE_TENANT_IAAS_ASNS, asnKey } from "./shared-infra-asns";
import { registrableDomain } from "./registrable-domain";

export type DmarcSourceClass = 'aligned_pass' | 'forwarder_likely' | 'unaligned_shared_esp' | 'spoof_candidate';

export interface DmarcRecordEvidence {
  headerFrom: string;            // the brand's domain (RFC5322.From domain in the row)
  dkimAligned: 'pass' | 'fail';  // policy_evaluated.dkim
  spfAligned: 'pass' | 'fail';   // policy_evaluated.spf
  /** auth_results: every DKIM signature seen (domain + raw result) */
  dkimAuth: Array<{ domain: string; result: string }>;
  /** auth_results: SPF domain (envelope-from / HELO) + raw result, if present */
  spfAuth: { domain: string; result: string } | null;
  /** normalised 'AS<digits>' via asnKey, or null when unknown */
  asn: string | null;
  /** policy_evaluated reason types, e.g. 'forwarded', 'mailing_list', 'local_policy' */
  overrideReasons?: string[];
}

/**
 * Mail-sending networks, beyond MULTI_TENANT_ASNS, whose IPs send for many
 * unrelated customers: ESPs, mailbox providers and mail-security gateways.
 * HEURISTIC — tune it with real RUA data. Every entry's holder was looked up
 * on bgp.he.net on 2026-11-14. Google (AS15169), Microsoft (AS8075) and
 * Amazon incl. SES (AS16509) are already in MULTI_TENANT_ASNS.
 * Deliberately absent: Mailchimp / Mandrill, SparkPost and HubSpot — their
 * sending prefixes are announced under ASNs we could not confirm; they are
 * covered by ESP_DKIM_SIGNING_DOMAINS instead.
 */
export const ESP_SENDER_ASNS: ReadonlySet<string> = new Set<string>([
  "AS11377",  // SendGrid (Twilio SendGrid)
  "AS396479", // Mailgun Technologies (Sinch)
  "AS14340",  // Salesforce
  "AS22606",  // Salesforce (ex-ExactTarget, Marketing Cloud)
  "AS2639",   // Zoho
  "AS22843",  // Proofpoint (outbound relay / gateway)
  "AS30031",  // Mimecast North America (outbound relay / gateway)
  "AS36646",  // Yahoo (mailbox provider; also forwards)
  "AS714",    // Apple (iCloud Mail; also forwards / Hide My Email relays)
]);

/**
 * DKIM `d=` domains an ESP signs with when the customer has not set up a
 * custom (aligned) signing domain. A raw pass for one of these (or a
 * subdomain) means the mail really left that ESP. Matched as the domain
 * itself or any subdomain of it. HEURISTIC, extend from real data.
 */
export const ESP_DKIM_SIGNING_DOMAINS: ReadonlySet<string> = new Set<string>([
  "sendgrid.net",       // Twilio SendGrid
  "amazonses.com",      // Amazon SES
  "mcsv.net",           // Mailchimp
  "mandrillapp.com",    // Mailchimp Transactional (Mandrill)
  "mailgun.org",        // Mailgun
  "sparkpostmail.com",  // SparkPost / Bird
  "hubspotemail.net",   // HubSpot
  "gappssmtp.com",      // Google Workspace default (<dom>.<date>.gappssmtp.com)
  "onmicrosoft.com",    // Microsoft 365 default (<tenant>.onmicrosoft.com)
]);

for (const a of ESP_SENDER_ASNS) {
  if (!/^AS[0-9]+$/.test(a)) throw new Error(`ESP_SENDER_ASNS: non-canonical entry ${a}`);
  // A VPS / IaaS ASN is where attackers run their own MTAs; it must never
  // be whitelisted as "shared ESP" by accident.
  if (SINGLE_TENANT_IAAS_ASNS.has(a)) throw new Error(`ESP_SENDER_ASNS: ${a} is single-tenant IaaS`);
}

/** Receiver override reasons that assert the mail came via a forwarder / list. */
export const FORWARDING_OVERRIDE_REASONS: ReadonlySet<string> = new Set<string>([
  "forwarded",          // RFC 7489 only
  "trusted_forwarder",  // RFC 7489 + RFC 9990
  "mailing_list",       // RFC 7489 + RFC 9990
]);

const norm = (d: string | null | undefined): string =>
  (d ?? "").trim().toLowerCase().replace(/\.+$/, "");

const isPass = (r: string | null | undefined): boolean => norm(r) === "pass";

/**
 * `d` is the brand's domain, a subdomain of it, a parent of it, or shares
 * its organizational (registrable) domain. When the header-from has no
 * registrable domain (it is itself a public suffix) only the subdomain /
 * equality arms apply.
 */
export function isBrandRelatedDomain(d: string, headerFrom: string): boolean {
  const a = norm(d);
  const h = norm(headerFrom);
  if (!a || !h) return false;
  if (a === h || a.endsWith(`.${h}`) || h.endsWith(`.${a}`)) {
    // A parent that is a public suffix ("com", "co.uk") is not the brand.
    return registrableDomain(a) !== null || a === h || a.endsWith(`.${h}`);
  }
  const ra = registrableDomain(a);
  return ra !== null && ra === registrableDomain(h);
}

function isEspSigningDomain(d: string): boolean {
  const a = norm(d);
  for (const e of ESP_DKIM_SIGNING_DOMAINS) {
    if (a === e || a.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** True when the (any accepted form) ASN is shared mail-sending infrastructure. */
export function isSharedSendingAsn(raw: unknown): boolean {
  const k = asnKey(raw);
  return k !== null && (MULTI_TENANT_ASNS.has(k) || ESP_SENDER_ASNS.has(k));
}

/** DMARC passes if EITHER aligned check passes (RFC 7489 §6.6.2 / RFC 9989). */
export function dmarcPassed(e: Pick<DmarcRecordEvidence, 'dkimAligned' | 'spfAligned'>): boolean {
  return isPass(e.dkimAligned) || isPass(e.spfAligned);
}

export type DmarcSourceRule =
  | 'R1_dmarc_pass'
  | 'R2_receiver_forwarding_override'
  | 'R3_brand_dkim_pass_unaligned'
  | 'R4_brand_spf_pass_unaligned'
  | 'R5_forwarded_signature_broken'
  | 'R6_shared_sending_asn'
  | 'R6_esp_dkim_signature'
  | 'R7_no_legitimacy_evidence';

/** Classification plus the rule that fired — store the rule as evidence. */
export function explainDmarcSource(e: DmarcRecordEvidence): { cls: DmarcSourceClass; rule: DmarcSourceRule } {
  // R1 — DMARC passes when either aligned identifier passes. Nothing else
  // matters for the class. (A DKIM-replay attack also lands here: a replayed
  // brand-signed message passes DMARC. That is a volume/IP-anomaly problem,
  // not something a per-row classifier can see.)
  if (dmarcPassed(e)) return { cls: 'aligned_pass', rule: 'R1_dmarc_pass' };

  const brandDkim = e.dkimAuth.filter((s) => isBrandRelatedDomain(s.domain, e.headerFrom));
  const spfDomain = e.spfAuth ? norm(e.spfAuth.domain) : "";
  const spfRawPass = !!e.spfAuth && isPass(e.spfAuth.result) && spfDomain !== "";

  // R2 — the receiver's own judgement. Receivers set these after their own
  // forwarder / list detection (commonly ARC, RFC 8617, or allowlists of
  // known forwarders) — information we do not have in the aggregate row.
  // `local_policy`, `sampled_out`, `policy_test_mode` and `other` say only
  // that policy wasn't applied, not that the mail was legitimate, so they
  // are NOT evidence.
  if ((e.overrideReasons ?? []).some((r) => FORWARDING_OVERRIDE_REASONS.has(norm(r)))) {
    return { cls: 'forwarder_likely', rule: 'R2_receiver_forwarding_override' };
  }

  // R3 — a verified DKIM signature by the brand's own org domain cannot be
  // forged without the brand's private key, yet alignment failed. Real
  // causes: strict alignment (adkim=s) with a subdomain d= (d=mail.brand.com
  // vs From brand.com), or a reporter inconsistency. Either way the brand's
  // key signed it — legitimate brand mail, not spoofing.
  if (brandDkim.some((s) => isPass(s.result))) {
    return { cls: 'forwarder_likely', rule: 'R3_brand_dkim_pass_unaligned' };
  }

  // R4 — SPF passed for a brand-related envelope domain, i.e. the brand's
  // own SPF record authorises this IP, but alignment failed (strict
  // aspf=s with a bounce subdomain). The brand authorised the sender.
  // Caveat: a brand SPF `include:` of a shared ESP authorises every tenant
  // of that ESP; such abuse would usually also align under relaxed aspf
  // and land in R1 — this classifier can't separate it.
  if (spfRawPass && isBrandRelatedDomain(spfDomain, e.headerFrom)) {
    return { cls: 'forwarder_likely', rule: 'R4_brand_spf_pass_unaligned' };
  }

  // R5 — what a forwarder / mailing list looks like in aggregate data: the
  // body or signed headers were modified (list footer, subject tag) so the
  // brand's DKIM signature now verifies as `fail` (a real key was found and
  // the hash didn't match), and the envelope-from was rewritten (SRS or the
  // list's bounce address) so SPF passes for the forwarder's own domain.
  // Only raw `fail` counts: `permerror` / `neutral` / `none` / `temperror`
  // (malformed signature, missing key, DNS trouble) are not modification
  // evidence. Limitation: a spoofer can paste a stale brand signature and
  // send from a domain with its own SPF — the same shape. R2 is stronger.
  // A plain forwarder that keeps the brand envelope (SPF fails for the
  // brand) and breaks the signature is NOT matched here; it usually forwards
  // from a mailbox provider, which R6 catches.
  if (
    spfRawPass && !isBrandRelatedDomain(spfDomain, e.headerFrom)
    && brandDkim.some((s) => norm(s.result) === "fail")
  ) {
    return { cls: 'forwarder_likely', rule: 'R5_forwarded_signature_broken' };
  }

  // R6 — shared sending infrastructure. Most unaligned mail from ESPs,
  // mailbox providers and shared hosts is the customer's own tool (CRM,
  // marketing, ticketing, a website contact form) never set up for
  // alignment. But an attacker's account on the same ESP / shared host
  // looks identical, so this class means "not attributable to an operator
  // by IP/ASN", NOT "safe". MULTI_TENANT_ASNS also contains web hosts
  // (shared hosting mail, site builders) — same reasoning: the IP serves
  // many tenants. SINGLE_TENANT_IAAS_ASNS (VPS / EC2 / GCE) is deliberately
  // NOT here: a self-run MTA on a VPS is one operator.
  if (e.asn !== null && isSharedSendingAsn(e.asn)) {
    return { cls: 'unaligned_shared_esp', rule: 'R6_shared_sending_asn' };
  }
  // A verified signature by an ESP's default signing domain proves the mail
  // left that ESP, even when the ASN is unknown.
  if (e.dkimAuth.some((s) => isPass(s.result) && isEspSigningDomain(s.domain))) {
    return { cls: 'unaligned_shared_esp', rule: 'R6_esp_dkim_signature' };
  }

  // R7 — both aligned checks failed, no receiver override, no verified
  // brand signature / brand-authorised SPF, no forwarding shape, not shared
  // sending infrastructure. A candidate for analyst review only. Note an
  // UNVERIFIED (non-pass) brand-domain DKIM signature does not save a row:
  // a failing d=brand signature costs an attacker nothing to add.
  return { cls: 'spoof_candidate', rule: 'R7_no_legitimacy_evidence' };
}

export function classifyDmarcSource(e: DmarcRecordEvidence): DmarcSourceClass {
  return explainDmarcSource(e).cls;
}

/**
 * Suspicion rank, low → high. Exported so a SQL rollup can use
 * MAX(rank) and get exactly what folding mergeDmarcSourceClass gives.
 */
export const DMARC_SOURCE_CLASS_RANK: Readonly<Record<DmarcSourceClass, number>> = {
  aligned_pass: 0,
  forwarder_likely: 1,
  unaligned_shared_esp: 2,
  spoof_candidate: 3,
};

/**
 * For rolling several records of one source IP/day into one class: the most
 * suspicious class wins, with NO exceptions:
 *   spoof_candidate > unaligned_shared_esp > forwarder_likely > aligned_pass
 *
 * An exception was considered and rejected: "an IP that also produced
 * aligned passes is the brand's own sender, so demote its spoof_candidate
 * rows". Two reasons not to:
 *  1. Any such exception makes merge non-associative (aligned_pass is the
 *     identity elsewhere), so the rollup would depend on row order and
 *     disagree with a SQL MAX(rank). A total order is commutative,
 *     associative and idempotent.
 *  2. Aligned passes from an IP do not make its failing rows benign: DKIM
 *     replay and SPF-include abuse both produce aligned passes from attacker
 *     IPs. Keep the per-row classes for analysts to see the mix.
 */
export function mergeDmarcSourceClass(a: DmarcSourceClass, b: DmarcSourceClass): DmarcSourceClass {
  return DMARC_SOURCE_CLASS_RANK[a] >= DMARC_SOURCE_CLASS_RANK[b] ? a : b;
}
