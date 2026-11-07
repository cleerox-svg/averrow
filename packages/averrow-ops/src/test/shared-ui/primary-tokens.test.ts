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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

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

// ── amber ratchet ──────────────────────────────────────────────────────
const RATCHET_PACKAGES = ['averrow-ops', 'averrow-tenant', 'shared'] as const;
const PATTERNS: Record<string, RegExp> = {
  'var(--amber)': /var\(--amber\)/g,
  '#e5a832': /#e5a832/gi,
  'rgba(229, 168, 50': /rgba\(\s*229\s*,\s*168\s*,\s*50\b/g,
  'tailwind (text|bg|border|ring)-amber': /\b(?:text|bg|border|ring)-amber\b/g,
};
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'appearance.css') out.push(p);
  }
  return out;
}

/** Count per package + pattern. tokens.css custom-property DEFINITIONS are allowlisted. */
export function countAmber(): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const pkg of RATCHET_PACKAGES) {
    const counts: Record<string, number> = Object.fromEntries(Object.keys(PATTERNS).map((k) => [k, 0]));
    for (const file of walk(resolve(PACKAGES, pkg, 'src'))) {
      let src = readFileSync(file, 'utf8');
      if (relative(PACKAGES, file) === join('shared', 'src', 'theme', 'tokens.css')) {
        src = src.split('\n').filter((l) => !/^\s*--[\w-]+\s*:/.test(l)).join('\n');
      }
      for (const [k, re] of Object.entries(PATTERNS)) counts[k]! += src.match(re)?.length ?? 0;
    }
    result[pkg] = counts;
  }
  return result;
}

describe('amber ratchet (primary-pattern amber may only go down)', () => {
  const baseline = JSON.parse(read('averrow-ops/src/test/shared-ui/amber-ratchet.baseline.json')) as Record<string, Record<string, number>>;
  const now = countAmber();
  for (const pkg of RATCHET_PACKAGES) {
    for (const k of Object.keys(PATTERNS)) {
      it(`${pkg}: ${k} <= baseline`, () => {
        const b = baseline[pkg]?.[k];
        expect(b, `baseline missing ${pkg} / ${k}`).toBeTypeOf('number');
        expect(
          now[pkg]![k],
          `${pkg} gained ${k} hits (${now[pkg]![k]} > ${b}). Use an L2 token (--primary, --primary-text, --focus-ring, ...) for primary colour; amber is a status colour. If you REMOVED hits, lower the baseline.`,
        ).toBeLessThanOrEqual(b!);
      });
    }
  }
});
