import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Owner decision: readable text never renders below 11px. Source-level guard
// (jsdom can't compute CSS) across the three UI packages.
const ROOTS = ['../../../../averrow-ops/src', '../../../../averrow-tenant/src', '../../../../shared/src']
  .map((r) => resolve(__dirname, r));

// Frozen components keep their original sizes; tests/fixtures aren't UI.
const FROZEN = ['PortfolioHealthCard.tsx', 'EventTicker.tsx'];
// The shared login's type sizes are pinned by docs/SHARED_LOGIN_SPEC.md so it
// stays identical to FarmTrack; change the spec first, then this exemption.
const SPEC_PINNED = [`${sep}login${sep}LoginPage.tsx`];
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
  (f) => !FROZEN.some((z) => f.endsWith(z)) && !ICON_GLYPHS.some((g) => f.endsWith(g))
    && !SPEC_PINNED.some((g) => f.endsWith(g)),
);

// A line (or the line directly below a marker comment) can opt out with
// `min-font-ok: <reason>` — used for text drawn in a scaled SVG viewBox, where
// the number is user units, not CSS px (e.g. BrandDetail's posture-quadrant
// labels: fontSize="6" in a 100-unit viewBox rendered at <=220px ~ 13px).
const MARKER = 'min-font-ok';

// NOTE: this is a static, source-level guard. Computed sizes
// (`fontSize: size * 0.4`, `Math.round(...)`, values passed through props or
// variables, class names assembled at runtime) cannot be evaluated here; those
// must clamp at the call site (see `Math.max(11, ...)` in Brands.tsx and
// shared Avatar). Only literals, ternary branches and *Size keys are caught.

const SUB_11 = '(?:[0-9]|10)(?:\\.[0-9]+)?';
const EOV = '(?=\\s*(?:[,})\\]]|$))'; // end of a value: delimiter or end of line
const toPx = (n: string, unit: string) => parseFloat(n) * (unit === 'px' ? 1 : 16);
const REM_EM = '(\\d*\\.?\\d+)(rem|em)';

interface Rule {
  label: string;
  re: RegExp;
  /** Extra check on the match (rem/em are converted to px at 16px/rem). */
  bad?: (m: RegExpExecArray) => boolean;
}
const RULES: Rule[] = [
  { label: 'tailwind text-[Npx]', re: new RegExp(`text-\\[${SUB_11}px\\]`) },
  { label: 'tailwind text-[N.Nrem|em]', re: new RegExp(`text-\\[${REM_EM}\\]`), bad: (m) => toPx(m[1]!, m[2]!) < 11 },
  { label: 'inline fontSize: N', re: new RegExp(`fontSize:\\s*${SUB_11}${EOV}`) },
  { label: "inline fontSize: 'Npx'", re: new RegExp(`fontSize:\\s*['"]${SUB_11}px['"]`) },
  { label: "inline fontSize: 'N.Nrem|em'", re: new RegExp(`fontSize:\\s*['"]${REM_EM}['"]`), bad: (m) => toPx(m[1]!, m[2]!) < 11 },
  { label: 'fontSize ternary branch', re: new RegExp(`fontSize\\s*[:=][^\\n]*\\?(?:\\s*${SUB_11}\\s*:|[^\\n]*:\\s*${SUB_11}${EOV})`) },
  { label: 'font/label/text *Size key or const', re: new RegExp(`\\b\\w*(?:font|label|text)Size\\s*[:=]\\s*${SUB_11}${EOV}`, 'i') },
  { label: 'svg fontSize={N}', re: new RegExp(`fontSize=\\{${SUB_11}\\}`) },
  { label: 'svg fontSize="N"', re: new RegExp(`fontSize="${SUB_11}"`) },
  { label: 'css font-size: Npx', re: new RegExp(`font-size:\\s*${SUB_11}px`) },
  { label: 'css font-size: N.Nrem|em', re: new RegExp(`font-size:\\s*${REM_EM}`), bad: (m) => toPx(m[1]!, m[2]!) < 11 },
];

function violations(file: string, rule: Rule): string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (line.includes(MARKER) || (lines[i - 1] ?? '').includes(MARKER)) return;
    const m = rule.re.exec(line);
    if (m && (!rule.bad || rule.bad(m))) out.push(`${file}:${i + 1}: ${line.trim()}`);
  });
  return out;
}

describe('11px minimum font size', () => {
  it('scans a non-trivial number of files', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  for (const rule of RULES) {
    it(`no ${rule.label} below 11px`, () => {
      expect(files.flatMap((f) => violations(f, rule))).toEqual([]);
    });
  }
});
