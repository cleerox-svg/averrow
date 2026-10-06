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

/** Date the facts block was last checked against the register (ISO, UTC). */
export const FACTS_AS_OF = "2026-10-06";

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

/** Press boilerplate. Approved phrasing: DISCLOSURE_REGISTER L42/L43 and section 3.11. */
export const BOILERPLATE =
  "Averrow is a digital risk protection platform operated by LRX Enterprises Inc., a Canadian company. " +
  "It finds look-alike domains, impersonation accounts, copycat apps and phishing aimed at a brand, and files " +
  "takedowns for look-alike domains and phishing URLs under the customer's authorization. Hosting providers and " +
  "registrars decide whether to remove content. A free domain scan needs no signup.";

/** Brand assets served by the Worker from packages/averrow-worker/public (same paths the old press page linked). */
export const BRAND_ASSETS = [
  { name: "Open Graph image", detail: "1200 x 630, PNG", href: "/brand/averrow-og.png" },
  { name: "Logo, 256px", detail: "PNG, transparent", href: "/brand/averrow-256.png" },
  { name: "Logo, 512px", detail: "PNG, transparent", href: "/brand/averrow-512.png" },
  { name: "Social tile, 400px", detail: "PNG", href: "/brand/averrow-social-400.png" },
  { name: "Social tile, 800px", detail: "PNG", href: "/brand/averrow-social-800.png" },
  { name: "Social tile, 1500px", detail: "PNG", href: "/brand/averrow-social-1500.png" },
  { name: "Favicon", detail: "SVG, scalable", href: "/favicon.svg" },
] as const;
