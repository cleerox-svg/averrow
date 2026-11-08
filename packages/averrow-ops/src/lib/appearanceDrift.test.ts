// @vitest-environment jsdom
//
// Appearance system (P3-1, P3-6a): generator drift, the generated index.html
// (FACELIFT switch: inline no-flash bootstrap, theme-color, Google Fonts, Geist
// preloads, PWA manifest) and useAppearance hook behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { useAppearance, ACCENTS, BASES, DEFAULT_ACCENT, DEFAULT_BASE, FACELIFT, appearanceFlags } from '@averrow/shared/theme';
import { FACELIFT_THEME_COLOR, LEGACY_THEME_COLOR } from '../../../shared/src/theme/appearanceDefaults';
import {
  transformAppearanceHtml, fontPreloadTags, transformManifest, GOOGLE_FONTS_LINES, PRELOADED_FONTS, BODY_SWAPS,
} from '../../../shared/scripts/appearance-html';

const REPO = resolve(__dirname, '../../../..');

// ── 1. generator drift ──────────────────────────────────────────────

describe('appearance.css generator drift', () => {
  it('committed appearance.css equals a fresh run of gen-appearance.mjs', () => {
    // The script resolves its root from its own location, so mirror the
    // tree it reads/writes into a temp dir and run an unmodified copy.
    const tmp = mkdtempSync(join(tmpdir(), 'gen-appearance-'));
    try {
      mkdirSync(join(tmp, 'packages/shared/scripts'), { recursive: true });
      mkdirSync(join(tmp, 'packages/shared/src/theme'), { recursive: true });
      cpSync(join(REPO, 'packages/shared/scripts/gen-appearance.mjs'), join(tmp, 'packages/shared/scripts/gen-appearance.mjs'));
      cpSync(join(REPO, 'docs/brand/palettes'), join(tmp, 'docs/brand/palettes'), { recursive: true });
      // The generator reads shell-v4.css to find the tokens the v4 shell redeclares.
      const shell = 'packages/averrow-ops/src/components/layout/shell-v4.css';
      mkdirSync(join(tmp, 'packages/averrow-ops/src/components/layout'), { recursive: true });
      cpSync(join(REPO, shell), join(tmp, shell));
      execFileSync(process.execPath, [join(tmp, 'packages/shared/scripts/gen-appearance.mjs')], { stdio: 'pipe' });
      const fresh = readFileSync(join(tmp, 'packages/shared/src/theme/appearance.css'), 'utf8');
      const committed = readFileSync(join(REPO, 'packages/shared/src/theme/appearance.css'), 'utf8');
      expect(fresh.length).toBeGreaterThan(1000);
      expect(committed === fresh, 'appearance.css is stale: run node packages/shared/scripts/gen-appearance.mjs').toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 2. generated index.html (appearance-html plugin) + inline bootstrap ──
//
// Both apps' index.html carry __APPEARANCE_*__ markers that the shared Vite
// plugin fills from the FACELIFT switch. These tests run the plugin's
// transform on the committed sources for BOTH values of the switch, then
// execute the generated inline bootstrap.

const LEGACY_BOOTSTRAP_LINE =
  "var ACCENTS = ['indigo', 'violet', 'mono', 'lime'], BASES = ['graphite', 'navy'], DEFAULT_ACCENT = null, DEFAULT_BASE = null;";

function sourceHtml(pkg: string): string {
  return readFileSync(join(REPO, 'packages', pkg, 'index.html'), 'utf8');
}

function generatedHtml(pkg: string, facelift: boolean): string {
  return transformAppearanceHtml(sourceHtml(pkg), facelift);
}

function inlineScript(pkg: string, facelift: boolean): string {
  const scripts = [...generatedHtml(pkg, facelift).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(scripts).toHaveLength(1);
  return scripts[0]!;
}

type Store = Record<string, string>;

function runBootstrap(script: string, opts: { store?: Store; throwing?: boolean; prefersLight?: boolean | 'nomatchMedia' } = {}) {
  const { store = {}, throwing = false, prefersLight = false } = opts;
  const ls = throwing
    ? { getItem: () => { throw new Error('blocked'); } }
    : { getItem: (k: string) => (k in store ? store[k]! : null) };
  const fakeWindow = {
    localStorage: ls,
    matchMedia: prefersLight === 'nomatchMedia'
      ? undefined
      : (q: string) => ({ matches: q.includes('light') ? prefersLight : !prefersLight }),
  };
  const el = document.documentElement;
  ['data-theme', 'data-accent', 'data-base'].forEach((a) => el.removeAttribute(a));
  // Run with `window` shadowed by the fake; `document` is the real jsdom one.
  new Function('window', script)(fakeWindow);
  return {
    theme: el.getAttribute('data-theme'),
    accent: el.getAttribute('data-accent'),
    base: el.getAttribute('data-base'),
  };
}

const PKGS = ['averrow-ops', 'averrow-tenant'] as const;
const CASES = PKGS.flatMap((pkg) => [false, true].map((facelift) => [pkg, facelift] as const));

describe.each(CASES)('inline bootstrap (%s, FACELIFT=%s)', (pkg, facelift) => {
  const script = inlineScript(pkg, facelift);
  const { defaultAccent: dA, defaultBase: dB } = appearanceFlags(facelift);

  it('empty storage, dark OS: dark theme, the default accent/base (none when off)', () => {
    expect(runBootstrap(script)).toEqual({ theme: 'dark', accent: dA, base: dB });
  });
  it('empty storage, light OS: light theme', () => {
    expect(runBootstrap(script, { prefersLight: true }).theme).toBe('light');
  });
  it('no matchMedia: falls back to dark', () => {
    expect(runBootstrap(script, { prefersLight: 'nomatchMedia' }).theme).toBe('dark');
  });
  it('valid accent + base are applied', () => {
    expect(runBootstrap(script, { store: { 'averrow-theme': 'dark', 'averrow-accent': 'lime', 'averrow-base': 'navy' } }))
      .toEqual({ theme: 'dark', accent: 'lime', base: 'navy' });
  });
  it.each(['indigo', 'violet', 'mono', 'lime'])('accent %s accepted', (a) => {
    expect(runBootstrap(script, { store: { 'averrow-accent': a } }).accent).toBe(a);
  });
  it('explicit light/dark theme wins over OS preference', () => {
    expect(runBootstrap(script, { store: { 'averrow-theme': 'light' }, prefersLight: false }).theme).toBe('light');
    expect(runBootstrap(script, { store: { 'averrow-theme': 'dark' }, prefersLight: true }).theme).toBe('dark');
  });
  it('averrow-theme=auto follows prefers-color-scheme', () => {
    expect(runBootstrap(script, { store: { 'averrow-theme': 'auto' }, prefersLight: false }).theme).toBe('dark');
    expect(runBootstrap(script, { store: { 'averrow-theme': 'auto' }, prefersLight: true }).theme).toBe('light');
  });
  it('invalid accent/base/theme values fall back to the defaults', () => {
    expect(runBootstrap(script, { store: { 'averrow-theme': 'purple', 'averrow-accent': 'Indigo', 'averrow-base': 'black' } }))
      .toEqual({ theme: 'dark', accent: dA, base: dB });
    expect(runBootstrap(script, { store: { 'averrow-accent': '"><x', 'averrow-base': '' } }))
      .toEqual({ theme: 'dark', accent: dA, base: dB });
    // A stored "legacy" is not a choice: there is no legacy accent value.
    expect(runBootstrap(script, { store: { 'averrow-accent': 'legacy' } }).accent).toBe(dA);
  });
  it('invalid accent does not block a valid base', () => {
    expect(runBootstrap(script, { store: { 'averrow-accent': 'nope', 'averrow-base': 'navy' } }))
      .toEqual({ theme: 'dark', accent: dA, base: 'navy' });
  });
  it('storage throwing: does not throw; theme still follows the OS, default accent/base', () => {
    let out!: ReturnType<typeof runBootstrap>;
    expect(() => { out = runBootstrap(script, { throwing: true }); }).not.toThrow();
    expect(out).toEqual({ theme: 'dark', accent: dA, base: dB });
    expect(runBootstrap(script, { throwing: true, prefersLight: true }).theme).toBe('light');
  });
  it('generated literals equal ACCENTS / BASES and the derived defaults', () => {
    const m = /var ACCENTS = (\[[^\]]*\]), BASES = (\[[^\]]*\]), DEFAULT_ACCENT = ([^,]+), DEFAULT_BASE = ([^;]+);/.exec(script);
    expect(m, 'inline literal line not found').not.toBeNull();
    const j = (x: string) => JSON.parse(x.trim().replace(/'/g, '"')) as unknown;
    expect(j(m![1]!)).toEqual([...ACCENTS]);
    expect(j(m![2]!)).toEqual([...BASES]);
    expect(j(m![3]!)).toBe(dA);
    expect(j(m![4]!)).toBe(dB);
  });
  it('no marker is left in the generated page', () => {
    expect(generatedHtml(pkg, facelift)).not.toMatch(/__APPEARANCE_[A-Z_]+__/);
  });
  it('theme-color follows the switch', () => {
    const html = generatedHtml(pkg, facelift);
    expect(html).toContain(`<meta name="theme-color" content="${facelift ? FACELIFT_THEME_COLOR : LEGACY_THEME_COLOR}" />`);
  });
  it('Google Fonts block: kept when off, dropped (whole lines) when on', () => {
    const html = generatedHtml(pkg, facelift);
    for (const line of GOOGLE_FONTS_LINES) expect(html.includes(line)).toBe(!facelift);
    expect(/fonts\.(googleapis|gstatic)\.com/.test(html)).toBe(!facelift);
    if (facelift) {
      // Only the three lines went: everything else is the off-state page.
      const off = generatedHtml(pkg, false).split('\n');
      const on = html.split('\n');
      expect(off.length - on.length).toBe(GOOGLE_FONTS_LINES.length);
    }
  });
});

describe('generated index.html, FACELIFT=false is today\'s page', () => {
  it.each(PKGS)('%s: legacy bootstrap line, theme-color and Google Fonts unchanged', (pkg) => {
    const html = generatedHtml(pkg, false);
    expect(html).toContain(LEGACY_BOOTSTRAP_LINE);
    expect(html).toContain('<meta name="theme-color" content="#060A14" />');
    for (const line of GOOGLE_FONTS_LINES) expect(html).toContain(line);
    // Apart from the markers, the source is passed through untouched.
    const src = sourceHtml(pkg);
    const filled = src
      .replace('__APPEARANCE_ACCENTS__', "['indigo', 'violet', 'mono', 'lime']")
      .replace('__APPEARANCE_BASES__', "['graphite', 'navy']")
      .replace('__APPEARANCE_DEFAULT_ACCENT__', 'null')
      .replace('__APPEARANCE_DEFAULT_BASE__', 'null')
      .replace('__APPEARANCE_THEME_COLOR__', '#060A14');
    expect(html).toBe(filled);
  });
  it('the plugin default follows the committed FACELIFT', () => {
    for (const pkg of PKGS) expect(transformAppearanceHtml(sourceHtml(pkg))).toBe(generatedHtml(pkg, FACELIFT));
  });
});

describe('inline bootstrap drift', () => {
  it.each([false, true])('ops and tenant inline scripts are byte-identical (FACELIFT=%s)', (facelift) => {
    expect(inlineScript('averrow-tenant', facelift)).toBe(inlineScript('averrow-ops', facelift));
  });
});

describe('appearance-html plugin helpers', () => {
  it('a missing or duplicated marker fails the build', () => {
    const src = sourceHtml('averrow-ops');
    expect(() => transformAppearanceHtml(src.replace('__APPEARANCE_THEME_COLOR__', '#000'), false)).toThrow(/THEME_COLOR/);
    expect(() => transformAppearanceHtml(`${src}<!-- __APPEARANCE_BASES__ -->`, false)).toThrow(/BASES/);
    expect(() => transformAppearanceHtml(src.replace(GOOGLE_FONTS_LINES[2], ''), true)).toThrow(/Google Fonts/);
  });

  it('theme colours match the stylesheets', () => {
    const tokens = readFileSync(join(REPO, 'packages/shared/src/theme/tokens.css'), 'utf8');
    expect(/:root\s*\{[^}]*--bg-page:\s*([^;]+);/.exec(tokens)?.[1]?.trim()).toBe(LEGACY_THEME_COLOR);
    const css = readFileSync(join(REPO, 'packages/shared/src/theme/appearance.css'), 'utf8');
    const graphite = /:root\[data-accent="indigo"\]:not\(\[data-base="navy"\]\):not\(\[data-theme="light"\]\) \{[^}]*--bg-page:\s*([^;]+);/.exec(css);
    expect(graphite?.[1]?.trim().toLowerCase()).toBe(FACELIFT_THEME_COLOR);
    expect(appearanceFlags(true)).toMatchObject({ defaultAccent: 'indigo', defaultBase: 'graphite' });
  });

  const bundle = {
    'assets/geist-sans-latin-var-AAAA.woff2': { type: 'asset', fileName: 'assets/geist-sans-latin-var-AAAA.woff2', names: ['geist-sans-latin-var.woff2'], originalFileNames: ['../shared/src/theme/fonts/geist-sans-latin-var.woff2'] },
    'assets/geist-sans-latin-italic-var-BBBB.woff2': { type: 'asset', fileName: 'assets/geist-sans-latin-italic-var-BBBB.woff2', names: ['geist-sans-latin-italic-var.woff2'] },
    'assets/geist-mono-latin-var-CCCC.woff2': { type: 'asset', fileName: 'assets/geist-mono-latin-var-CCCC.woff2', names: ['geist-mono-latin-var.woff2'] },
    'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', name: 'geist-sans-latin-var.woff2' },
  };

  it('font preloads: none when off; upright sans + mono, base-prefixed, when on', () => {
    expect(fontPreloadTags(bundle, '/v2/', false)).toEqual([]);
    const tags = fontPreloadTags(bundle, '/v2/', true);
    expect(tags.map((t) => t.attrs.href)).toEqual([
      '/v2/assets/geist-sans-latin-var-AAAA.woff2',
      '/v2/assets/geist-mono-latin-var-CCCC.woff2',
    ]);
    for (const t of tags) {
      expect(t).toMatchObject({ tag: 'link', injectTo: 'head', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: true } });
    }
    expect(fontPreloadTags(bundle, '/tenant', true)[0]!.attrs.href).toBe('/tenant/assets/geist-sans-latin-var-AAAA.woff2');
    expect(PRELOADED_FONTS).toEqual(['geist-sans-latin-var.woff2', 'geist-mono-latin-var.woff2']);
  });

  it('font preloads: a font missing from the bundle fails the build', () => {
    const { ['assets/geist-mono-latin-var-CCCC.woff2']: _gone, ...rest } = bundle;
    expect(() => fontPreloadTags(rest, '/v2/', true)).toThrow(/geist-mono-latin-var/);
    expect(() => fontPreloadTags(rest, '/v2/', false)).not.toThrow();
  });

  it('preloaded fonts exist in the shared theme', () => {
    for (const f of PRELOADED_FONTS) expect(readFileSync(join(REPO, 'packages/shared/src/theme/fonts', f)).length).toBeGreaterThan(1000);
  });

  it('ops body: legacy bg-cockpit when off, the page token when on; tenant untouched', () => {
    const [from, to] = BODY_SWAPS[0]!;
    expect(sourceHtml('averrow-ops')).toContain(from);
    expect(generatedHtml('averrow-ops', false)).toContain(from);
    const on = generatedHtml('averrow-ops', true);
    expect(on).not.toContain('bg-cockpit');
    expect(on).toContain(to);
    expect(to).toContain('var(--bg-page');
    expect(generatedHtml('averrow-tenant', true)).toContain('<body class="bg-bg-page text-white antialiased">');
  });

  it('manifest rewrite fails loudly when a colour key is missing', () => {
    expect(() => transformManifest('{"name":"x","theme_color":"#000"}', true)).toThrow(/background_color/);
    expect(() => transformManifest('{"name":"x","background_color":"#000"}', true)).toThrow(/theme_color/);
    expect(transformManifest('{"name":"x"}', false)).toBe('{"name":"x"}');
  });

  it('PWA manifest colours: untouched when off, the facelift page colour when on', () => {
    const json = readFileSync(join(REPO, 'packages/averrow-ops/public/manifest.json'), 'utf8');
    expect(transformManifest(json, false)).toBe(json);
    const on = JSON.parse(transformManifest(json, true)) as { theme_color: string; background_color: string };
    expect(on.theme_color).toBe(FACELIFT_THEME_COLOR);
    expect(on.background_color).toBe(FACELIFT_THEME_COLOR);
    const rest = (x: Record<string, unknown>) => { const { theme_color: _t, background_color: _b, ...r } = x; return r; };
    expect(rest(on)).toEqual(rest(JSON.parse(json) as Record<string, unknown>));
  });
});

// ── 3. useAppearance hook ───────────────────────────────────────────

describe('useAppearance', () => {
  const html = document.documentElement;
  beforeEach(() => {
    localStorage.clear();
    html.removeAttribute('data-accent');
    html.removeAttribute('data-base');
  });
  afterEach(() => vi.restoreAllMocks());

  it('defaults are indigo / graphite (FACELIFT on): initial state, storage untouched', () => {
    expect(FACELIFT).toBe(true);
    expect(DEFAULT_ACCENT).toBe('indigo');
    expect(DEFAULT_BASE).toBe('graphite');
    const { result } = renderHook(() => useAppearance());
    expect(result.current.accent).toBe('indigo');
    expect(result.current.base).toBe('graphite');
    expect(localStorage.getItem('averrow-accent')).toBeNull();
    expect(localStorage.getItem('averrow-base')).toBeNull();
  });

  it('initialises from valid storage; invalid falls back to the default', () => {
    localStorage.setItem('averrow-accent', 'violet');
    localStorage.setItem('averrow-base', 'bogus');
    const { result } = renderHook(() => useAppearance());
    expect(result.current.accent).toBe('violet');
    expect(result.current.base).toBe('graphite');
  });

  it('setAccent / setBase write attribute, storage and state', () => {
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.setAccent('lime'));
    act(() => result.current.setBase('navy'));
    expect(html.getAttribute('data-accent')).toBe('lime');
    expect(html.getAttribute('data-base')).toBe('navy');
    expect(localStorage.getItem('averrow-accent')).toBe('lime');
    expect(localStorage.getItem('averrow-base')).toBe('navy');
    expect(result.current.accent).toBe('lime');
    expect(result.current.base).toBe('navy');
  });

  it('setAccent(null) / setBase(null) return to the defaults and clear storage', () => {
    const { result } = renderHook(() => useAppearance());
    act(() => { result.current.setAccent('mono'); result.current.setBase('navy'); });
    act(() => { result.current.setAccent(null); result.current.setBase(null); });
    expect(html.getAttribute('data-accent')).toBe('indigo');
    expect(html.getAttribute('data-base')).toBe('graphite');
    // storage is cleared so a later default change is followed
    expect(localStorage.getItem('averrow-accent')).toBeNull();
    expect(localStorage.getItem('averrow-base')).toBeNull();
    expect(result.current.accent).toBe('indigo');
    expect(result.current.base).toBe('graphite');
  });

  it('simulated revert (FACELIFT=false): null defaults mean the legacy look, no attributes', async () => {
    vi.resetModules();
    vi.doMock('../../../shared/src/theme/appearanceDefaults', async (orig) => ({
      ...(await orig<typeof import('../../../shared/src/theme/appearanceDefaults')>()),
      FACELIFT: false,
      DEFAULT_ACCENT: null,
      DEFAULT_BASE: null,
      APPEARANCE_PICKER_ENABLED: false,
    }));
    // Unmount explicitly (also on failure) so the hook from the re-imported
    // module graph never outlives this test.
    let unmount: (() => void) | undefined;
    try {
      // Fresh React + testing-library alongside the re-imported hook (same module graph).
      const rtl = await import('@testing-library/react');
      const theme = await import('../../../shared/src/theme/useAppearance');
      expect(theme.DEFAULT_ACCENT).toBeNull();
      const hook = rtl.renderHook(() => theme.useAppearance());
      unmount = hook.unmount;
      const { result } = hook;
      expect(result.current.accent).toBeNull();
      expect(result.current.base).toBeNull();
      rtl.act(() => { result.current.setAccent('lime'); result.current.setBase('navy'); });
      expect(html.getAttribute('data-accent')).toBe('lime');
      rtl.act(() => { result.current.setAccent(null); result.current.setBase(null); });
      expect(html.hasAttribute('data-accent')).toBe(false);
      expect(html.hasAttribute('data-base')).toBe(false);
      expect(result.current.accent).toBeNull();
      expect(result.current.base).toBeNull();
      expect(localStorage.getItem('averrow-accent')).toBeNull();
      expect(localStorage.getItem('averrow-base')).toBeNull();
      rtl.act(() => result.current.setAccent('nope' as never));
      expect(html.hasAttribute('data-accent')).toBe(false);
    } finally {
      unmount?.();
      vi.doUnmock('../../../shared/src/theme/appearanceDefaults');
      vi.resetModules();
    }
  });

  it('an invalid value passed at runtime is treated as null (the default)', () => {
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.setAccent('violet'));
    act(() => result.current.setAccent('nope' as never));
    expect(html.getAttribute('data-accent')).toBe('indigo');
    expect(localStorage.getItem('averrow-accent')).toBeNull();
    expect(result.current.accent).toBe('indigo');
  });

  it('storage write failure still applies attribute and state', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const { result } = renderHook(() => useAppearance());
    expect(() => act(() => result.current.setAccent('violet'))).not.toThrow();
    expect(html.getAttribute('data-accent')).toBe('violet');
    expect(result.current.accent).toBe('violet');
  });
});
