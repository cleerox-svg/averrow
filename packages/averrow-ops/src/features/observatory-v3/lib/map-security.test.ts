import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// maplibre-gl <= 6.4.0 (we run 5.x) builds its attribution control, and any Popup given HTML, with innerHTML: the style
// document the basemap is fetched from is third-party, so its `attribution` markup would run in this origin
// (GHSA-jrc7-96c5-q579). The Observatory therefore never uses those APIs. This reads every non-test source file in
// the feature and fails if one starts to.
const root = resolve(__dirname, '..');
const code: Array<[string, string]> = (readdirSync(root, { recursive: true }) as string[])
  .map(p => p.replace(/\\/g, '/'))
  .filter(p => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith('.d.ts'))
  .map(p => [p, readFileSync(resolve(root, p), 'utf8')]);

/** Comments are prose about the hazard, not uses of it. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('map HTML-injection surface (GHSA-jrc7-96c5-q579)', () => {
  it('the glob found the feature\'s sources (guards the guard)', () => {
    expect(code.length).toBeGreaterThan(50);
    expect(code.some(([path]) => path.endsWith('components/ThreatMapV3.tsx'))).toBe(true);
  });

  it('no source builds map HTML: no Popup, setHTML, AttributionControl, customAttribution or innerHTML', () => {
    const banned = [/\bPopup\b/, /\bsetHTML\s*\(/, /\bAttributionControl\b/, /\bcustomAttribution\b/, /\binnerHTML\b/, /\bdangerouslySetInnerHTML\b/];
    const hits = code.flatMap(([path, src]) => banned.filter(re => re.test(stripComments(src))).map(re => `${path}: ${re}`));
    expect(hits).toEqual([]);
  });

  it('the map is constructed with the attribution control OFF, with a comment saying why it must stay off', () => {
    const [, src] = code.find(([path]) => path.endsWith('components/ThreatMapV3.tsx'))!;
    expect(stripComments(src)).toMatch(/attributionControl:\s*false/);
    expect(src).toContain('GHSA-jrc7-96c5-q579');
    expect(stripComments(src)).not.toMatch(/attributionControl:\s*true/);
  });

  it('the credit the control would have shown is plain text in our own markup: two fixed literals, never read from the style', () => {
    const [, attr] = code.find(([path]) => path.endsWith('components/MapAttribution.tsx'))!;
    const src = stripComments(attr);
    expect(src).toContain("'https://www.openstreetmap.org/copyright'");
    expect(src).toContain("'https://carto.com/attributions'");
    expect(src).toContain('© OpenStreetMap contributors');
    expect(src).toContain('© CARTO');
    expect(src).toMatch(/target="_blank"/);
    expect(src).toMatch(/rel="noopener noreferrer"/);
    expect(src).not.toMatch(/\bstyle\.|getStyle|attribution\s*[:=]\s*[a-z]/i); // nothing is taken from the style document
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });

  it('the page renders it unconditionally in the stats bar (not inside a lens / view branch)', () => {
    const [, page] = code.find(([path]) => path === 'ObservatoryV3.tsx')!;
    const src = stripComments(page);
    const at = src.indexOf('<MapAttribution');
    expect(at).toBeGreaterThan(0);
    expect(src.match(/<MapAttribution/g)).toHaveLength(1);
    // the statements around it are the footnote's JSX, with no ternary / && opening an unclosed branch for it
    const before = src.slice(src.lastIndexOf('<div', at), at);
    expect(before).not.toMatch(/\?\s*\(?\s*$|&&\s*\(?\s*$/);
  });
});
