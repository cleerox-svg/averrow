// P3-3 guards for the facelift type layer (packages/shared/src/theme/type.css).
//
// 1. The --type-* scale equals BRAND_BRIEF.md §9 G3.
// 2. Every @font-face url() points at a file that exists (and is a woff2).
// 3. Legacy contract: 'Geist' / 'Geist Mono' and the --font-* overrides
//    appear only under [data-accent] selectors, so with no data-accent the
//    families never resolve to Geist and the browser downloads no Geist bytes.
// 4. tokens.css imports type.css (after appearance.css), and the Tailwind
//    configs expose the scale as text-type-* utilities.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const PACKAGES = resolve(__dirname, '../../../..');
const THEME = resolve(PACKAGES, 'shared/src/theme');
const read = (p: string) => readFileSync(p, 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const TYPE_PATH = resolve(THEME, 'type.css');
const TYPE = stripComments(read(TYPE_PATH));
const TOKENS = stripComments(read(resolve(THEME, 'tokens.css')));

/** Top-level rule blocks of a flat (non-nested) stylesheet: selector + body. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1]!.trim(), body: m[2]! });
  }
  return out;
}
function decls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const RULES = rules(TYPE);
const FONT_FACES = RULES.filter((r) => r.selector === '@font-face');
const ROOT = (() => {
  const r = RULES.find((x) => x.selector === ':root');
  if (!r) throw new Error('type.css has no plain :root block');
  return decls(r.body);
})();

describe('type scale tokens (BRAND_BRIEF §9 G3)', () => {
  // [size, line-height, weight, tracking]
  const G3: Record<string, [string, string, string, string]> = {
    display: ['32px', '36px', '600', '-0.03em'],
    h1: ['24px', '30px', '600', '0em'],
    h2: ['18px', '24px', '600', '0em'],
    body: ['14px', '21px', '400', '0em'],
    small: ['13px', '18px', '400', '0em'],
    label: ['12px', '16px', '500', '0.01em'],
    mono: ['13px', '20px', '400', '0em'],
  };
  for (const [role, [size, lh, weight, tracking]] of Object.entries(G3)) {
    it(`--type-${role}-* = ${size}/${lh}/${weight}/${tracking}`, () => {
      expect(ROOT.get(`--type-${role}-size`)).toBe(size);
      expect(ROOT.get(`--type-${role}-lh`)).toBe(lh);
      expect(ROOT.get(`--type-${role}-weight`)).toBe(weight);
      expect(ROOT.get(`--type-${role}-tracking`)).toBe(tracking);
    });
  }

  it('does not use the --text-* (colour) namespace', () => {
    expect(TYPE).not.toMatch(/--text-[\w-]*\s*:/);
  });
});

describe('@font-face', () => {
  it('declares Geist and Geist Mono with swap', () => {
    const families = FONT_FACES.map((f) => decls(f.body).get('font-family'));
    expect(families).toEqual(expect.arrayContaining(["'Geist'", "'Geist Mono'"]));
    for (const f of FONT_FACES) expect(decls(f.body).get('font-display')).toBe('swap');
  });

  it('every url() resolves to an existing woff2 file', () => {
    const urls = FONT_FACES.flatMap((f) => [...f.body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]!));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u.startsWith('./')).toBe(true);
      const file = resolve(dirname(TYPE_PATH), u);
      expect(existsSync(file), `${u} missing`).toBe(true);
      expect(file.endsWith('.woff2')).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(1000);
    }
  });

  it('ships the OFL licence next to the fonts', () => {
    expect(read(resolve(THEME, 'fonts/OFL.txt'))).toMatch(/SIL Open Font License/);
  });
});

describe('legacy contract: Geist only under [data-accent]', () => {
  it('Geist family names appear only in @font-face or [data-accent] rules', () => {
    for (const r of RULES) {
      if (r.selector === '@font-face') continue;
      if (/Geist/.test(r.body)) expect(r.selector, r.selector).toMatch(/\[data-accent\]/);
    }
  });

  it('--font-* and font-family overrides appear only under [data-accent]', () => {
    for (const r of RULES) {
      if (r.selector === '@font-face') continue;
      const d = decls(r.body);
      const touches = [...d.keys()].some((k) => k.startsWith('--font-') || k === 'font-family' || k === 'font');
      if (touches) expect(r.selector, r.selector).toMatch(/\[data-accent\]/);
    }
  });

  it('base element styles (font-size on body/h1/h2) are scoped under [data-accent]', () => {
    for (const r of RULES) {
      if (r.selector === '@font-face' || r.selector === ':root') continue;
      if (decls(r.body).has('font-size')) expect(r.selector).toMatch(/\[data-accent\]/);
    }
  });

  it('the --font-* overrides keep the legacy stacks as fallback', () => {
    const r = RULES.find((x) => x.selector === ':root[data-accent]');
    expect(r).toBeDefined();
    const d = decls(r!.body);
    expect(d.get('--font-sans')).toMatch(/^'Geist',.*'Plus Jakarta Sans'.*sans-serif$/);
    expect(d.get('--font-mono')).toMatch(/^'Geist Mono',.*'JetBrains Mono'.*monospace$/);
  });

  it('tokens.css (legacy :root) never names Geist', () => {
    expect(TOKENS).not.toMatch(/Geist/);
  });

  it('neither app preloads a Geist font', () => {
    for (const app of ['averrow-ops', 'averrow-tenant']) {
      expect(read(resolve(PACKAGES, app, 'index.html'))).not.toMatch(/geist/i);
    }
  });
});

describe('wiring', () => {
  it('tokens.css @imports type.css after appearance.css, before any rule', () => {
    const a = TOKENS.indexOf('@import "./appearance.css";');
    const t = TOKENS.indexOf('@import "./type.css";');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThan(a);
    expect(TOKENS.indexOf('{')).toBeGreaterThan(t);
  });

  it('both Tailwind configs expose the text-type-* scale', () => {
    for (const app of ['averrow-ops', 'averrow-tenant']) {
      const cfg = read(resolve(PACKAGES, app, 'tailwind.config.ts'));
      for (const role of ['display', 'h1', 'h2', 'body', 'small', 'label', 'mono']) {
        expect(cfg, `${app} type-${role}`).toContain(`'type-${role}': ['var(--type-${role}-size)'`);
      }
    }
  });
});
