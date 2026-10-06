/*
 * Shared nav metadata. Imported by Nav.astro (desktop bar + mobile menu)
 * and Footer.astro so the link list lives in one place.
 *
 * Five hub items. Platform, Solutions and Company carry a dropdown of
 * their child pages; Plans and Research are plain links. The Solutions
 * dropdown is also the list RelatedSurfaces reads with source="solutions". To add a page,
 * add it to the right hub's `children` and (if it lives outside the hub's
 * URL prefix) to that hub's `also` list so the hub lights up when active.
 */

export interface NavChild {
  href: string;
  label: string;
  /** One-line description shown under the label in the dropdown. */
  desc?: string;
}

export interface NavLink {
  href: string;
  label: string;
  children?: NavChild[];
  /** Extra path prefixes that should light this hub up. */
  also?: string[];
}

export const NAV_LINKS: NavLink[] = [
  {
    href: "/platform",
    label: "Platform",
    children: [
      { href: "/platform", label: "Platform overview", desc: "Everything Averrow watches, in one place" },
      { href: "/platform/lookalike-domains", label: "Lookalike domains", desc: "Know when someone registers your name" },
      { href: "/platform/impersonation", label: "Impersonation", desc: "Fake profiles and executive impersonation" },
      { href: "/platform/threat-detection", label: "Threat detection", desc: "Domains, certificates, feeds" },
      { href: "/platform/email-security", label: "Email security", desc: "SPF, DKIM and DMARC posture" },
      { href: "/platform/takedowns", label: "Takedowns", desc: "You set the rules, we do the filing" },
      { href: "/platform/abuse-mailbox", label: "Abuse mailbox", desc: "Triage reported phishing" },
      { href: "/platform/campaign-intelligence", label: "Campaign intelligence", desc: "Operations behind the attacks" },
    ],
  },
  {
    href: "/solutions",
    label: "Solutions",
    children: [
      { href: "/solutions", label: "All solutions", desc: "Start from your role" },
      { href: "/solutions/security-teams", label: "Security teams", desc: "Phishing, lookalikes and certificates, into your SIEM" },
      { href: "/solutions/brand-and-legal", label: "Brand and legal", desc: "Fake profiles, copycat apps, executives, trademark" },
      { href: "/solutions/fraud-and-customer-trust", label: "Fraud and customer trust", desc: "Reported phishing and phishing-site takedowns" },
      { href: "/solutions/teams-without-a-soc", label: "Teams without a SOC", desc: "Automated triage, plus our analysts on your alerts" },
      { href: "/solutions/mssp", label: "MSSPs and partners", desc: "One organisation per client, events into your SIEM" },
    ],
  },
  { href: "/pricing", label: "Plans" },
  {
    href: "/resources",
    label: "Research",
    also: ["/blog", "/docs", "/changelog", "/security"],
  },
  {
    href: "/company",
    label: "Company",
    // Press and Careers are anchors on /company (#press, #careers); /press and
    // /careers redirect there. Security is listed under Research in the footer,
    // so it lights up Research (not this hub).
    also: ["/about", "/why-averrow", "/contact"],
    children: [
      { href: "/company", label: "Company", desc: "The company behind Averrow" },
      { href: "/about", label: "About", desc: "Why Averrow exists" },
      { href: "/why-averrow", label: "Why Averrow", desc: "How we differ, in plain terms" },
      { href: "/contact", label: "Contact", desc: "Sales, support and general questions" },
    ],
  },
];

/** Customer sign-in. See Nav.astro: the shared sign-in page routes `client` users to /tenant/. */
export const LOGIN_HREF = "/login";

function matches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * Decide which top-level link should be marked active for a given
 * current path. Sub-pages activate their hub (`/blog/<slug>` lights up
 * Research, `/platform/email-security` lights up Platform, ...).
 *
 * @param currentPath - The current pathname (e.g. "/platform" or
 *   "/blog/my-post"). May be empty for the index route.
 */
export function activeFor(currentPath: string): string | null {
  // Astro's `Astro.url.pathname` can hand us any of:
  //   "/marketing/changelog/"   (build w/ base + trailingSlash dir)
  //   "/marketing/changelog"    (build w/ base, trailingSlash ignore)
  //   "/changelog/"             (post-cutover, trailingSlash dir)
  //   "/changelog"              (post-cutover, plain)
  // Normalise by dropping the base prefix and stripping the trailing slash.
  let stripped = currentPath.replace(/^\/marketing/, "");
  stripped = stripped.replace(/\/$/, "") || "/";
  for (const link of NAV_LINKS) {
    if (matches(stripped, link.href)) return link.href;
    if (link.also?.some(prefix => matches(stripped, prefix))) return link.href;
  }
  return null;
}
