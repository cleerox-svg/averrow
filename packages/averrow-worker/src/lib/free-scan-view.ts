// Public view of a free scan (POST /api/brand-scan/public and
// GET /api/brand-scan/public/:id). This is the ONLY shape an anonymous
// caller ever sees for a scan: public DNS facts (email authentication,
// registered lookalike counts). Nothing from Averrow's threat data —
// feed_mentions and the threat-informed trust_score stay on the
// brand_scans row for staff.
//
// The view is computed once at scan time and stored as JSON in
// brand_scans.public_view, so the results link renders the same answer
// for as long as the row exists (90-day retention).

import type { EmailSecurityResult } from "../email-security";
import { normalizePublicHostname } from "./public-hostname";

export type EmailGrade = "A+" | "A" | "B" | "C" | "D" | "F";
export type SpfStatus = "pass" | "soft" | "neutral" | "missing";
export type DmarcPolicy = "reject" | "quarantine" | "none" | "missing";

export interface PublicEmailView {
  grade: EmailGrade;
  spf: { status: SpfStatus };
  dkim: { found: boolean };
  dmarc: { policy: DmarcPolicy };
  mx: { present: boolean };
  bimi: { present: boolean };
}

export interface PublicScanData {
  id: string;
  domain: string;
  checked_at: string;
  email: PublicEmailView;
  lookalikes: { checked: number; registered: number };
}

/** What brand_scans.public_view stores (id/domain live in their own columns). */
export interface StoredPublicView {
  v: 1;
  checked_at: string;
  email: PublicEmailView;
  lookalikes: { checked: number; registered: number };
}

const GRADES: readonly EmailGrade[] = ["A+", "A", "B", "C", "D", "F"];
const SPF: readonly SpfStatus[] = ["pass", "soft", "neutral", "missing"];
const DMARC: readonly DmarcPolicy[] = ["reject", "quarantine", "none", "missing"];

export function isEmailGrade(v: unknown): v is EmailGrade {
  return typeof v === "string" && (GRADES as readonly string[]).includes(v);
}

/**
 * SPF `all` qualifier → public status. `-all` pass, `~all` soft, `?all`
 * neutral. A record with no `all` term evaluates to neutral by default
 * (RFC 7208 §4.7), and `+all` authorises every sender, which we also
 * report as neutral (the record exists but does not restrict anyone).
 */
export function spfStatusFrom(exists: boolean, policy: string | null): SpfStatus {
  if (!exists) return "missing";
  if (policy === "-all") return "pass";
  if (policy === "~all") return "soft";
  return "neutral";
}

export function dmarcPolicyFrom(exists: boolean, policy: string | null): DmarcPolicy {
  if (!exists) return "missing";
  const p = (policy ?? "").toLowerCase();
  if (p === "reject" || p === "quarantine") return p;
  return "none";
}

/**
 * Map the email-security engine's result to the public view. The grade is
 * the engine's own A+–F grade (calculateEmailSecurityScore) — no second
 * scale. DKIM is a found/not-found flag only; the selectors probed and
 * found are never published.
 */
export function toPublicEmailView(r: EmailSecurityResult): PublicEmailView {
  return {
    grade: isEmailGrade(r.grade) ? r.grade : "F",
    spf: { status: spfStatusFrom(r.spf.exists, r.spf.policy) },
    dkim: { found: r.dkim.exists },
    dmarc: { policy: dmarcPolicyFrom(r.dmarc.exists, r.dmarc.policy) },
    mx: { present: r.mx.exists },
    bimi: { present: r.bimi.record !== null },
  };
}

/** Parse brand_scans.public_view; null for legacy rows or anything malformed. */
export function parseStoredPublicView(raw: string | null): StoredPublicView | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<StoredPublicView>;
    const e = o.email;
    if (o.v !== 1 || typeof o.checked_at !== "string" || !e || !o.lookalikes) return null;
    if (!isEmailGrade(e.grade)) return null;
    if (!(SPF as readonly string[]).includes(e.spf?.status ?? "")) return null;
    if (!(DMARC as readonly string[]).includes(e.dmarc?.policy ?? "")) return null;
    if (typeof o.lookalikes.checked !== "number" || typeof o.lookalikes.registered !== "number") return null;
    // Rebuild from an allowlist so nothing else in the JSON can leak out.
    return {
      v: 1,
      checked_at: o.checked_at,
      email: {
        grade: e.grade,
        spf: { status: e.spf!.status },
        dkim: { found: e.dkim?.found === true },
        dmarc: { policy: e.dmarc!.policy },
        mx: { present: e.mx?.present === true },
        bimi: { present: e.bimi?.present === true },
      },
      lookalikes: { checked: o.lookalikes.checked, registered: o.lookalikes.registered },
    };
  } catch {
    return null;
  }
}

export function toPublicScanData(id: string, domain: string, view: StoredPublicView): PublicScanData {
  return { id, domain, checked_at: view.checked_at, email: view.email, lookalikes: view.lookalikes };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isScanId(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// Two-label names whose first label is a common registry second level
// (co.uk, com.au, org.nz …). Scanning one of these must not make every
// address under it a "match" for report auto-delivery.
const REGISTRY_SECOND_LEVELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil"]);

/**
 * Auto-delivery rule: the lead's email domain equals the scanned domain
 * or is a subdomain of it (pat@mail.acme.com for acme.com). Both sides
 * are normalised (lowercase, punycode, leading www. dropped). A scanned
 * registry suffix such as co.uk only matches itself.
 */
export function emailMatchesScannedDomain(email: string, scannedDomain: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const host = normalizePublicHostname(email.slice(at + 1), { stripWww: true });
  const domain = normalizePublicHostname(scannedDomain, { stripWww: true });
  if (!host || !domain) return false;
  if (host === domain) return true;
  const labels = domain.split(".");
  if (labels.length === 2 && REGISTRY_SECOND_LEVELS.has(labels[0]!)) return false;
  return host.endsWith(`.${domain}`);
}
