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
});
