// P3-2a runtime token reader (packages/shared/src/theme/tokenReader.ts).
// jsdom has no var() cascade on computed `color`, so these exercise the
// reader's by-hand var() fallback against a real stylesheet on <html>.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  readToken,
  readTokenRgba,
  parseColor,
  subscribeAppearance,
  getAppearanceVersion,
  useTokenColors,
} from '@averrow/shared/theme';
import { __resetTokenReaderForTests } from '../../../../shared/src/theme/tokenReader';

const CSS = `
:root { --amber: #E5A832; --primary: var(--amber); --glow: rgba(229, 168, 50, 0.2); --fb: var(--missing, #0a8ab5); --pct: 16%; }
:root[data-accent="indigo"] { --primary: #4c5cf8; }
`;

let style: HTMLStyleElement;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetTokenReaderForTests();
  style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
});
afterEach(() => {
  style.remove();
  document.documentElement.removeAttribute('data-accent');
  __resetTokenReaderForTests();
});

describe('parseColor', () => {
  it('parses hex, rgb(), rgba(), space syntax and color(srgb)', () => {
    expect(parseColor('#E5A832')).toEqual([229, 168, 50, 255]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 255]);
    expect(parseColor('rgb(229, 168, 50)')).toEqual([229, 168, 50, 255]);
    expect(parseColor('rgba(229, 168, 50, 0.2)')).toEqual([229, 168, 50, 51]);
    expect(parseColor('rgb(229 168 50 / 50%)')).toEqual([229, 168, 50, 128]);
    expect(parseColor('color(srgb 1 0 0 / 0.5)')).toEqual([255, 0, 0, 128]);
    expect(parseColor('var(--x)')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('readToken / readTokenRgba', () => {
  it('resolves a var() chain to a concrete colour', () => {
    expect(readToken('--primary')).toBe('rgb(229, 168, 50)');
    expect(readTokenRgba('--primary')).toEqual([229, 168, 50, 255]);
    expect(readTokenRgba('--glow')).toEqual([229, 168, 50, 51]);
  });

  it('follows a var() fallback and replaces alpha on request', () => {
    expect(readTokenRgba('--fb')).toEqual([10, 138, 181, 255]);
    expect(readTokenRgba('--primary', 230)).toEqual([229, 168, 50, 230]);
  });

  it('returns empty / null for an undefined token', () => {
    expect(readToken('--nope')).toBe('');
    expect(readTokenRgba('--nope')).toBeNull();
  });

  it('returns empty / null for a token that is not a colour (colour tokens only)', () => {
    expect(readToken('--pct')).toBe('');
    expect(readTokenRgba('--pct')).toBeNull();
  });

  it('does not bump the version when an attribute is re-set to the value it already has', async () => {
    document.documentElement.setAttribute('data-accent', 'indigo');
    await flush();
    const before = getAppearanceVersion();
    document.documentElement.setAttribute('data-accent', 'indigo');
    await flush();
    expect(getAppearanceVersion()).toBe(before);
  });

  it('re-reads after an appearance attribute change on <html>', async () => {
    expect(readTokenRgba('--primary')).toEqual([229, 168, 50, 255]);
    const before = getAppearanceVersion();
    document.documentElement.setAttribute('data-accent', 'indigo');
    await flush();
    expect(getAppearanceVersion()).toBeGreaterThan(before);
    expect(readTokenRgba('--primary')).toEqual([76, 92, 248, 255]);
  });

  it('ignores unrelated attribute changes', async () => {
    readToken('--primary');
    const before = getAppearanceVersion();
    document.documentElement.setAttribute('lang', 'en');
    await flush();
    expect(getAppearanceVersion()).toBe(before);
  });
});

describe('subscribeAppearance', () => {
  it('notifies until unsubscribed', async () => {
    const seen: number[] = [];
    const off = subscribeAppearance((v) => seen.push(v));
    document.documentElement.setAttribute('data-accent', 'indigo');
    await flush();
    expect(seen).toHaveLength(1);
    off();
    document.documentElement.removeAttribute('data-accent');
    await flush();
    expect(seen).toHaveLength(1);
  });
});

describe('useTokenColors', () => {
  it('returns the colours plus a version that bumps on change', async () => {
    const { result } = renderHook(() => useTokenColors(['--primary']));
    expect(result.current.colors['--primary']).toEqual([229, 168, 50, 255]);
    const v0 = result.current.version;
    await act(async () => {
      document.documentElement.setAttribute('data-accent', 'indigo');
      await flush();
    });
    expect(result.current.version).toBeGreaterThan(v0);
    expect(result.current.colors['--primary']).toEqual([76, 92, 248, 255]);
  });

  it('keeps the colours object stable while the appearance is unchanged', () => {
    const { result, rerender } = renderHook(() => useTokenColors(['--primary']));
    const first = result.current.colors;
    rerender();
    expect(result.current.colors).toBe(first);
  });
});
