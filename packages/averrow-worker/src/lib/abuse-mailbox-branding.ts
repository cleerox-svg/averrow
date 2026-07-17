/**
 * Per-org branding for the abuse-mailbox auto-responder (Tier 3).
 *
 * Resolves an `AbuseBranding` object the responder threads through every
 * ack / determination email. With no org row (or `enabled=0`, or an
 * invalid override) the loader returns `DEFAULT_ABUSE_BRANDING`, which
 * reproduces today's Averrow-branded output byte-for-byte — so the
 * responder's behaviour is unchanged for every org that hasn't opted in.
 *
 * Deliverability boundary: the envelope From local-part is FIXED to
 * Averrow's authenticated domain (`abuse-noreply@averrow.com`). An org
 * controls the display NAME over that address, plus the logo/colours/
 * links/copy — never the sending domain. Sending from a customer domain
 * needs that customer to delegate SPF/DKIM/DMARC and is a separate track.
 */

import type { Env } from "../types";

/** Authenticated envelope sender — never customer-controlled. */
export const ABUSE_NOREPLY_ADDRESS = "abuse-noreply@averrow.com";

export interface AbuseBranding {
  /** Display name over the fixed Averrow noreply address. */
  fromName: string;
  /** Header product name + preheader + "one of X's public mailboxes". */
  productName: string;
  /** Header subtitle. */
  tagline: string;
  /** Default accent stripe colour (#RRGGBB). Determination overrides per verdict. */
  accent: string;
  /** Header background colour (#RRGGBB). */
  headerBg: string;
  /** https logo URL. */
  logoUrl: string;
  /** Logo alt text. */
  logoAlt: string;
  /** Subject prefix before the middot separator. */
  subjectPrefix: string;
  /** Footer site link. */
  websiteUrl: string;
  websiteLabel: string;
  /** Footer "report another threat" link. */
  reportUrl: string;
  reportLabel: string;
  /** Footer descriptor printed after the site link. */
  footerNote: string;
}

export const DEFAULT_ABUSE_BRANDING: AbuseBranding = {
  fromName: "Averrow Abuse Triage",
  productName: "Averrow",
  tagline: "Abuse Triage",
  accent: "#E5A832",
  headerBg: "#0F1828",
  logoUrl: "https://averrow.com/logo-email-mark.png",
  logoAlt: "Averrow",
  subjectPrefix: "Averrow",
  websiteUrl: "https://averrow.com",
  websiteLabel: "averrow.com",
  reportUrl: "https://averrow.com/report-abuse",
  reportLabel: "averrow.com/report-abuse",
  footerNote: "threat intelligence + brand protection",
};

/** Full "Name <addr>" From header for Resend. */
export function fromAddressFor(b: AbuseBranding): string {
  return `${b.fromName} <${ABUSE_NOREPLY_ADDRESS}>`;
}

// ─── validation ────────────────────────────────────────────────────
// Overrides are operator-supplied; validate each field independently and
// drop just the bad ones (fall back to default), never the whole row.

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
// strip ASCII control chars, angle brackets and double-quotes — anything
// that would corrupt the From header or the email HTML.
const STRIP_CTRL_RE = new RegExp("[\\u0000-\\u001F<>\"]", "g");
// the middot is our subject/separator delimiter — never allow it inside a field.
const MIDDOT_RE = new RegExp("\\u00B7", "g");

function cleanText(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(STRIP_CTRL_RE, "").replace(MIDDOT_RE, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function cleanHex(v: unknown): string | null {
  return typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim() : null;
}

function cleanHttpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    return s.slice(0, 300);
  } catch {
    return null;
  }
}

interface BrandingRow {
  enabled: number;
  from_name: string | null;
  product_name: string | null;
  tagline: string | null;
  accent_color: string | null;
  header_bg_color: string | null;
  logo_url: string | null;
  logo_alt: string | null;
  subject_prefix: string | null;
  website_url: string | null;
  website_label: string | null;
  report_url: string | null;
  report_label: string | null;
  footer_note: string | null;
}

/** Merge a validated DB row over the Averrow defaults. Pure — exported for tests. */
export function resolveBranding(row: BrandingRow | null): AbuseBranding {
  if (!row || !row.enabled) return DEFAULT_ABUSE_BRANDING;
  const d = DEFAULT_ABUSE_BRANDING;
  return {
    fromName:      cleanText(row.from_name, 80) ?? d.fromName,
    productName:   cleanText(row.product_name, 60) ?? d.productName,
    tagline:       cleanText(row.tagline, 60) ?? d.tagline,
    accent:        cleanHex(row.accent_color) ?? d.accent,
    headerBg:      cleanHex(row.header_bg_color) ?? d.headerBg,
    logoUrl:       cleanHttpsUrl(row.logo_url) ?? d.logoUrl,
    logoAlt:       cleanText(row.logo_alt, 60) ?? cleanText(row.product_name, 60) ?? d.logoAlt,
    subjectPrefix: cleanText(row.subject_prefix, 40) ?? d.subjectPrefix,
    websiteUrl:    cleanHttpsUrl(row.website_url) ?? d.websiteUrl,
    websiteLabel:  cleanText(row.website_label, 60) ?? d.websiteLabel,
    reportUrl:     cleanHttpsUrl(row.report_url) ?? d.reportUrl,
    reportLabel:   cleanText(row.report_label, 80) ?? d.reportLabel,
    footerNote:    cleanText(row.footer_note, 120) ?? d.footerNote,
  };
}

/**
 * Load resolved branding for an org. Returns the Averrow default on a
 * null org, a missing/disabled row, or any DB error — the responder must
 * never fail to send because branding lookup hiccupped.
 */
export async function loadAbuseBranding(
  env: Env,
  orgId: number | null | undefined,
): Promise<AbuseBranding> {
  if (orgId == null) return DEFAULT_ABUSE_BRANDING;
  try {
    const row = await env.DB.prepare(
      `SELECT enabled, from_name, product_name, tagline, accent_color, header_bg_color,
              logo_url, logo_alt, subject_prefix, website_url, website_label,
              report_url, report_label, footer_note
       FROM org_abuse_branding WHERE org_id = ?`,
    ).bind(orgId).first<BrandingRow>();
    return resolveBranding(row ?? null);
  } catch {
    return DEFAULT_ABUSE_BRANDING;
  }
}
