// Averrow shared - runtime design-token reader (P3-2a).
//
// Canvas / WebGL code (deck.gl layers, chart canvases) cannot use `var(--x)`:
// it needs concrete RGBA numbers, and it needs to re-read them when the
// appearance changes (data-theme / data-accent / data-base on <html>).
//
// `getComputedStyle(root).getPropertyValue('--primary')` is not enough: it can
// return the unresolved declaration (a `var()` alias, `color-mix(...)`). So the
// reader paints the token onto a hidden probe element (`color: var(--x)`) and
// reads the probe's COMPUTED colour, which the browser has fully resolved.
// Where that does not resolve (jsdom, very old engines) it falls back to
// following the var() chain on <html> by hand (hex / rgb() / rgba() leaves).
//
// Results are cached per appearance version; a single MutationObserver on
// <html> bumps the version (and clears the cache) whenever one of the three
// appearance attributes changes. Everything is SSR / no-DOM safe: reads return
// '' / null and subscriptions are no-ops.
//
// Note: the probe hangs off <body>, so it reads the :root (page-level) value
// of a token. A value overridden on a nested scope (e.g. `.shell-v4`) is not
// seen; pass such tokens down from CSS instead.

import { useMemo, useSyncExternalStore } from 'react';

/** [r, g, b, a], each 0-255 (deck.gl's colour convention). */
export type Rgba = [number, number, number, number];

const OBSERVED_ATTRIBUTES = ['data-theme', 'data-accent', 'data-base'] as const;

let version = 0;
const cache = new Map<string, string>();
const listeners = new Set<(version: number) => void>();
let observer: MutationObserver | null = null;
let probe: HTMLElement | null = null;

function hasDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && !!document.documentElement
    && typeof window.getComputedStyle === 'function';
}

function bump(): void {
  version += 1;
  cache.clear();
  for (const cb of [...listeners]) cb(version);
}

/** Start the single <html> attribute observer (idempotent). */
function ensureObserver(): void {
  if (observer || !hasDom() || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((records) => {
    if (records.some((r) => r.type === 'attributes')) bump();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [...OBSERVED_ATTRIBUTES] });
}

function getProbe(): HTMLElement | null {
  if (!hasDom()) return null;
  if (probe && probe.isConnected) return probe;
  const el = document.createElement('span');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('data-token-probe', '');
  el.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;';
  (document.body ?? document.documentElement).appendChild(el);
  probe = el;
  return el;
}

// ── colour parsing ────────────────────────────────────────────────────

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 255;
  const s = raw.trim();
  const v = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  return Number.isFinite(v) ? clamp255(v * 255) : 255;
}

/** Parse a resolved CSS colour (#hex, rgb()/rgba() in comma or space syntax, color(srgb ...)) into RGBA 0-255. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === 'transparent') return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
  }
  const rgb = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (rgb) {
    const parts = rgb[1]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const [r, g, b] = parts.slice(0, 3).map(ch) as [number, number, number];
    if (![r, g, b].every(Number.isFinite)) return null;
    return [clamp255(r), clamp255(g), clamp255(b), parseAlpha(parts[3])];
  }
  // Chrome / Safari report color-mix() results as `color(srgb r g b / a)` (0-1 channels).
  const srgb = /^color\(\s*srgb\s+([^)]*)\)$/.exec(s);
  if (srgb) {
    const [chans, alpha] = srgb[1]!.split('/');
    const parts = chans!.trim().split(/\s+/).map(parseFloat);
    if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return null;
    return [clamp255(parts[0]! * 255), clamp255(parts[1]! * 255), clamp255(parts[2]! * 255), parseAlpha(alpha)];
  }
  return null;
}

const formatRgba = ([r, g, b, a]: Rgba) => (a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`);

/** Follow `var(--x[, fallback])` on <html> by hand. Leaves must be hex / rgb(); anything else (color-mix) -> null. */
function resolveByHand(value: string, depth = 0): Rgba | null {
  if (depth > 12) return null;
  const s = value.trim();
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(s);
  if (!m) return parseColor(s);
  const declared = window.getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim();
  if (declared) return resolveByHand(declared, depth + 1);
  return m[2] !== undefined ? resolveByHand(m[2], depth + 1) : null;
}

const SENTINEL = 'rgb(1, 2, 3)';
const SENTINEL_RGBA = '1,2,3,255';

function resolve(name: string): string {
  const p = getProbe();
  if (!p) return '';
  p.style.color = '';
  // The sentinel fallback marks an undefined token (otherwise the probe would inherit the text colour).
  p.style.color = `var(${name}, ${SENTINEL})`;
  const computed = window.getComputedStyle(p).color || '';
  const viaProbe = parseColor(computed);
  if (viaProbe && viaProbe.join() === SENTINEL_RGBA) return '';
  // jsdom has no cascade for var(): an unset probe colour reads as '' or the literal `var(...)`.
  if (viaProbe && !/var\(/.test(computed)) return formatRgba(viaProbe);
  const byHand = resolveByHand(`var(${name})`);
  return byHand ? formatRgba(byHand) : '';
}

// ── public API ────────────────────────────────────────────────────────

/** Current appearance version: bumps on every data-theme / data-accent / data-base change on <html>. */
export function getAppearanceVersion(): number {
  ensureObserver();
  return version;
}

/**
 * The resolved colour of a token as `rgb(r, g, b)` / `rgba(r, g, b, a)`, or ''
 * when there is no DOM or the token does not resolve to a colour.
 */
export function readToken(name: string): string {
  if (!hasDom()) return '';
  ensureObserver();
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const value = resolve(name);
  cache.set(name, value);
  return value;
}

/**
 * The resolved colour of a token as deck.gl RGBA (0-255), or null when it does
 * not resolve. `alpha` (0-255) replaces the token's own alpha when given.
 */
export function readTokenRgba(name: string, alpha?: number): Rgba | null {
  const rgba = parseColor(readToken(name));
  if (!rgba) return null;
  return alpha === undefined ? rgba : [rgba[0], rgba[1], rgba[2], clamp255(alpha)];
}

/** Call `cb(version)` after every appearance attribute change. Returns the unsubscribe function. */
export function subscribeAppearance(cb: (version: number) => void): () => void {
  ensureObserver();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export interface TokenColors {
  /** Token name -> resolved RGBA (null when it does not resolve). */
  colors: Record<string, Rgba | null>;
  /** Appearance version: use it in deck.gl `updateTriggers` so accessors re-run. */
  version: number;
}

const getServerVersion = () => 0;

/** The appearance version as React state: re-renders on every appearance attribute change. */
export function useAppearanceVersion(): number {
  return useSyncExternalStore(subscribeAppearance, getAppearanceVersion, getServerVersion);
}

/** Read `names` as RGBA and re-read them whenever the appearance changes. */
export function useTokenColors(names: readonly string[]): TokenColors {
  const v = useAppearanceVersion();
  const key = names.join('|');
  return useMemo(() => {
    const colors: Record<string, Rgba | null> = {};
    for (const n of key ? key.split('|') : []) colors[n] = readTokenRgba(n);
    return { colors, version: v };
  }, [key, v]);
}

/** Test hook: drop the cache, observer and probe (module state is global). */
export function __resetTokenReaderForTests(): void {
  observer?.disconnect();
  observer = null;
  probe?.remove();
  probe = null;
  cache.clear();
  listeners.clear();
  version = 0;
}
