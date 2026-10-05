/*
 * Shared nav metadata. Imported by Nav.astro (desktop bar + mobile menu)
 * and Footer.astro so the link list lives in one place.
 *
 * Five hub items. Platform, Solutions and Company carry a dropdown of
 * their child pages; Pricing and Research are plain links. To add a page,
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
    also: ["/abuse-mailbox"],
    children: [
      { href: "/platform", label: "Platform overview", desc: "Everything Averrow watches, in one place" },
      { href: "/platform/threat-detection", label: "Threat detection", desc: "Domains, certificates, feeds" },
      { href: "/platform/social-monitoring", label: "Social monitoring", desc: "Fake profiles on six platforms" },
      { href: "/platform/email-security", label: "Email security", desc: "SPF, DKIM and DMARC posture" },
      { href: "/platform/campaign-intelligence", label: "Campaign intelligence", desc: "Operations behind the attacks" },
      { href: "/abuse-mailbox", label: "Abuse mailbox", desc: "Triage reported phishing" },
    ],
  },
  {
    href: "/solutions",
    label: "Solutions",
    children: [
      { href: "/solutions", label: "All solutions" },
      { href: "/solutions/startups", label: "Startups" },
      { href: "/solutions/mid-market", label: "Mid-market" },
      { href: "/solutions/mssp", label: "MSSPs and partners" },
    ],
  },
  { href: "/pricing", label: "Pricing" },
  {
    href: "/resources",
    label: "Research",
    also: ["/blog", "/docs", "/changelog"],
  },
  {
    href: "/company",
    label: "Company",
    also: ["/about", "/why-averrow", "/careers", "/press", "/partners", "/contact", "/security"],
    children: [
      { href: "/company", label: "Company overview" },
      { href: "/why-averrow", label: "Why Averrow" },
      { href: "/about", label: "About" },
      { href: "/security", label: "Security and trust" },
      { href: "/partners", label: "Partners" },
      { href: "/careers", label: "Careers" },
      { href: "/press", label: "Press" },
      { href: "/contact", label: "Contact" },
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
