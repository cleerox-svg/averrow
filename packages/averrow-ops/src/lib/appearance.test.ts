// @vitest-environment jsdom
//
// Appearance system (Phase 3, P3-1): storage round-trip, safe fallbacks,
// legacy-look invariants and WCAG AA contrast over accent x base x mode.
//
// The CSS under test is the real shipped CSS (tokens.css + generated
// appearance.css), parsed with a small selector matcher - jsdom cannot
// evaluate :not()/custom-property cascades reliably.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  ACCENTS,
  BASES,
  DEFAULT_ACCENT,
  DEFAULT_BASE,
  bootstrapAppearance,
  readStoredAccent,
  readStoredBase,
} from '@averrow/shared/theme';
import { bootstrapTheme } from '@averrow/shared/theme';

// ── tiny CSS engine ──────────────────────────────────────────────────

interface State { accent: string | null; base: string | null; theme: 'dark' | 'light' }
interface Rule { selector: string; decls: Array<[string, string]> }

/** Flat rule list. NOTE: @media / @container bodies are flattened - their
 *  inner rules are read as if unconditional (the outer `@media (...) {` is
 *  never part of a matched selector). No token rule under test lives in one. */
function parseRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '');
  const rules: Rule[] = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    if (selector.startsWith('@')) continue;
    const decls: Array<[string, string]> = [];
    for (const d of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) decls.push([d[1]!, d[2]!.trim()]);
    if (decls.length) rules.push({ selector, decls });
  }
  return rules;
}

function attrOf(state: State, name: string): string | null {
  if (name === 'data-accent') return state.accent;
  if (name === 'data-base') return state.base;
  if (name === 'data-theme') return state.theme;
  return null;
}

/** Match `:root`-level compound selectors made of [attr="v"] and :not([attr="v"]). */
function matches(selector: string, state: State): boolean {
  if (/\s/.test(selector)) return false; // descendant selectors (.shell-v4, .text-white/..) ignored
  let rest = selector;
  if (rest.startsWith(':root')) rest = rest.slice(5);
  if (rest === '') return true;
  const re = /^(:not\()?\[(data-[a-z]+)(?:="([^"]*)")?\]\)?/;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) return false;
    const val = attrOf(state, m[2]!);
    const eq = m[3] === undefined ? val !== null : val === m[3];
    if (m[1] ? eq : !eq) return false;
    rest = rest.slice(m[0].length);
  }
  return true;
}

// vitest runs with `css: false`, which empties `?raw` CSS imports - read from disk.
const themeDir = resolvePath(__dirname, '../../../shared/src/theme');
const tokensCss = readFileSync(resolvePath(themeDir, 'tokens.css'), 'utf8');
const appearanceCss = readFileSync(resolvePath(themeDir, 'appearance.css'), 'utf8');
const tokenRules = parseRules(tokensCss);
const appearanceRules = parseRules(appearanceCss);

/** Cascade the hex (non-oklch) declarations in source order; specificity is
 *  not needed because appearance rules are strictly more specific and only
 *  match when an accent is set - which the order below mirrors. */
function computed(state: State, includeAppearance = true): Map<string, string> {
  const out = new Map<string, string>();
  const apply = (rules: Rule[]) => {
    for (const r of rules) {
      for (const sel of r.selector.split(',').map((s) => s.trim())) {
        if (!matches(sel, state)) continue;
        for (const [k, v] of r.decls) if (!v.includes('oklch(')) out.set(k, v);
      }
    }
  };
  apply(tokenRules);
  if (includeAppearance) apply(appearanceRules);
  return out;
}

function resolve(map: Map<string, string>, name: string, depth = 0): string {
  let v = map.get(name);
  if (v === undefined) throw new Error(`token ${name} not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref && depth < 8) return resolve(map, ref[1]!, depth + 1);
  return v;
}

// ── colour math ──────────────────────────────────────────────────────

type RGBA = [number, number, number, number];

function parseColor(v: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgba) {
    const p = rgba[1]!.split(',').map((x) => parseFloat(x));
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  throw new Error(`unparseable colour: ${v}`);
}

function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function lum([r, g, b]: RGBA): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: RGBA, bg: RGBA): number {
  const l1 = lum(over(fg, bg));
  const l2 = lum(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** HSL hue in degrees, or null for a neutral: saturation < 0.15, or chroma
 *  (max - min channel) < 0.08 - HSL saturation explodes near white/black, so
 *  e.g. mono's #f4f5f7 primary reads 16% "saturated" with a 3/255 tint. */
function hueOf([r, g, b]: RGBA): number | null {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const M = Math.max(R, G, B), m = Math.min(R, G, B), d = M - m, l = (M + m) / 2;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.15 || d < 0.08) return null;
  const h = M === R ? ((G - B) / d + 6) % 6 : M === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return h * 60;
}
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ── storage / attributes ─────────────────────────────────────────────

const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  root().removeAttribute('data-accent');
  root().removeAttribute('data-base');
  root().removeAttribute('data-theme');
});

describe('defaults', () => {
  it('ships the legacy look (no accent, no base) until P3-6 flips it', () => {
    expect(DEFAULT_ACCENT).toBeNull();
    expect(DEFAULT_BASE).toBeNull();
  });

  it('sets no attribute when nothing is stored', () => {
    expect(bootstrapAppearance()).toEqual({ accent: null, base: null });
    expect(root().hasAttribute('data-accent')).toBe(false);
    expect(root().hasAttribute('data-base')).toBe(false);
  });
});

describe('storage round-trip', () => {
  it.each(ACCENTS)('accent %s is applied from storage', (a) => {
    localStorage.setItem('averrow-accent', a);
    expect(readStoredAccent()).toBe(a);
    bootstrapAppearance();
    expect(root().getAttribute('data-accent')).toBe(a);
  });

  it.each(BASES)('base %s is applied from storage', (b) => {
    localStorage.setItem('averrow-base', b);
    expect(readStoredBase()).toBe(b);
    bootstrapAppearance();
    expect(root().getAttribute('data-base')).toBe(b);
  });
});

describe('invalid values fall back safely', () => {
  it.each(['', 'INDIGO', 'amber', 'null', '<script>'])('accent %j', (bad) => {
    localStorage.setItem('averrow-accent', bad);
    expect(readStoredAccent()).toBe(DEFAULT_ACCENT);
    bootstrapAppearance();
    expect(root().hasAttribute('data-accent')).toBe(false);
  });

  it.each(['', 'Navy', 'black', 'dark'])('base %j', (bad) => {
    localStorage.setItem('averrow-base', bad);
    expect(readStoredBase()).toBe(DEFAULT_BASE);
    bootstrapAppearance();
    expect(root().hasAttribute('data-base')).toBe(false);
  });

  it('survives throwing storage', () => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    try {
      expect(readStoredAccent()).toBe(DEFAULT_ACCENT);
      expect(() => bootstrapAppearance()).not.toThrow();
    } finally {
      Storage.prototype.getItem = get;
    }
  });
});

describe('legacy averrow-theme values are unchanged', () => {
  it.each([['dark', 'dark'], ['light', 'light']] as const)('%s', (stored, resolved) => {
    localStorage.setItem('averrow-theme', stored);
    expect(bootstrapTheme()).toBe(stored);
    expect(root().getAttribute('data-theme')).toBe(resolved);
  });

  it('auto resolves to a concrete dark|light and invalid falls back to auto', () => {
    localStorage.setItem('averrow-theme', 'bogus');
    expect(bootstrapTheme()).toBe('auto');
    expect(['dark', 'light']).toContain(root().getAttribute('data-theme'));
  });

  it('appearance does not touch data-theme or its storage key', () => {
    localStorage.setItem('averrow-theme', 'light');
    localStorage.setItem('averrow-accent', 'lime');
    bootstrapTheme();
    bootstrapAppearance();
    expect(localStorage.getItem('averrow-theme')).toBe('light');
    expect(root().getAttribute('data-theme')).toBe('light');
  });
});

// ── token layering ───────────────────────────────────────────────────

describe('scoping', () => {
  it('every appearance selector requires [data-accent]', () => {
    for (const r of appearanceRules) {
      for (const sel of r.selector.split(',').map((s) => s.trim())) {
        expect(sel.startsWith(':root[data-accent'), sel).toBe(true);
      }
    }
  });

  it.each(['dark', 'light'] as const)('no accent => no appearance rule matches (%s)', (theme) => {
    const state: State = { accent: null, base: 'navy', theme };
    for (const r of appearanceRules) {
      for (const sel of r.selector.split(',').map((s) => s.trim())) {
        expect(matches(sel, state), sel).toBe(false);
      }
    }
  });
});

describe('legacy look: L2 tokens resolve to today\'s values', () => {
  const dark = computed({ accent: null, base: null, theme: 'dark' });
  const light = computed({ accent: null, base: null, theme: 'light' });

  it('dark', () => {
    expect(resolve(dark, '--primary')).toBe('#E5A832');
    expect(resolve(dark, '--primary-pressed')).toBe('#B8821F');
    expect(resolve(dark, '--primary-ink')).toBe('#0A0F1E');
    expect(resolve(dark, '--primary-text')).toBe('#E5A832');
    expect(resolve(dark, '--status-warn')).toBe('#fbbf24');
    expect(resolve(dark, '--healthy')).toBe('#3CB878');
    expect(resolve(dark, '--tag-nexus')).toBe('#A78BFA');
    expect(resolve(dark, '--focus-ring')).toBe('#E5A832');
  });

  it('light', () => {
    expect(resolve(light, '--primary')).toBe('#E5A832');
    expect(resolve(light, '--primary-ink')).toBe('#0A0F1E');
    expect(resolve(light, '--primary-text')).toBe('#8a5a00');
    expect(resolve(light, '--healthy')).toBe('#3CB878');
    expect(resolve(light, '--tag-nexus')).toBe('#6d28d9');
  });
});

describe('accent layers', () => {
  it('graphite is the dark default when data-base is absent; navy only when asked', () => {
    const none = computed({ accent: 'indigo', base: null, theme: 'dark' });
    const graphite = computed({ accent: 'indigo', base: 'graphite', theme: 'dark' });
    const navy = computed({ accent: 'indigo', base: 'navy', theme: 'dark' });
    expect(none.get('--bg-page')).toBe(graphite.get('--bg-page'));
    expect(navy.get('--bg-page')).not.toBe(graphite.get('--bg-page'));
  });

  it('an invalid base behaves as graphite', () => {
    const bad = computed({ accent: 'indigo', base: 'purple', theme: 'dark' });
    const graphite = computed({ accent: 'indigo', base: 'graphite', theme: 'dark' });
    expect(bad.get('--bg-page')).toBe(graphite.get('--bg-page'));
  });

  it('navy + light falls back to the light neutrals', () => {
    const navyLight = computed({ accent: 'indigo', base: 'navy', theme: 'light' });
    const light = computed({ accent: 'indigo', base: null, theme: 'light' });
    expect(navyLight.get('--bg-page')).toBe(light.get('--bg-page'));
    expect(navyLight.get('--bg-card')).toBe('#ffffff');
    expect(navyLight.get('--text-primary')).toBe(light.get('--text-primary'));
  });

  it.each(ACCENTS)('%s keeps --amber as the status amber', (accent) => {
    for (const theme of ['dark', 'light'] as const) {
      const c = computed({ accent, base: null, theme });
      expect(resolve(c, '--amber'), `${accent}/${theme}`).toBe('#E5A832');
    }
  });

  it('lime moves healthy to emerald; violet moves the NEXUS tag off violet', () => {
    const lime = computed({ accent: 'lime', base: null, theme: 'dark' });
    expect(resolve(lime, '--healthy')).toBe('#10b981');
    expect(resolve(lime, '--green')).toBe('#10b981');
    expect(resolve(lime, '--sev-info')).toBe('#10b981');
    const limeLight = computed({ accent: 'lime', base: null, theme: 'light' });
    expect(resolve(limeLight, '--healthy')).toBe('#047857');
    expect(resolve(limeLight, '--green')).toBe('#047857');
    expect(resolve(limeLight, '--sev-info')).toBe('#047857');
    const violetTag = resolve(computed({ accent: 'violet', base: null, theme: 'dark' }), '--tag-nexus');
    expect(violetTag).toBe('#f0abfc');
    expect(resolve(computed({ accent: 'violet', base: null, theme: 'light' }), '--tag-nexus')).toBe('#be185d');
    expect(resolve(computed({ accent: 'indigo', base: null, theme: 'dark' }), '--tag-nexus')).toBe('#c084fc');
    expect(resolve(computed({ accent: 'indigo', base: null, theme: 'light' }), '--tag-nexus')).toBe('#7e22ce');
  });

  it.each(ACCENTS)('%s defines every L2 token in every mode', (accent) => {
    const names = ['--primary', '--primary-hover', '--primary-pressed', '--primary-ink', '--primary-text',
      '--primary-tint', '--primary-tint-strong', '--primary-border', '--selection-bg', '--text-selection',
      '--disabled-bg', '--disabled-fg', '--disabled-border', '--link', '--link-hover', '--focus-ring-offset',
      '--focus-ring', '--status-warn', '--status-ok', '--status-bad', '--status-info', '--healthy', '--tag-nexus',
      '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-grid', '--chart-axis'];
    for (const [base, theme] of [['graphite', 'dark'], ['navy', 'dark'], [null, 'light']] as const) {
      const c = computed({ accent, base, theme });
      for (const n of names) expect(() => resolve(c, n), `${accent}/${base}/${theme} ${n}`).not.toThrow();
    }
  });
});

// ── WCAG AA contrast ─────────────────────────────────────────────────

const AA = 4.5;
const SURFACES = ['--bg-page', '--bg-card', '--bg-elevated'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const combos: Array<[string, 'graphite' | 'navy' | null, 'dark' | 'light']> = [];
for (const a of ACCENTS) {
  combos.push([a, 'graphite', 'dark'], [a, 'navy', 'dark'], [a, null, 'light']);
}

describe.each(combos)('contrast: %s / base=%s / %s', (accent, base, theme) => {
  const c = computed({ accent, base, theme });
  const col = (n: string) => parseColor(resolve(c, n));

  it.each(['--text-primary', '--text-secondary', '--text-tertiary', '--text-muted'])('%s on surfaces', (t) => {
    for (const s of SURFACES) {
      expect(contrast(col(t), col(s)), `${t} on ${s}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('--primary-ink on --primary (and hover/pressed)', () => {
    for (const fill of ['--primary', '--primary-hover', '--primary-pressed']) {
      expect(contrast(col('--primary-ink'), col(fill)), fill).toBeGreaterThanOrEqual(AA);
    }
  });

  it('--primary-text on --bg-card and --bg-page', () => {
    expect(contrast(col('--primary-text'), col('--bg-card'))).toBeGreaterThanOrEqual(AA);
    expect(contrast(col('--primary-text'), col('--bg-page'))).toBeGreaterThanOrEqual(AA);
  });

  it.each(SEVERITIES)('--sev-%s-text on its tint over --bg-card', (sev) => {
    const tint = over(col(`--sev-${sev}-bg`), col('--bg-card'));
    expect(contrast(col(`--sev-${sev}-text`), tint), sev).toBeGreaterThanOrEqual(AA);
  });

  it('--tag-nexus text on --bg-card', () => {
    expect(contrast(col('--tag-nexus'), col('--bg-card'))).toBeGreaterThanOrEqual(AA);
  });

  it('--healthy and --primary clear 3:1 as non-text on --bg-card', () => {
    expect(contrast(col('--healthy'), col('--bg-card'))).toBeGreaterThanOrEqual(3);
    expect(contrast(col('--primary'), col('--bg-card'))).toBeGreaterThanOrEqual(3);
  });
});


// ── review-fix invariants ────────────────────────────────────────────

describe('severity stays constant across accents (lime sev-info excepted)', () => {
  it.each(['dark', 'light'] as const)('%s', (theme) => {
    const ref = computed({ accent: 'indigo', base: null, theme });
    for (const accent of ACCENTS) {
      const c = computed({ accent, base: null, theme });
      for (const n of ['--sev-critical', '--sev-high', '--sev-medium', '--sev-low', '--sev-low-bg', '--sev-low-text']) {
        expect(c.get(n), `${accent} ${n}`).toBe(ref.get(n));
      }
      expect(c.get('--sev-low')).toBe('#60a5fa');
    }
  });

  it('--violet is one purple in every accent (not the palette pink, not legacy #8B7CF6)', () => {
    for (const accent of ACCENTS) {
      const dark = computed({ accent, base: null, theme: 'dark' });
      const light = computed({ accent, base: null, theme: 'light' });
      expect(resolve(dark, '--violet'), accent).toBe('#a855f7');
      expect(resolve(dark, '--violet-text'), accent).toBe('#d8b4fe');
      expect(resolve(light, '--violet'), accent).toBe('#a855f7');
      expect(resolve(light, '--violet-text'), accent).toBe('#7e22ce');
    }
  });

  it('legacy --violet is untouched', () => {
    expect(resolve(computed({ accent: null, base: null, theme: 'dark' }), '--violet')).toBe('#8B7CF6');
  });
});

describe('graphite separation', () => {
  it.each(ACCENTS)('%s graphite --border-base alpha is >= .11', (accent) => {
    const c = computed({ accent, base: 'graphite', theme: 'dark' });
    expect(parseColor(resolve(c, '--border-base'))[3]).toBeGreaterThanOrEqual(0.11);
  });
});

describe('::selection is only styled under [data-accent]', () => {
  it('appearance.css has the rule; tokens.css does not', () => {
    expect(appearanceCss).toMatch(/:root\[data-accent\] ::selection/);
    expect(tokensCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/::selection/);
  });
});

describe('legacy look: new L2 tokens', () => {
  it('resolve to today\'s amber values', () => {
    const d = computed({ accent: null, base: null, theme: 'dark' });
    expect(resolve(d, '--primary-border')).toBe('rgba(229, 168, 50, 0.38)');
    expect(resolve(d, '--primary-tint-strong')).toBe('rgba(229, 168, 50, 0.22)');
    expect(resolve(d, '--link')).toBe('#E5A832');
    expect(resolve(d, '--status-ok')).toBe('#3CB878');
    expect(resolve(d, '--status-bad')).toBe('#f87171');
    expect(resolve(d, '--status-info')).toBe('#60a5fa');
    expect(resolve(d, '--focus-ring-offset')).toBe('2px');
    expect(tokensCss).not.toMatch(/--primary-(hover|tint)[\w-]*:[^;]*color-mix/);
  });
});

describe('token-level contrast: new tokens', () => {
  describe.each(combos)('%s / %s / %s', (accent, base, theme) => {
    const c = computed({ accent, base, theme });
    const col = (n: string) => parseColor(resolve(c, n));

    it('--link and --link-hover on card/page >= 4.5', () => {
      for (const l of ['--link', '--link-hover']) {
        for (const s of ['--bg-card', '--bg-page']) {
          expect(contrast(col(l), col(s)), `${l} on ${s}`).toBeGreaterThanOrEqual(AA);
        }
      }
    });

    it('chart series >= 3:1 on --bg-card and distinct from each other', () => {
      const names = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6'];
      for (const n of names) {
        expect(contrast(col(n), col('--bg-card')), n).toBeGreaterThanOrEqual(3);
      }
      const hexes = names.map((n) => resolve(c, n));
      expect(new Set(hexes).size).toBe(names.length);
    });

    it('chart series never reuse amber or a severity value, and series 1 is not a neutral', () => {
      const banned = ['--amber', '--sev-critical', '--sev-high', '--sev-medium', '--sev-low', '--sev-info', '--healthy']
        .map((n) => resolve(c, n).toLowerCase());
      for (const n of ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5']) {
        expect(banned, n).not.toContain(resolve(c, n).toLowerCase());
      }
      expect(hueOf(col('--chart-1')), '--chart-1 must carry a hue').not.toBeNull();
    });

    it('--status-* text >= 4.5 on --bg-card', () => {
      for (const n of ['--status-warn', '--status-ok', '--status-bad', '--status-info']) {
        expect(contrast(col(n), col('--bg-card')), n).toBeGreaterThanOrEqual(AA);
      }
    });

    it('hover is distinguishable from the fill and pressed from hover (ratio >= 1.1), ink >= 4.5 on both; all hover aliases agree', () => {
      for (const [from, to] of [['--primary', '--primary-hover'], ['--primary-hover', '--primary-pressed']] as const) {
        const a = over(col(from), col('--bg-card'));
        const b = over(col(to), col('--bg-card'));
        const step = (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
        expect(step, `${from} ${resolve(c, from)} vs ${to} ${resolve(c, to)}`).toBeGreaterThanOrEqual(1.1);
        expect(contrast(col('--primary-ink'), b), `ink on ${to}`).toBeGreaterThanOrEqual(AA);
      }
      for (const alias of ['--btn-primary-bg-hover', '--accent-hover']) {
        expect(resolve(c, alias), alias).toBe(resolve(c, '--primary-hover'));
      }
    });

    it('--disabled-fg over --disabled-bg (informational; disabled is exempt)', () => {
      const card = col('--bg-card');
      const bg = over(col('--disabled-bg'), card);
      if (process.env.APPEARANCE_REPORT) {
        const min = Math.min(...[1, 2, 3, 4, 5, 6].map((i) => contrast(col(`--chart-${i}`), col('--bg-card'))));
        // eslint-disable-next-line no-console
        console.log(`REPORT ${accent}/${base}/${theme} disabled=${contrast(col('--disabled-fg'), bg).toFixed(2)} link=${contrast(col('--link'), col('--bg-card')).toFixed(2)} linkHover=${contrast(col('--link-hover'), col('--bg-card')).toFixed(2)} chartMin=${min.toFixed(2)} ink/hover=${contrast(col('--primary-ink'), col('--primary-hover')).toFixed(2)} hover=${resolve(c, '--primary-hover')} primary=${resolve(c, '--primary')}`);
      }
      expect(contrast(col('--disabled-fg'), bg)).toBeGreaterThanOrEqual(1.5);
    });
  });
});

// Every chromatic chart series keeps >= 25deg HSL hue from every
// status/severity/healthy/green/amber/primary/--violet/--tag-nexus colour of
// the same combo and from every other chromatic series. Neutral series
// (chart-6) are skipped. Series 1, when it follows --primary-text, is a
// primary colour by design: it is compared with the other series only.
// Legacy (no accent) dark/light are included.
const HUE_MIN = 25;
const hueCombos: Array<[string | null, 'graphite' | 'navy' | null, 'dark' | 'light']> =
  [[null, null, 'dark'], [null, null, 'light'], ...combos];
describe.each(hueCombos)('chart hue separation: %s / %s / %s', (accent, base, theme) => {
  const c = computed({ accent, base, theme });
  const hue = (n: string) => hueOf(over(parseColor(resolve(c, n)), parseColor(resolve(c, '--bg-card'))));
  const SERIES = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6'];
  const OTHERS = ['--amber', '--sev-critical', '--sev-high', '--sev-medium', '--sev-low', '--sev-info',
    '--status-warn', '--status-ok', '--status-bad', '--status-info', '--healthy', '--green',
    '--primary', '--primary-text', '--violet', '--tag-nexus'];
  const chromatic = SERIES.filter((n) => hue(n) !== null);
  const followsPrimary = (n: string) => n === '--chart-1' && c.get('--chart-1') === 'var(--primary-text)';

  it('chart-1..5 are chromatic (only chart-6 is a neutral)', () => {
    for (const n of SERIES.slice(0, 5)) expect(chromatic, n).toContain(n);
  });

  it(`chromatic series are >= ${HUE_MIN}deg from each other`, () => {
    for (const [i, a] of chromatic.entries()) {
      for (const b of chromatic.slice(i + 1)) {
        expect(hueDist(hue(a)!, hue(b)!), `${a} ${resolve(c, a)} vs ${b} ${resolve(c, b)}`).toBeGreaterThanOrEqual(HUE_MIN);
      }
    }
  });

  it(`chromatic series are >= ${HUE_MIN}deg from status, severity, healthy, green, amber, primary, --violet, --tag-nexus`, () => {
    for (const n of chromatic) {
      if (followsPrimary(n)) continue;
      for (const o of OTHERS) {
        const ho = hue(o);
        if (ho === null) continue; // a neutral (e.g. mono primary) separates by hue
        expect(hueDist(hue(n)!, ho), `${n} ${resolve(c, n)} vs ${o} ${resolve(c, o)}`).toBeGreaterThanOrEqual(HUE_MIN);
      }
    }
  });
});

describe.each(['dark', 'light'] as const)('legacy look (%s): --status-* readable on --bg-card', (theme) => {
  const c = computed({ accent: null, base: null, theme });
  const col = (n: string) => parseColor(resolve(c, n));
  it.each(['--status-warn', '--status-ok', '--status-bad', '--status-info'])('%s >= 4.5', (n) => {
    expect(contrast(col(n), col('--bg-card'))).toBeGreaterThanOrEqual(AA);
  });
});

describe('lime light accent-as-text is clearly not the healthy green', () => {
  const c = computed({ accent: 'lime', base: null, theme: 'light' });
  const col = (n: string) => parseColor(resolve(c, n));
  it('--primary-text / --link is the near-black olive, >= 4.5 on card and page', () => {
    expect(resolve(c, '--primary-text')).toBe('#2a3a12');
    expect(resolve(c, '--link')).toBe('#2a3a12');
    for (const s of ['--bg-card', '--bg-page']) {
      expect(contrast(col('--link'), col(s)), s).toBeGreaterThanOrEqual(AA);
    }
    // >= 25deg away from healthy and far darker (healthy #047857 is a mid-tone).
    expect(hueDist(hueOf(col('--link'))!, hueOf(col('--healthy'))!)).toBeGreaterThanOrEqual(25);
    expect(lum(col('--healthy')) / lum(col('--link'))).toBeGreaterThan(2.5);
  });
});

// ── shell-v4 re-emission ─────────────────────────────────────────────

describe('appearance.css re-emits every shell-v4 token override it also sets', () => {
  const shellCss = readFileSync(resolvePath(__dirname, '../components/layout/shell-v4.css'), 'utf8');
  const shellRules = parseRules(shellCss);
  const allMode = shellRules.filter((r) => r.selector === '.shell-v4').flatMap((r) => r.decls.map(([k]) => k));
  const darkOnly = shellRules
    .filter((r) => r.selector.replace(/\s+/g, ' ') === ':root:not([data-theme="light"]) .shell-v4')
    .flatMap((r) => r.decls.map(([k]) => k));

  it('shell-v4.css still declares the tokens this test expects to find', () => {
    expect(allMode).toContain('--sev-critical-glow');
    expect(darkOnly).toContain('--bg-card');
  });

  const shellSel = (accent: string, base: string | null, theme: 'dark' | 'light') => {
    const a = `:root[data-accent="${accent}"]`;
    if (theme === 'light') return `${a}[data-theme="light"] .shell-v4`;
    return `${a}${base === 'navy' ? '[data-base="navy"]' : ':not([data-base="navy"])'}:not([data-theme="light"]) .shell-v4`;
  };

  it.each(combos)('%s / %s / %s', (accent, base, theme) => {
    const state: State = { accent, base, theme };
    const set = computed(state);
    // tokens the appearance layer itself sets for this combo
    const accentSets = new Set<string>();
    for (const r of appearanceRules) {
      for (const sel of r.selector.split(',').map((x) => x.trim())) {
        if (matches(sel, state)) for (const [k] of r.decls) accentSets.add(k);
      }
    }
    const shellRule = appearanceRules.find((r) => r.selector === shellSel(accent, base, theme));
    const emitted = new Map(shellRule?.decls ?? []);
    const expected = [...allMode, ...(theme === 'dark' ? darkOnly : [])].filter((k) => accentSets.has(k));
    expect(expected.length).toBeGreaterThan(0);
    for (const k of expected) {
      expect(emitted.has(k), `${shellSel(accent, base, theme)} missing ${k}`).toBe(true);
      // same colour as the accent value; alpha may be the shell's boost, never lower
      const want = parseColor(resolve(set, k)), got = parseColor(emitted.get(k)!);
      expect(got.slice(0, 3), k).toEqual(want.slice(0, 3));
      expect(got[3], k).toBeGreaterThanOrEqual(want[3]);
    }
  });
});

describe('P3-2b review aliases: --primary-as-text / --primary-focus / --metric-accent', () => {
  const ALIASES = ['--primary-as-text', '--primary-focus', '--metric-accent'] as const;

  it.each(['dark', 'light'] as const)('legacy %s: every alias resolves to --amber (pixel-identical)', (theme) => {
    const c = computed({ accent: null, base: null, theme });
    for (const n of ALIASES) expect(resolve(c, n), n).toBe(resolve(c, '--amber'));
  });

  describe.each(combos)('%s / %s / %s', (accent, base, theme) => {
    const c = computed({ accent, base, theme });
    const col = (n: string) => parseColor(resolve(c, n));

    it('--primary-as-text on --bg-card >= 4.5 (AA small text)', () => {
      expect(contrast(col('--primary-as-text'), col('--bg-card'))).toBeGreaterThanOrEqual(AA);
    });

    it('--primary-focus is --focus-ring and --metric-accent is --text-tertiary', () => {
      expect(resolve(c, '--primary-focus')).toBe(resolve(c, '--focus-ring'));
      expect(resolve(c, '--metric-accent')).toBe(resolve(c, '--text-tertiary'));
    });
  });
});
