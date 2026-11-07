// P3-2a guards for the L2 primary migration.
//
// 1. Legacy equivalence: with NO data-accent attribute the UI must render
//    exactly as before. Components swapped amber literals for L2 tokens with
//    no fallback, so each L2 token must resolve (in tokens.css :root and in
//    the light block) to the literal it replaced.
// 2. Alias trap: --primary-glow is a literal at :root, so every scope that
//    overrides --amber-glow (shell-v4.css) must override --primary-glow to
//    the same value.
// 3. Amber ratchet: primary-pattern amber hits per package may only go down.
//    The baseline is amber-ratchet.baseline.json; lower it when you migrate
//    more sites, never raise it (new primary colour = an L2 token).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { countAmber, RATCHET_PACKAGES, RATCHET_PATTERN_KEYS } from './amberRatchet';

const PACKAGES = resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(resolve(PACKAGES, rel), 'utf8');

// ── a tiny tokens.css resolver (jsdom has no reliable cascade for this) ──
const TOKENS = read('shared/src/theme/tokens.css');
function declBlock(open: string): Map<string, string> {
  const start = TOKENS.indexOf(open);
  if (start < 0) throw new Error(`no block ${open}`);
  const body = TOKENS.slice(start + open.length, TOKENS.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}
const ROOT = declBlock(':root {');
const LIGHT = declBlock('[data-theme="light"] {');

/** Resolve a token to a normalised literal (lower-case, no spaces), following var() chains. */
function resolveToken(name: string, theme: 'dark' | 'light', depth = 0): string {
  if (depth > 12) throw new Error(`var() cycle at ${name}`);
  const raw = (theme === 'light' && LIGHT.has(name) ? LIGHT.get(name) : ROOT.get(name));
  if (raw === undefined) throw new Error(`${name} is not defined for ${theme}`);
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw);
  if (m) return resolveToken(m[1]!, theme, depth + 1);
  return raw.toLowerCase().replace(/\s+/g, '');
}

describe('L2 tokens are legacy-equivalent to the literals they replaced', () => {
  // [L2 token, the token / literal it replaced at call sites]
  const PAIRS: Array<[string, string]> = [
    ['--primary', '--amber'],
    ['--primary-text', '--amber-text'],
    ['--primary-pressed', '--amber-dim'],
    ['--primary-ink', '--text-on-amber'],
    ['--primary-glow', '--amber-glow'],
    // Focus outlines that used --amber-text (both themes) now use --focus-ring.
    ['--focus-ring', '--amber-text'],
    // The settings back link used --amber-text.
    ['--link', '--amber-text'],
    // The login card's top rim used --amber-border (P3-5 review).
    ['--primary-rim', '--amber-border'],
  ];
  for (const theme of ['dark', 'light'] as const) {
    it.each(PAIRS)(`${theme}: %s resolves to the value of %s`, (l2, legacy) => {
      expect(resolveToken(l2, theme)).toBe(resolveToken(legacy, theme));
    });
  }

  it('dark: --focus-ring is amber (it replaced var(--amber) rings whose light mode is overridden)', () => {
    expect(resolveToken('--focus-ring', 'dark')).toBe(resolveToken('--amber', 'dark'));
  });

  it('--primary is amber in BOTH themes (it replaced amber that was amber in both)', () => {
    expect(resolveToken('--primary', 'dark')).toBe('#e5a832');
    expect(resolveToken('--primary', 'light')).toBe('#e5a832');
  });

  it('color-mix(--primary N%, transparent) replacements: --primary is the opaque amber rgb(229,168,50)', () => {
    // color-mix(in srgb, X N%, transparent) == X at alpha N% (premultiplied), so it
    // equals rgba(229, 168, 50, N/100) only while --primary is the opaque amber hex.
    expect(resolveToken('--primary', 'dark')).toMatch(/^#e5a832$/);
  });
});

describe('--btn-primary-* are accent-only, so the legacy look renders the components\' fallbacks', () => {
  const BTN = ['--btn-primary-bg', '--btn-primary-bg-hover', '--btn-primary-ink', '--btn-primary-shadow', '--btn-primary-border'];
  it.each(BTN)('%s is not declared in the legacy :root or light block', (name) => {
    expect(ROOT.has(name)).toBe(false);
    expect(LIGHT.has(name)).toBe(false);
  });

  it('appearance.css declares --btn-primary-shadow / -border only under :root[data-accent], flat in every combo', () => {
    const css = read('shared/src/theme/appearance.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const hits = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /--btn-primary-(shadow|border)\s*:/.test(m[2]!));
    expect(hits.length).toBeGreaterThan(0);
    for (const m of hits) {
      expect(m[1]!.trim()).toMatch(/^:root\[data-accent\]/);
      expect(m[2]).toMatch(/--btn-primary-shadow:\s*0 0 #0000;/);
      expect(m[2]).toMatch(/--btn-primary-border:\s*transparent;/);
    }
  });
});

describe('scoped --amber-glow overrides carry their --primary-glow twin', () => {
  const SHELL = read('averrow-ops/src/components/layout/shell-v4.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [...SHELL.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1]!.trim(), body: m[2]! }))
    .filter((b) => /--amber-glow\s*:/.test(b.body));

  it('shell-v4.css overrides --amber-glow somewhere (guard is live)', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('every block that overrides --amber-glow overrides --primary-glow to the same value', () => {
    for (const b of blocks) {
      const v = (name: string) => b.body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.replace(/\s+/g, '');
      expect(v('--primary-glow'), `${b.sel} must override --primary-glow`).toBe(v('--amber-glow'));
    }
  });
});

describe('amber ratchet (primary-pattern amber may only go down)', () => {
  const baseline = JSON.parse(read('averrow-ops/src/test/shared-ui/amber-ratchet.baseline.json')) as Record<string, Record<string, number>>;
  const now = countAmber(PACKAGES);
  for (const pkg of RATCHET_PACKAGES) {
    for (const k of RATCHET_PATTERN_KEYS) {
      it(`${pkg}: ${k} matches the baseline`, () => {
        const b = baseline[pkg]?.[k];
        expect(b, `baseline missing ${pkg} / ${k}`).toBeTypeOf('number');
        const n = now[pkg]![k]!;
        expect(
          n,
          `${pkg} gained ${k} hits (${n} > ${b}). Use an L2 token (--primary, --primary-text, --focus-ring, ...) for primary colour; amber is a status colour.`,
        ).toBeLessThanOrEqual(b!);
        expect(
          n,
          `${pkg} ${k} dropped to ${n} (baseline ${b}): lower it in averrow-ops/src/test/shared-ui/amber-ratchet.baseline.json so the ratchet holds the gain.`,
        ).toBe(b);
      });
    }
  }
});
