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
