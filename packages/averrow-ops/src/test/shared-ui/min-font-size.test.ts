import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Owner decision: readable text never renders below 11px. Source-level guard
// (jsdom can't compute CSS) across the three UI packages.
const ROOTS = ['../../../../averrow-ops/src', '../../../../averrow-tenant/src', '../../../../shared/src']
  .map((r) => resolve(__dirname, r));

// Frozen components keep their original sizes; tests/fixtures aren't UI.
const FROZEN = ['PortfolioHealthCard.tsx', 'EventTicker.tsx'];
// Pure icon glyphs drawn in a scaled SVG viewBox (not readable text).
const ICON_GLYPHS = [`${sep}brand${sep}AgentIcon.tsx`];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'test') continue;
      walk(p, out);
    } else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r)).filter(
  (f) => !FROZEN.some((z) => f.endsWith(z)) && !ICON_GLYPHS.some((g) => f.endsWith(g)),
);

// Posture-quadrant labels live in a 100-unit viewBox rendered at <=220px, so
// fontSize="6" is ~13px on screen (units, not px).
const SCALED_SVG = [`${sep}brands${sep}BrandDetail.tsx`];

const SUB_11 = '(?:[0-9]|10)(?:\\.[0-9]+)?';
const PATTERNS: Array<[string, RegExp]> = [
  ['tailwind text-[Npx]', new RegExp(`text-\\[${SUB_11}px\\]`)],
  ['inline fontSize: N', new RegExp(`fontSize:\\s*${SUB_11}\\s*[,}\\n]`)],
  ["inline fontSize: 'Npx'", new RegExp(`fontSize:\\s*['"]${SUB_11}px['"]`)],
  ['svg fontSize={N}', new RegExp(`fontSize=\\{${SUB_11}\\}`)],
  ['svg fontSize="N"', new RegExp(`fontSize="${SUB_11}"`)],
  ['css font-size: Npx', new RegExp(`font-size:\\s*${SUB_11}px`)],
];

describe('11px minimum font size', () => {
  it('scans a non-trivial number of files', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  for (const [label, re] of PATTERNS) {
    it(`no ${label} below 11px`, () => {
      const skip = label.startsWith('svg') ? SCALED_SVG : [];
      const hits = files
        .filter((f) => !skip.some((g) => f.endsWith(g)))
        .filter((f) => re.test(readFileSync(f, 'utf8')));
      expect(hits).toEqual([]);
    });
  }
});
