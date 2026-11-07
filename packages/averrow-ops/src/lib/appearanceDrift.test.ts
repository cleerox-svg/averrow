// @vitest-environment jsdom
//
// Appearance system (P3-1): generator drift, inline no-flash bootstrap, and
// useAppearance hook behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { useAppearance, ACCENTS, BASES, DEFAULT_ACCENT, DEFAULT_BASE } from '@averrow/shared/theme';

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

// ── 2. inline no-flash bootstrap ────────────────────────────────────

function inlineScript(pkg: string): string {
  const html = readFileSync(join(REPO, 'packages', pkg, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
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

describe.each(['averrow-ops', 'averrow-tenant'])('inline bootstrap (%s)', (pkg) => {
  const script = inlineScript(pkg);

  it('empty storage, dark OS: dark theme, no accent/base attributes', () => {
    expect(runBootstrap(script)).toEqual({ theme: 'dark', accent: null, base: null });
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
  it('invalid accent/base/theme values are ignored', () => {
    expect(runBootstrap(script, { store: { 'averrow-theme': 'purple', 'averrow-accent': 'Indigo', 'averrow-base': 'black' } }))
      .toEqual({ theme: 'dark', accent: null, base: null });
    expect(runBootstrap(script, { store: { 'averrow-accent': '"><x', 'averrow-base': '' } }))
      .toEqual({ theme: 'dark', accent: null, base: null });
  });
  it('invalid accent does not block a valid base', () => {
    expect(runBootstrap(script, { store: { 'averrow-accent': 'nope', 'averrow-base': 'graphite' } }).base).toBe('graphite');
  });
  it('storage throwing: does not throw; theme still follows the OS, no accent/base', () => {
    let out!: ReturnType<typeof runBootstrap>;
    expect(() => { out = runBootstrap(script, { throwing: true }); }).not.toThrow();
    expect(out).toEqual({ theme: 'dark', accent: null, base: null });
    expect(runBootstrap(script, { throwing: true, prefersLight: true }).theme).toBe('light');
  });
  it('literals equal ACCENTS / BASES / DEFAULT_ACCENT / DEFAULT_BASE from useAppearance.ts', () => {
    const m = /var ACCENTS = (\[[^\]]*\]), BASES = (\[[^\]]*\]), DEFAULT_ACCENT = ([^,]+), DEFAULT_BASE = ([^;]+);/.exec(script);
    expect(m, 'inline literal line not found').not.toBeNull();
    const j = (x: string) => JSON.parse(x.trim().replace(/'/g, '"')) as unknown;
    expect(j(m![1]!)).toEqual([...ACCENTS]);
    expect(j(m![2]!)).toEqual([...BASES]);
    expect(j(m![3]!)).toBe(DEFAULT_ACCENT);
    expect(j(m![4]!)).toBe(DEFAULT_BASE);
  });
  it('applies DEFAULT_ACCENT / DEFAULT_BASE when nothing valid is stored (simulated flip)', () => {
    const flipped = script
      .replace('DEFAULT_ACCENT = null', "DEFAULT_ACCENT = 'indigo'")
      .replace('DEFAULT_BASE = null', "DEFAULT_BASE = 'graphite'");
    expect(runBootstrap(flipped)).toEqual({ theme: 'dark', accent: 'indigo', base: 'graphite' });
    expect(runBootstrap(flipped, { store: { 'averrow-accent': 'junk', 'averrow-base': 'junk' } }))
      .toEqual({ theme: 'dark', accent: 'indigo', base: 'graphite' });
    expect(runBootstrap(flipped, { store: { 'averrow-accent': 'lime', 'averrow-base': 'navy' } }))
      .toEqual({ theme: 'dark', accent: 'lime', base: 'navy' });
    expect(runBootstrap(flipped, { throwing: true })).toEqual({ theme: 'dark', accent: 'indigo', base: 'graphite' });
  });
});

describe('inline bootstrap drift', () => {
  it('ops and tenant inline scripts are byte-identical', () => {
    expect(inlineScript('averrow-tenant')).toBe(inlineScript('averrow-ops'));
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

  it('defaults are null: initial render sets no attributes', () => {
    expect(DEFAULT_ACCENT).toBeNull();
    expect(DEFAULT_BASE).toBeNull();
    const { result } = renderHook(() => useAppearance());
    expect(result.current.accent).toBeNull();
    expect(result.current.base).toBeNull();
    expect(html.hasAttribute('data-accent')).toBe(false);
    expect(html.hasAttribute('data-base')).toBe(false);
  });

  it('initialises from valid storage, ignores invalid', () => {
    localStorage.setItem('averrow-accent', 'violet');
    localStorage.setItem('averrow-base', 'bogus');
    const { result } = renderHook(() => useAppearance());
    expect(result.current.accent).toBe('violet');
    expect(result.current.base).toBeNull();
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

  it('setAccent(null) / setBase(null) clear attribute and storage', () => {
    const { result } = renderHook(() => useAppearance());
    act(() => { result.current.setAccent('mono'); result.current.setBase('graphite'); });
    act(() => { result.current.setAccent(null); result.current.setBase(null); });
    expect(html.hasAttribute('data-accent')).toBe(false);
    expect(html.hasAttribute('data-base')).toBe(false);
    expect(localStorage.getItem('averrow-accent')).toBeNull();
    expect(localStorage.getItem('averrow-base')).toBeNull();
    expect(result.current.accent).toBeNull();
    expect(result.current.base).toBeNull();
  });

  it('simulated P3-6 flip: setAccent(null) / setBase(null) apply the defaults to DOM and state', async () => {
    vi.resetModules();
    vi.doMock('../../../shared/src/theme/appearanceDefaults', async (orig) => ({
      ...(await orig<typeof import('../../../shared/src/theme/appearanceDefaults')>()),
      DEFAULT_ACCENT: 'indigo',
      DEFAULT_BASE: 'graphite',
    }));
    try {
      // Fresh React + testing-library alongside the re-imported hook (same module graph).
      const rtl = await import('@testing-library/react');
      const theme = await import('../../../shared/src/theme/useAppearance');
      expect(theme.DEFAULT_ACCENT).toBe('indigo');
      const { result } = rtl.renderHook(() => theme.useAppearance());
      expect(result.current.accent).toBe('indigo');
      expect(result.current.base).toBe('graphite');
      rtl.act(() => { result.current.setAccent('lime'); result.current.setBase('navy'); });
      expect(html.getAttribute('data-accent')).toBe('lime');
      rtl.act(() => { result.current.setAccent(null); result.current.setBase(null); });
      expect(html.getAttribute('data-accent')).toBe('indigo');
      expect(html.getAttribute('data-base')).toBe('graphite');
      expect(result.current.accent).toBe('indigo');
      expect(result.current.base).toBe('graphite');
      // storage is cleared so a later default change is followed
      expect(localStorage.getItem('averrow-accent')).toBeNull();
      expect(localStorage.getItem('averrow-base')).toBeNull();
      rtl.act(() => result.current.setAccent('nope' as never));
      expect(html.getAttribute('data-accent')).toBe('indigo');
    } finally {
      vi.doUnmock('../../../shared/src/theme/appearanceDefaults');
      vi.resetModules();
    }
  });

  it('an invalid value passed at runtime is treated as null', () => {
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.setAccent('indigo'));
    act(() => result.current.setAccent('nope' as never));
    expect(html.hasAttribute('data-accent')).toBe(false);
    expect(localStorage.getItem('averrow-accent')).toBeNull();
    expect(result.current.accent).toBeNull();
  });

  it('storage write failure still applies attribute and state', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const { result } = renderHook(() => useAppearance());
    expect(() => act(() => result.current.setAccent('violet'))).not.toThrow();
    expect(html.getAttribute('data-accent')).toBe('violet');
    expect(result.current.accent).toBe('violet');
  });
});
