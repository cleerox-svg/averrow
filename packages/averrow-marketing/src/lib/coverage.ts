/*
 * The eight surfaces Averrow watches: the single source of truth for the
 * homepage hero chips and the Coverage section (Section 4), so names and plan
 * tags cannot drift apart. Plans mirror src/pages/pricing.astro.
 *
 * `link` is the closest EXISTING page that actually describes the surface
 * (path relative to the site base; `#compare` is the pricing comparison
 * table). Dedicated pages come in a later section. Null = no honest target.
 */

export type CoveragePlan = "professional" | "business" | "enterprise";

export interface CoverageSurface {
  key: string;
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
    blurb: "Typo, homoglyph and brand-plus-keyword domains, checked when they appear and re-checked until they're gone.",
    link: "/platform/threat-detection#lookalike",
  },
  {
    key: "tls",
    name: "TLS certificates",
    plan: "professional",
    blurb: "Certificate-transparency checks every hour for certificates issued to brand-like names.",
    link: "/platform/threat-detection#what-we-monitor",
  },
  {
    key: "email",
    name: "Email authentication",
    plan: "professional",
    blurb: "SPF, DKIM and DMARC graded, so you know whether someone can send as you.",
    link: "/platform/email-security",
  },
  {
    key: "social",
    name: "Social profiles",
    plan: "professional",
    blurb: "Fake accounts and handle squatting on the six networks attackers use most.",
    link: "/platform/social-monitoring",
  },
  {
    key: "executive",
    name: "Executive impersonation",
    plan: "professional",
    blurb: "Fake profiles of your leadership, matched against their real handles.",
    link: "/platform/social-monitoring",
  },
  {
    key: "apps",
    name: "App stores",
    plan: "professional",
    blurb: "Copycat apps using your name or logo on the Apple App Store.",
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
    link: "/abuse-mailbox",
  },
];

export const COVERAGE_BY_KEY: Record<string, CoverageSurface> = Object.fromEntries(
  COVERAGE.map((s) => [s.key, s]),
);

/** Six networks on the Social profiles tile (matches pricing + social page). */
export const SOCIAL_NETWORKS = ["X", "LinkedIn", "Instagram", "TikTok", "GitHub", "YouTube"] as const;
