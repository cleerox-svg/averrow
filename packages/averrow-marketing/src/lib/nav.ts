/*
 * Shared nav metadata + inline icons. Imported by Nav.astro and
 * MobileMenu.astro so the link list, icons, and labels live in one
 * place. To add a new top-level page, add a row here.
 *
 * Icons are inline SVG strings (Lucide-style). Stroke uses
 * currentColor so the CSS active treatment can flip color without
 * re-rendering.
 */

export interface NavLink {
  href: string;
  label: string;
  icon: string;
}

const ICON_BASE =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const NAV_LINKS: NavLink[] = [
  {
    href: "/platform",
    label: "Platform",
    icon: `<svg ${ICON_BASE}><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>`,
  },
  {
    href: "/pricing",
    label: "Pricing",
    icon: `<svg ${ICON_BASE}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.25" fill="currentColor"/></svg>`,
  },
  {
    href: "/about",
    label: "About",
    icon: `<svg ${ICON_BASE}><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 9h2"/><path d="M13 9h2"/><path d="M9 13h2"/><path d="M13 13h2"/><path d="M9 17h2"/><path d="M13 17h2"/></svg>`,
  },
  {
    href: "/security",
    label: "Security",
    icon: `<svg ${ICON_BASE}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`,
  },
  {
    href: "/blog",
    label: "Blog",
    icon: `<svg ${ICON_BASE}><path d="M4 4h16v16H4z"/><path d="M4 8h16"/><path d="M8 4v16"/></svg>`,
  },
  {
    href: "/contact",
    label: "Contact",
    icon: `<svg ${ICON_BASE}><path d="M3 5h18v14H3z"/><path d="M3 5l9 8 9-8"/></svg>`,
  },
];

/**
 * Decide which top-level link should be marked active for a given
 * current path. Sub-pages activate their parent (`/blog/<slug>` lights
 * up Blog).
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
    if (link.href === stripped) return link.href;
    if (link.href !== "/" && stripped.startsWith(link.href + "/")) return link.href;
  }
  return null;
}
