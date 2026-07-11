/*
 * Changelog manifest — canonical source after R6 cutover. Mirrors
 * packages/trust-radar/src/templates/changelog-entries.ts during the
 * migration window. Keep both files in sync until R6 drops the
 * trust-radar copy.
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
      "Monitor 6 social platforms for brand impersonation with AI-powered confidence scoring.",
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
      "Added 12+ enterprise email selectors across major enterprise email security providers.",
  },
  {
    version: "v2.2.0",
    publishedAt: "2026-03-01",
    kind: "Feature",
    title: "AI Threat Narratives",
    description:
      "ASTRA agent now generates multi-signal threat narratives connecting email, domain, and social findings.",
  },
  {
    version: "v2.1.0",
    publishedAt: "2026-02-22",
    kind: "Feature",
    title: "Lookalike Domain Detection",
    description:
      "Comprehensive domain permutation engine with typosquat, homoglyph, and TLD swap detection.",
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
      "Averrow v2 with AI-powered threat detection, email security engine, and daily briefings.",
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
