/*
 * The eight surfaces Averrow watches: the single source of truth for the
 * homepage hero chips and the Coverage section (Section 4), so names and plan
 * tags cannot drift apart. Plans mirror src/pages/pricing.astro.
 *
 * `link` is the page that describes the surface (path relative to the site
 * base; `#compare` is the pricing comparison table). The eight Platform pages
 * (Section 8) are /platform/lookalike-domains, /impersonation, /threat-detection,
 * /email-security, /takedowns, /abuse-mailbox and /campaign-intelligence, plus
 * the /platform overview. Apps still points at the plans comparison until the
 * Impersonation page (phase 2) carries an app-store section. Null = no honest target.
 */

export type CoverageKey = "lookalike" | "tls" | "email" | "social" | "executive" | "apps" | "darkweb" | "abuse";

export type CoveragePlan = "professional" | "business" | "enterprise";

export interface CoverageSurface {
  key: CoverageKey;
  name: string;
  plan: CoveragePlan;
  blurb: string;
  link: string | null;
}

export const PLAN_LABEL: Record<CoveragePlan, { full: string; short: string }> = {
  professional: { full: "Professional+", short: "Pro+" },
  business: { full: "Business+", short: "Business+" },
  enterprise: { full: "Enterprise", short: "Enterprise" },
};

export const COVERAGE: readonly CoverageSurface[] = [
  {
    key: "lookalike",
    name: "Lookalike domains",
    plan: "professional",
    blurb: "Character-swap and brand-plus-keyword domains, checked when they appear and re-checked until they're gone.",
    link: "/platform/lookalike-domains",
  },
  {
    key: "tls",
    name: "TLS certificates",
    plan: "professional",
    blurb: "Certificate-transparency checks every hour for certificates issued to brand-like names.",
    link: "/platform/lookalike-domains#certificates",
  },
  {
    key: "email",
    name: "Email authentication",
    plan: "professional",
    blurb: "SPF, DKIM and DMARC checked, with one grade for your domain.",
    link: "/platform/email-security",
  },
  {
    key: "social",
    name: "Social profiles",
    plan: "professional",
    blurb: "Fake accounts and handle squatting on six major networks.",
    link: "/platform/impersonation",
  },
  {
    key: "executive",
    name: "Executive impersonation",
    plan: "professional",
    blurb: "Accounts using your executives' names, flagged when they aren't their official handles.",
    link: "/platform/impersonation",
  },
  {
    key: "apps",
    name: "App stores",
    plan: "professional",
    blurb: "Copycat apps using your name on the Apple App Store.",
    link: "/pricing#compare",
  },
  {
    key: "darkweb",
    name: "Dark web",
    plan: "business",
    blurb: "Mentions of your brand on paste sites and ransomware leak sites.",
    link: "/platform/threat-detection#what-we-monitor",
  },
  {
    key: "abuse",
    name: "Abuse mailbox",
    plan: "enterprise",
    blurb: "A branded inbox for suspicious emails, classified automatically and fed into your threat queue.",
    link: "/platform/abuse-mailbox",
  },
];

/** Six networks on the Social profiles tile (matches pricing + social page). */
export const SOCIAL_NETWORKS = ["X", "LinkedIn", "Instagram", "TikTok", "GitHub", "YouTube"] as const;
