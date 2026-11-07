// R3 logo (facelift P3-5): geometry pinned to docs/brand/logo/, and the
// legacy <-> R3 toggle — legacy only while <html> has no data-accent (today),
// R3 only once an accent is set (the P3-6 flip).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AverrowLockup, AverrowMark as R3Mark, LOGO_LEGACY_CLASS, LOGO_R3_BLOCK_CLASS, LOGO_R3_CLASS,
  R3_MARK_PATH, R3_TILE_FILL, R3_WORDMARK_PATH, R3_MARK_RED,
} from '@averrow/shared/ui';
import { AverrowMark as OpsMark } from '@/components/brand/AverrowMark';

const REPO = resolve(__dirname, '../../../../..');
const svg = (name: string) => readFileSync(resolve(REPO, 'docs/brand/logo', name), 'utf8');
const paths = (src: string) => [...src.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

describe('R3 geometry matches docs/brand/logo', () => {
  it('mark path = mark-red.svg, red #C83C3C', () => {
    expect(paths(svg('mark-red.svg'))).toEqual([R3_MARK_PATH]);
    expect(svg('mark-red.svg')).toContain(`fill="${R3_MARK_RED}"`);
  });

  it('lockup = lockup-horizontal-dark.svg (mark + wordmark, no tagline)', () => {
    expect(paths(svg('lockup-horizontal-dark.svg'))).toEqual([R3_MARK_PATH, R3_WORDMARK_PATH]);
    expect(paths(svg('wordmark-dark.svg'))).toEqual([R3_WORDMARK_PATH]);
  });

  it('tile = app-icon.svg: #121B31, radius 7/32, no rim', () => {
    const { container } = render(<R3Mark size={64} />);
    const s = container.querySelector('svg')!;
    const rect = s.querySelector('rect')!;
    expect(svg('app-icon.svg')).toContain(`<rect width="32" height="32" rx="7" fill="${R3_TILE_FILL}"/>`);
    expect(rect.getAttribute('rx')).toBe('7');
    expect(rect.getAttribute('fill')).toBe(R3_TILE_FILL);
    expect(s.querySelectorAll('rect')).toHaveLength(1); // no rim
    expect(s.querySelector('path')!.getAttribute('transform')).toBe('translate(1.02 0.86) scale(0.94)');
    expect(s.querySelector('linearGradient')).toBeNull(); // flat
    expect(s.getAttribute('width')).toBe('64');
    expect(s).toHaveAttribute('aria-label', 'Averrow');
  });

  it('clamps to the 16px minimum', () => {
    const { container } = render(<><R3Mark size={8} /><R3Mark size={8} tile={false} /><AverrowLockup height={4} /></>);
    const [tile, bare, lockup] = [...container.querySelectorAll('svg')];
    expect(tile!.getAttribute('height')).toBe('16');
    expect(bare!.getAttribute('height')).toBe('16');
    // The mark is 40/48 of the lockup height: >= 16px needs >= 20px.
    expect(Number(lockup!.getAttribute('height'))).toBeGreaterThanOrEqual(20);
  });

  it('lockup wordmark follows currentColor unless a brand tone is pinned', () => {
    const { container } = render(<><AverrowLockup decorative /><AverrowLockup tone="on-light" /></>);
    const [a, b] = [...container.querySelectorAll('svg')];
    expect(a!.querySelectorAll('path')[1]!.getAttribute('fill')).toBe('currentColor');
    expect(a).toHaveAttribute('aria-hidden', 'true');
    expect(b!.querySelectorAll('path')[1]!.getAttribute('fill')).toBe('#0B0F1A');
  });
});

describe('legacy <-> R3 toggle', () => {
  const tokens = readFileSync(resolve(REPO, 'packages/shared/src/theme/tokens.css'), 'utf8');
  const toggleCss = tokens.slice(tokens.indexOf('/* R3 logo toggle'));
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = toggleCss;
    document.head.appendChild(style);
    document.documentElement.removeAttribute('data-accent');
  });
  afterEach(() => {
    style.remove();
    document.documentElement.removeAttribute('data-accent');
  });

  const display = (el: Element) => getComputedStyle(el).display;

  it('tokens.css carries the four toggle rules', () => {
    expect(toggleCss).toContain(':root .av-logo-r3,');
    expect(toggleCss).toContain(':root[data-accent] .av-logo-legacy {');
    expect(toggleCss).toContain(':root[data-accent] .av-logo-r3 {');
    expect(toggleCss).toContain(':root[data-accent] .av-logo-r3-block {');
  });

  it('ops AverrowMark renders the legacy tile (unchanged) and a hidden R3 tile', () => {
    const { container } = render(<OpsMark size={56} />);
    const legacy = container.querySelector(`.${LOGO_LEGACY_CLASS}`)!;
    const r3 = container.querySelector(`.${LOGO_R3_BLOCK_CLASS}`)!;
    expect(legacy).not.toBeNull();
    expect(r3).not.toBeNull();
    // Legacy keeps its gradient + rim; R3 is the flat tile.
    expect(legacy.querySelector('linearGradient')).not.toBeNull();
    expect(legacy.querySelectorAll('rect')).toHaveLength(2);
    expect(r3.getAttribute('data-logo')).toBe('r3');

    // No accent (today): legacy shows, R3 hidden.
    expect(display(legacy)).not.toBe('none');
    expect(display(r3)).toBe('none');

    // After the flip: R3 shows, legacy hidden.
    document.documentElement.setAttribute('data-accent', 'indigo');
    expect(display(legacy)).toBe('none');
    expect(display(r3)).toBe('block');
  });

  it('inline R3 variant shows as inline-flex under an accent', () => {
    const { container } = render(<AverrowLockup className={LOGO_R3_CLASS} />);
    const el = container.querySelector(`.${LOGO_R3_CLASS}`)!;
    expect(display(el)).toBe('none');
    document.documentElement.setAttribute('data-accent', 'lime');
    expect(display(el)).toBe('inline-flex');
  });
});
