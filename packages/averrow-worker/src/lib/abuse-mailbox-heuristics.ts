// Averrow — Abuse Mailbox heuristic scoring (pure) — rule H1 "likely phishing"
//
// The evidence rules (M1–M4, lib/abuse-mailbox-rules.ts) only call a report
// malicious on positive evidence: a feed-listed URL, a named-threat IOC, a
// device-code lure, an executable attachment. A brand-new lure on a fresh
// domain matches none of them, so under AI_MODE=rules_only nearly every real
// report landed in "needs human review" (2026-10-03).
//
// H1 adds a weaker, explicitly-labelled tier: several independent phishing
// hallmarks together produce "Likely phishing". It never confirms, never
// promotes URLs into `threats`, and the reporter's email says "likely", not
// "confirmed" (user decision 2026-10-03).
//
// Each signal belongs to a FAMILY. H1 fires only when ALL of:
//   - the total score reaches H1_SCORE_THRESHOLD,
//   - at least H1_MIN_FAMILIES distinct families contributed (one loud
//     family — e.g. three urgency phrases — can't fire alone), and
//   - one of them is an ACTION family (lure or attachment): the message
//     must actually ask the reader to do something or carry a smuggling
//     attachment. Sender/brand mismatch + off-domain links alone describe
//     plenty of legitimate mail sent through marketing platforms.
//
// Pure: no I/O, no clock. Inputs are what intake already stored.

import { isMultiTenantHost, isPlatformTenantHost } from "./brandDetect";
import { registrableDomain } from "./domain-utils";
import { isTyposquatOf, sldLabel } from "./abuse-mailbox-brand-match";
import { isSafeDomain } from "./safeDomains";
import { isAuthFail, type AuthTriple } from "./abuse-mailbox-shared";

export const H1_SCORE_THRESHOLD = 5;
export const H1_MIN_FAMILIES = 2;
/** At least one of these must contribute for H1 to fire. */
export const H1_ACTION_FAMILIES: ReadonlySet<HeuristicFamily> = new Set(["lure", "attachment"]);
/** Confidence stamped on an H1 verdict: below every M-rule (85–90). */
export const H1_CONFIDENCE_BASE = 60;
export const H1_CONFIDENCE_MAX = 80;

export type HeuristicFamily = "identity" | "lure" | "link" | "attachment" | "auth";

export interface HeuristicSignal {
  /** Fixed reason code — never contains message content. */
  code:   string;
  family: HeuristicFamily;
  weight: number;
}

export interface HeuristicInput {
  /** The forwarded original sender. NULL when unknown — callers must pass
   *  null (not the reporter's address) when no forwarded sender was found. */
  senderEmail: string | null;
  subject:     string | null;
  /** Decoded body text (inner message when forwarded as attachment). */
  bodyText:    string | null;
  urls:        ReadonlyArray<{ url: string; host: string | null }>;
  attachments: ReadonlyArray<{ filename: string }>;
  brand:       { id: string; canonical_domain: string | null } | null;
  safeDomains: ReadonlySet<string> | null;
  /** Only meaningful when it describes the original sender. */
  authResults: AuthTriple | null;
  isAttachmentForward: boolean;
}

export interface HeuristicResult {
  score:    number;
  families: HeuristicFamily[];
  signals:  HeuristicSignal[];
  fired:    boolean;
  confidence: number;
}

// ─── Signal tables ───────────────────────────────────────────────

/** Account-threat / credential / payment lures. Each pattern is one lure
 *  "kind"; the lure family scores once per kind, capped below. */
const LURE_PATTERNS: ReadonlyArray<{ code: string; re: RegExp }> = [
  { code: "lure_account_locked",
    re: /\b(account|mailbox|profile|access)\b[^.\n]{0,40}\b(locked|suspended|blocked|disabled|restricted|deactivated|on hold|closed)\b|\b(we('|’)ve|we have) (locked|suspended|blocked|restricted)\b/i },
  { code: "lure_data_deletion",
    re: /\b(will be|are being|scheduled to be|going to be) (deleted|removed|erased|lost|purged)\b|\bstorage (is )?(full|limit|exceeded|almost full)\b/i },
  { code: "lure_verify_credentials",
    re: /\b(verify|confirm|validate|re-?activate|restore|unlock|update)\b[^.\n]{0,30}\b(account|identity|password|credentials|login|details|information|access)\b/i },
  { code: "lure_payment",
    re: /\b(payment|billing|card|subscription|invoice|renewal)\b[^.\n]{0,30}\b(failed|declined|expired|overdue|unsuccessful|problem|issue|update)\b|\bunpaid\b|\brefund (is )?(pending|available)\b/i },
  { code: "lure_signin_alert",
    re: /\b(unusual|suspicious|unrecognized|new) (sign[- ]?in|login|activity|device)\b|\bpassword (will )?expire/i },
  { code: "lure_delivery",
    re: /\b(parcel|package|shipment|delivery)\b[^.\n]{0,40}\b(held|on hold|failed|pending|unable|suspended|customs)\b/i },
];

const URGENCY_RE =
  /\b(within|in the next) \d{1,2} ?(hours?|hrs?|days?)\b|\b(immediately|urgent(ly)?|final (notice|warning|reminder)|last (alert|warning|notice|chance)|act now|right away|expires? today)\b/i;

/** Attachment types abused to smuggle phishing pages or macros. Executables
 *  are M4's (malware) job, not this list's. */
export const PHISH_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html", ".htm", ".shtml", ".xhtml", ".svg", ".mht", ".mhtml",
  ".docm", ".xlsm", ".pptm", ".dotm", ".xlam", ".one", ".iqy", ".slk",
]);

/** TLDs disproportionately used for throwaway phishing infrastructure. */
const ABUSED_TLDS: ReadonlySet<string> = new Set([
  "top", "xyz", "icu", "click", "shop", "live", "cfd", "sbs", "rest", "zip", "mov",
  "buzz", "monster", "cyou", "quest", "bond", "lol", "online", "site", "support", "help",
]);

const SHORTENER_HOSTS: ReadonlySet<string> = new Set([
  "bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "rb.gy", "ow.ly", "shorturl.at",
  "tiny.cc", "rebrand.ly", "t.ly", "s.id", "qrco.de",
]);

// ─── Helpers ─────────────────────────────────────────────────────

function hostOfUrl(u: string): string | null {
  try { return new URL(u).hostname.toLowerCase().replace(/\.$/, "") || null; } catch { return null; }
}

function extOf(filename: string): string | null {
  const f = filename.trim().toLowerCase().replace(/["'\s]+$/, "");
  const dot = f.lastIndexOf(".");
  return dot < 0 || dot === f.length - 1 ? null : f.slice(dot);
}

function isUnder(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

/**
 * Lookalike for H1: isTyposquatOf, minus its bare-containment case.
 * Containment alone ("microsoftonline", "amazonaws") matches the brands'
 * own real infrastructure; an impostor almost always adds a hyphen or a
 * digit ("acme-account-help", "paypa1-secure"). Homoglyph / edit-distance
 * hits (no containment) still count.
 */
export function isStrictLookalike(candidateSld: string, canonical: string): boolean {
  if (!isTyposquatOf(candidateSld, canonical)) return false;
  const canSld = sldLabel(canonical);
  if (!candidateSld.includes(canSld)) return true;
  return /[-\d]/.test(candidateSld);
}

/** True when the brand's own name appears as a whole word in `text`. */
function mentionsBrand(text: string, canonical: string): boolean {
  const label = sldLabel(canonical);
  if (label.length < 4) return false;
  return new RegExp(`(^|[^a-z0-9])${label.replace(/[^a-z0-9]/g, "")}([^a-z0-9]|$)`, "i").test(text);
}

const FORWARD_MARKERS: ReadonlyArray<RegExp> = [
  /-{5,}\s*Forwarded message\s*-{5,}/i,
  /-----Original Message-----/i,
  /Begin forwarded message:/i,
];

/**
 * For an inline forward, the stored body is the reporter's whole text part:
 * their own note and signature, then the forwarded message. Only the part
 * after the forward marker is the suspect's — "can you verify this account
 * email? looks urgent" must not score as a lure. No marker = unchanged.
 */
export function suspectPortion(text: string): string {
  // The EARLIEST marker of any kind: the reporter's own forward marker
  // always precedes the suspect's content, so a fake marker an attacker
  // buries deeper in their message can't hide the text before it.
  let cut = -1;
  for (const re of FORWARD_MARKERS) {
    const m = re.exec(text);
    if (m && (cut < 0 || m.index < cut)) cut = m.index + m[0].length;
  }
  return cut < 0 ? text : text.slice(cut);
}

// ─── Scoring ─────────────────────────────────────────────────────

export function scoreAbuseHeuristics(input: HeuristicInput): HeuristicResult {
  const signals: HeuristicSignal[] = [];
  const add = (code: string, family: HeuristicFamily, weight: number) => signals.push({ code, family, weight });

  const canonical = input.brand?.canonical_domain?.trim().toLowerCase().replace(/^www\./, "") || null;
  const safe = input.safeDomains ?? null;
  const isTrusted = (h: string): boolean =>
    (canonical !== null && isUnder(h, canonical)) || (safe !== null && isSafeDomain(h, safe as Set<string>));

  const senderDomain = input.senderEmail?.split("@")[1]?.trim().toLowerCase() || null;
  const senderReg = senderDomain ? registrableDomain(senderDomain) : null;

  const text = `${input.subject ?? ""}\n${suspectPortion(input.bodyText ?? "").slice(0, 20_000)}`;

  // ── identity: who the message claims to be vs who sent it ──
  // A brand_id can come from a mere link to the brand (a "Pay with PayPal"
  // footer), so a bare sender mismatch only counts when the message itself
  // names the brand AND never links to the brand's real domain.
  if (senderDomain && canonical && !isTrusted(senderDomain)) {
    if (isStrictLookalike(sldLabel(senderDomain), canonical)) {
      add("sender_lookalike_domain", "identity", 4);
    } else {
      const linksRealBrand = input.urls.some((u) => {
        const h = (u.host ?? hostOfUrl(u.url))?.replace(/^www\./, "") ?? null;
        return !!h && isUnder(h, canonical);
      });
      if (!linksRealBrand && mentionsBrand(text, canonical)) add("sender_not_brand", "identity", 3);
    }
  }

  // ── lure: what the message asks for ──
  let lureKinds = 0;
  for (const p of LURE_PATTERNS) {
    if (lureKinds >= 2) break;
    if (p.re.test(text)) { add(p.code, "lure", 2); lureKinds++; }
  }
  if (URGENCY_RE.test(text)) add("lure_urgency", "lure", 1);

  // ── link: where it sends you ──
  let linkPoints = 0;
  const linkCodes = new Set<string>();
  const linkAdd = (code: string, w: number) => {
    if (linkCodes.has(code)) return;
    linkCodes.add(code);
    linkPoints += w;
    add(code, "link", w);
  };
  for (const u of input.urls) {
    const host = (u.host ?? hostOfUrl(u.url))?.replace(/^www\./, "") ?? null;
    if (!host || isTrusted(host)) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) linkAdd("link_raw_ip", 3);
    if (host.split(".").some((l) => l.startsWith("xn--"))) linkAdd("link_punycode", 2);
    if (/^https?:\/\/[^/?#]*@/i.test(u.url)) linkAdd("link_userinfo_trick", 3);
    const sharedHost = isPlatformTenantHost(host) || isMultiTenantHost(host);
    if (SHORTENER_HOSTS.has(host)) linkAdd("link_shortener", 1);
    // A tenant subdomain on a free platform (x.pages.dev, x.web.app) or a
    // shared gateway (docs.google.com, github.com): anyone can publish there.
    else if (sharedHost) linkAdd("link_free_hosting", 2);
    const tld = host.split(".").pop() ?? "";
    if (ABUSED_TLDS.has(tld)) linkAdd("link_abused_tld", 1);
    // Lookalike checks skip shared platforms: "s3.amazonaws.com" is not an
    // Amazon impostor, and a tenant label on pages.dev already scored above.
    if (canonical && !sharedHost && isStrictLookalike(sldLabel(host), canonical)) {
      linkAdd("link_lookalike_domain", 3);
    }
    const brandLabel = canonical ? sldLabel(canonical) : "";
    if (canonical && !sharedHost && brandLabel.length >= 4 && !isUnder(host, canonical) &&
        host.split(/[.-]/).includes(brandLabel)) {
      // Brand as a whole label of someone else's host ("paypal.login-help.top",
      // "chase-verify.example") — not a substring ("purchase", "pineapple").
      linkAdd("link_brand_in_foreign_host", 2);
    }
    const hostReg = registrableDomain(host);
    if (senderReg && hostReg && hostReg !== senderReg) linkAdd("link_sender_mismatch", 1);
    if (linkPoints >= 5) break;
  }

  // ── attachment ──
  for (const a of input.attachments) {
    const ext = extOf(a.filename);
    if (ext && PHISH_ATTACHMENT_EXTENSIONS.has(ext)) { add(`attachment_${ext.slice(1)}`, "attachment", 3); break; }
  }

  // ── auth: only when the stored results describe the original sender ──
  if (input.isAttachmentForward && input.authResults) {
    if (isAuthFail(input.authResults.dmarc)) add("auth_dmarc_fail", "auth", 2);
    else if (isAuthFail(input.authResults.spf) || isAuthFail(input.authResults.dkim)) add("auth_spf_dkim_fail", "auth", 1);
  }

  const score = signals.reduce((s, x) => s + x.weight, 0);
  const families = Array.from(new Set(signals.map((s) => s.family)));
  const fired = score >= H1_SCORE_THRESHOLD &&
    families.length >= H1_MIN_FAMILIES &&
    families.some((f) => H1_ACTION_FAMILIES.has(f));
  const confidence = Math.min(H1_CONFIDENCE_MAX, H1_CONFIDENCE_BASE + (score - H1_SCORE_THRESHOLD) * 3);
  return { score, families, signals, fired, confidence: fired ? confidence : 0 };
}
