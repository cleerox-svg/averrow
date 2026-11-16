/*
 * Changelog manifest — canonical source after R6 cutover. R6 has landed
 * (see RESTRUCTURE_SPEC.md) and packages/averrow-worker/src/templates/
 * changelog-entries.ts no longer exists — this file is the sole source
 * of truth, no mirror to keep in sync.
 */

export type ChangelogKind = "Feature" | "Improvement" | "Fix" | "Security";

export interface ChangelogEntry {
  /** Semver or marketing version. */
  version: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  publishedAt: string;
  title: string;
  description: string;
  kind: ChangelogKind;
}

export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    version: "v4.13.0",
    publishedAt: "2026-11-16",
    kind: "Feature",
    title: "A 24-hour view and colour for the analysis pipeline",
    description:
      "The live view of the automated analysis pipeline can now show the last 24 hours as well as the last hour, and replay the whole day at up to an hour per second. Each component now has its own colour on the map and the timeline, so you can follow where work is happening at a glance. Failed and partial runs are marked with patterns as well as colour, so they stand out whatever the component's colour. Controls are also larger and easier to use on phones.",
  },
  {
    version: "v4.12.0",
    publishedAt: "2026-11-16",
    kind: "Feature",
    title: "Replay the last hour of pipeline activity",
    description:
      "The live view of the automated analysis pipeline now shows how fresh its data is, and can replay the last hour. Drag along the timeline, or press Replay, to see what was running and what failed at any moment, at normal speed, 10 times or 60 times faster. Step through it a minute at a time with the keyboard, then return to live with one click.",
  },
  {
    version: "v4.11.0",
    publishedAt: "2026-11-15",
    kind: "Feature",
    title: "A live view of the automated analysis pipeline",
    description:
      "Operators now get a rebuilt live view of how the platform's automated analysis works, from incoming feeds through enrichment, correlation and reporting to response. Each stage is shown as a flowing map driven by real activity, so you can see what is running right now and what failed. A timeline of the last hour of activity sits beneath it, and hovering an item highlights it on the map. The map now reflects how the pipeline is actually connected, with retired and on-demand components grouped separately. It can be paused, respects reduced-motion settings, and works with a keyboard and screen readers.",
  },
  {
    version: "v4.10.0",
    publishedAt: "2026-11-09",
    kind: "Improvement",
    title: "The refreshed look reaches your everyday screens",
    description:
      "The refreshed look now reaches the screens you use every day: the navigation and overview, the alerts and threats views, the customer dashboard, the sign-in page, and the controls and panels of the global threat map. Text is clearer and calmer, with sentence case throughout and a larger minimum text size, and amber is kept for warnings only. Layouts are steadier, with columns that line up and numbers that no longer jump around, and there is no count-up or looping animation. Keyboard and screen-reader support is better, touch targets are larger on phones, and sign-in errors now appear above the sign-in buttons where you will see them. The customer 7-day trend always shows seven days, and threat-type names are spelled the same way everywhere.",
  },
  {
    version: "v4.9.1",
    publishedAt: "2026-11-08",
    kind: "Improvement",
    title: "More reliable sign-in and a calmer app",
    description:
      "Signing in is more dependable and easier to understand. If something goes wrong, you now land back on the sign-in page with a clear message instead of a dead end, and invitations and Google sign-in take you to the right place. Sign-in links in your email also keep working when an email security scanner opens them first: you confirm on a short page that shows your masked address. The app navigation has had a calmer, more consistent refresh, with clearer labels, steadier hover and active states, an honest offline indicator in place of the pulsing live badge, and better support for keyboard and screen-reader use. We also made the platform faster and more reliable under heavy load, and polished the wording in the sample operation report.",
  },
  {
    version: "v4.9.0",
    publishedAt: "2026-11-08",
    kind: "Improvement",
    title: "The new look reaches the website and emails",
    description:
      "The refreshed look and sharpened logo now carry across the whole website, the sign-in and system pages, and the emails you receive from us, so every touchpoint feels like the same product. Fonts load faster, moving between pages is smoother, and the home and platform pages now tell their story with gentle scroll animations that respect reduced-motion settings. The home page also opens with a short walkthrough of how a single operation is mapped from first signal to full picture. We also made the wording clearer: what we used to call fake profiles are now called impersonation accounts. Behind the scenes, the threats view now loads with far less work, which keeps sign-in and the rest of the platform responsive under heavy use.",
  },
  {
    version: "v4.8.0",
    publishedAt: "2026-11-07",
    kind: "Feature",
    title: "A refreshed look, and appearance that follows you",
    description:
      "The platform has a new look: a new indigo accent on a deep graphite background, a cleaner typeface built for reading data, a sharpened logo, and quick, subtle motion that respects reduced-motion settings. A new Appearance page in Settings lets you choose an accent color (Indigo, Violet, Mono, or Lime) and a dark background (Graphite or Navy). Your choices, along with light or dark mode, are saved to your account and follow you to every device. Amber is now used only to signal warnings, so it always means the same thing.",
  },
  {
    version: "v4.7.0",
    publishedAt: "2026-10-14",
    kind: "Feature",
    title: "Globe view and clearer operation mapping",
    description:
      "The threat map now has a globe view alongside the flat map, with true great-circle routes and a gentle idle rotation for wall displays. The operations view was rebuilt to stay readable at real scale: one point per country, one link per pair of countries weighted by how many operations share it, and the strongest evidence ranked first, with low-evidence groupings from shared hosting hidden by default. New views show which threats were weaponized fastest and, for teams that manage takedowns, where takedowns succeed. Also improved map contrast, keyboard and screen-reader support, and map data attribution.",
  },
  {
    version: "v4.6.0",
    publishedAt: "2026-10-14",
    kind: "Feature",
    title: "A rebuilt global threat map console",
    description:
      "The global threat map is now a full console organized around lenses: Threats, Operations, Movement, Hosting, Campaigns, and Actors. Open any node or link for a detail drawer, search across the map, replay activity on a timeline, and watch live pings with smoother animation, including breathing nodes, impact rings, flowing links, and infrastructure migration trails. The camera frames your selection automatically, and phones get a compact peek sheet. Views are now shareable by link, legends explain what you are seeing, and the map is more accessible, with a light theme, tap and keyboard support, and animation that respects reduced-motion settings. New data includes links between operations across countries, detected infrastructure migrations, hosting provider trends with known bulletproof hosts, weaponization speed, and takedown outcome summaries. Also fixed threat counts drifting upward over time, corrected severity ranking, placed attack arcs on real brand headquarters, fixed coverage percentages, and improved input validation and data freshness.",
  },
  {
    version: "v4.5.0",
    publishedAt: "2026-10-12",
    kind: "Improvement",
    title: "Map and Trends layout fixes",
    description:
      "Fixed the map zoom control overlapping other controls, and improved layouts on phones for map tables and the Trends summary metrics.",
  },
  {
    version: "v4.4.0",
    publishedAt: "2026-10-10",
    kind: "Feature",
    title: "Identity provider impersonation visibility",
    description:
      "A new Identity Threats view measures phishing that abuses or imitates sign-in providers such as Okta, Microsoft Entra, OneLogin, and Auth0 across every monitored brand. See key figures, a breakdown by attack method and by provider, the most targeted brands, a MITRE ATT&CK mapping, and the latest detections. Detection of sign-in lures is also broader, with wider coverage of lookalike domains, newly registered domains, and certificates using terms like sso, helpdesk, and vpn. Attacks are credited to the brand being targeted, and identity provider impersonation is no longer automatically dismissed when a domain has a clean reputation.",
  },
  {
    version: "v4.3.0",
    publishedAt: "2026-10-05",
    kind: "Feature",
    title: "A redesigned account experience",
    description:
      "One Settings area for Profile, Security, Notifications, and Devices & App, with a side rail on desktop and a simple list on phones. A new avatar menu adds a built-in theme switch and Switch account. The notification bell and inbox are rebuilt, with day grouping, filters, and actions that are always visible on phones. Security now lets you see each signed-in session, sign out a single device, sign out other devices, or sign out everywhere, and sign-outs take effect immediately. Notification settings are organized into Channels, Events, Summary, and Quiet hours, and changes save instantly and undo themselves if saving fails. Fixed quiet hours using the wrong time zone, quiet hours not always turning off, and one notification toggle sometimes resetting others. Critical alerts still break through quiet hours. Also fixed notification preferences failing to load. Customers now get the same account area, with larger touch targets, more readable text, and keyboard-friendly menus in both light and dark themes.",
  },
  {
    version: "v4.2.2",
    publishedAt: "2026-07-22",
    kind: "Fix",
    title: "More light-theme polish",
    description:
      "Fixed remaining dark panels and improved contrast in light theme, and made selected menu items and filters stand out more. No changes to dark theme.",
  },
  {
    version: "v4.2.1",
    publishedAt: "2026-07-22",
    kind: "Fix",
    title: "Light theme readability improvements",
    description:
      "Improved text and badge contrast in light theme across the platform for easier reading. No changes to dark theme.",
  },
  {
    version: "v4.2.0",
    publishedAt: "2026-07-20",
    kind: "Feature",
    title: "Executive impersonation monitoring",
    description:
      "Register your executives and get alerted when someone impersonates them on social platforms.",
  },
  {
    version: "v4.1.0",
    publishedAt: "2026-07-11",
    kind: "Improvement",
    title: "Sharper threat-actor attribution",
    description:
      "Improved threat-actor attribution — more detected infrastructure is now automatically linked to known, named actors instead of showing as unattributed.",
  },
  {
    version: "v4.0.0",
    publishedAt: "2026-06-22",
    kind: "Feature",
    title: "Averrow v4 — redesigned console",
    description:
      "A refreshed, more responsive interface: a unified security console, clearer navigation, and a mobile-ready layout.",
  },
  {
    version: "v3.0.0",
    publishedAt: "2026-06-21",
    kind: "Improvement",
    title: "Sign-in & login refresh",
    description:
      "Faster, more reliable passkey sign-in and a refreshed, on-brand login experience.",
  },
  {
    version: "v2.4.0",
    publishedAt: "2026-03-20",
    kind: "Feature",
    title: "Social Brand Monitoring",
    description:
      "Monitor 6 social platforms (X, LinkedIn, Instagram, TikTok, GitHub and YouTube) for brand impersonation with confidence scoring.",
  },
  {
    version: "v2.3.0",
    publishedAt: "2026-03-14",
    kind: "Feature",
    title: "Brand Exposure Report",
    description:
      "Free public scan tool generates comprehensive brand threat assessment.",
  },
  {
    version: "v2.2.1",
    publishedAt: "2026-03-08",
    kind: "Improvement",
    title: "DKIM Selector Expansion",
    description:
      "Expanded DKIM selector coverage across major enterprise email security providers.",
  },
  {
    version: "v2.2.0",
    publishedAt: "2026-03-01",
    kind: "Feature",
    title: "Threat Summaries",
    description:
      "Scoring and triage now produces multi-signal threat summaries connecting email, domain, and social findings.",
  },
  {
    version: "v2.1.0",
    publishedAt: "2026-02-22",
    kind: "Feature",
    title: "Lookalike Domain Detection",
    description:
      "Continuous lookalike-domain detection for monitored brands.",
  },
  {
    version: "v2.0.1",
    publishedAt: "2026-02-15",
    kind: "Fix",
    title: "Scanner False Positive Reduction",
    description:
      "Improved safe domain allowlisting and confidence thresholds.",
  },
  {
    version: "v2.0.0",
    publishedAt: "2026-02-08",
    kind: "Feature",
    title: "Platform Launch",
    description:
      "Averrow v2 with automated threat detection and an email security engine.",
  },
  {
    version: "v1.9.0",
    publishedAt: "2026-01-30",
    kind: "Security",
    title: "Domain Migration",
    description:
      "Completed migration from legacy domain to averrow.com with updated CSP and CORS.",
  },
];

export const ALL_KINDS: readonly ChangelogKind[] = [
  "Feature",
  "Improvement",
  "Fix",
  "Security",
];

export function sortedEntries(): ChangelogEntry[] {
  return [...CHANGELOG_ENTRIES].sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt),
  );
}

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  if (!y || !m || !d) return isoDate;
  return `${months[m - 1]} ${d}, ${y}`;
}

export function kindSlug(kind: ChangelogKind): string {
  return kind.toLowerCase();
}
