/*
 * Company facts shared by /company, /contact and /demo so a mailbox, the legal
 * entity or the boilerplate is written once. Everything here is backed by
 * docs/DISCLOSURE_REGISTER.md rows L35-L47 and section 3.11:
 *  - the four addresses are real and monitored (owner decision, 2026-10-06);
 *  - form submissions go to a private owner address that must never appear on
 *    the site (checked against dist/ in tests/company-pages.spec.ts);
 *  - no response-time promise (L35): the only promise is REPLY_LINE;
 *  - no customers, logos, team members, press coverage or partners exist.
 */

export const LEGAL_ENTITY = "LRX Enterprises Inc.";

/** The only sentence about replies anywhere on the site. */
export const REPLY_LINE = "We'll reply by email.";

export interface ContactRoute {
  key: "sales" | "support" | "security" | "privacy";
  label: string;
  email: string;
  text: string;
}

export const CONTACT_ROUTES: readonly ContactRoute[] = [
  { key: "sales", label: "Sales", email: "sales@averrow.com", text: "Plans, demos and how Averrow would fit your brands." },
  { key: "support", label: "Support and general", email: "hello@averrow.com", text: "Help with an account, press requests, or any other question." },
  { key: "security", label: "Security", email: "security@averrow.com", text: "Report a vulnerability or a security concern." },
  { key: "privacy", label: "Privacy", email: "privacy@averrow.com", text: "Privacy questions and data requests." },
];

/** Address for one of the four routes, so pages never hard-code a mailbox. */
export function contactEmail(key: ContactRoute["key"]): string {
  return CONTACT_ROUTES.find((r) => r.key === key)?.email ?? "";
}

/** Press boilerplate. Approved phrasing: DISCLOSURE_REGISTER L42/L43 and section 3.11. */
export const BOILERPLATE =
  "Averrow is a digital risk protection platform operated by LRX Enterprises Inc., a Canadian company. " +
  "It finds look-alike domains, impersonation accounts, copycat apps and phishing aimed at a brand, and files " +
  "takedowns for look-alike domains and phishing URLs under the customer's authorization. Hosting providers and " +
  "registrars decide whether to remove content. A free domain scan needs no signup.";

/**
 * R3 brand assets (facelift 2026-11, BRAND_BRIEF §9 G1). Shipped from
 * packages/averrow-marketing/public/ (overlaid into the Worker's public/ by
 * scripts/sync-to-worker.mjs) under new filenames, so the frozen pre-R3 files
 * in packages/averrow-worker/public stay untouched and caches never serve a
 * stale logo. Sources: docs/brand/logo/.
 */
export const BRAND_ASSETS = [
  { name: "Open Graph image", detail: "1200 x 630, PNG", href: "/brand/og-r3-2026.png" },
  { name: "Lockup, dark backgrounds", detail: "SVG, scalable", href: "/brand/averrow-r3-lockup-dark.svg" },
  { name: "Lockup, light backgrounds", detail: "SVG, scalable", href: "/brand/averrow-r3-lockup-light.svg" },
  { name: "Lockup with tagline, dark", detail: "SVG, scalable", href: "/brand/averrow-r3-lockup-tagline-dark.svg" },
  { name: "Mark, red", detail: "SVG, transparent", href: "/brand/averrow-r3-mark.svg" },
  { name: "App icon, 512px", detail: "PNG", href: "/brand/averrow-r3-512.png" },
  { name: "Favicon", detail: "SVG, scalable", href: "/favicon-r3.svg" },
] as const;
