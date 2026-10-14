/**
 * Basemap data attribution: "© OpenStreetMap contributors" and "© CARTO", as plain text links in the stats bar.
 *
 * The map's own attribution control is OFF on purpose (it renders the style document's `attribution` string with
 * innerHTML, GHSA-jrc7-96c5-q579; see ThreatMapV3 and lib/map-security.test.ts). The licences still require the
 * credit, so it lives here: fixed literals in our own markup, never read from the style, links open in a new tab.
 * It wraps instead of hiding on a narrow screen, and is shown in every lens and projection (the globe uses the same
 * basemap).
 */

export const ATTRIBUTION_LINKS = [
  { text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' },
  { text: '© CARTO', href: 'https://carto.com/attributions' },
] as const;

export function MapAttribution({ className }: { className?: string }) {
  return (
    <span
      data-testid="map-attribution"
      aria-label="Map data attribution"
      className={['font-mono text-[10px] flex flex-wrap items-center justify-end gap-x-2 gap-y-0', className].filter(Boolean).join(' ')}
      style={{ color: 'var(--text-tertiary)' }}
    >
      {ATTRIBUTION_LINKS.map(l => (
        <a
          key={l.href}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          className="ds-focusable rounded-sm underline decoration-dotted underline-offset-2 hover:decoration-solid"
          style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}
        >
          {l.text}
        </a>
      ))}
    </span>
  );
}
