// @vitest-environment node
//
// Motion kit (P3-4) static guards:
// 1. motion.css is imported by tokens.css and every rule in it is scoped under
//    :root[data-accent] (no accent = pixel-identical legacy UI, no animation).
// 2. The duration scale is remapped (500 ms retired) only under the accent;
//    the legacy :root values are untouched.
// 3. Reduced motion is opacity-only.
// 4. The motion JS stays inside the ~3 KB gzip budget (BRAND_BRIEF G4).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { transformWithEsbuild } from 'vite';

const SHARED = resolve(__dirname, '../../../../shared/src');
const read = (rel: string) => readFileSync(resolve(SHARED, rel), 'utf8');
const MOTION_CSS = read('theme/motion.css');
const TOKENS = read('theme/tokens.css');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level rule blocks (selector + body), descending into @media / @supports but not @keyframes. */
function rules(css: string): Array<{ selector: string; body: string; at: string | null }> {
  const out: Array<{ selector: string; body: string; at: string | null }> = [];
  const walk = (src: string, at: string | null) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith('@keyframes')) { /* keyframes are inert until a scoped rule names them */ }
      else if (head.startsWith('@media') || head.startsWith('@supports')) walk(body, head);
      else out.push({ selector: head, body, at });
      i = j;
    }
  };
  walk(strip(css), null);
  return out;
}

describe('motion.css is accent-scoped', () => {
  it('is imported by tokens.css after appearance.css', () => {
    const a = TOKENS.indexOf('@import "./appearance.css"');
    const m = TOKENS.indexOf('@import "./motion.css"');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(m).toBeGreaterThan(a);
  });

  it('every selector is under :root[data-accent]', () => {
    const list = rules(MOTION_CSS);
    expect(list.length).toBeGreaterThan(5);
    for (const r of list) {
      for (const sel of r.selector.split(',')) {
        expect(sel.trim(), `unscoped selector: ${sel}`).toMatch(/^:root\[data-accent\]/);
      }
    }
  });

  it('nothing in motion.css loops or runs 500 ms', () => {
    const css = strip(MOTION_CSS);
    expect(css).not.toMatch(/\binfinite\b/);
    expect(css).not.toMatch(/\b500ms\b/);
  });
});

describe('duration tokens', () => {
  const block = (open: string, src: string) => {
    const start = src.indexOf(open);
    return strip(src.slice(start + open.length, src.indexOf('\n}', start)));
  };
  const decl = (body: string, name: string) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim();

  it('legacy :root keeps 120 / 180 / 300 / 500', () => {
    const root = block(':root {', TOKENS);
    expect(decl(root, '--dur-fast')).toBe('120ms');
    expect(decl(root, '--dur-base')).toBe('180ms');
    expect(decl(root, '--dur-slow')).toBe('300ms');
    expect(decl(root, '--dur-slower')).toBe('500ms');
  });

  it('under :root[data-accent] base 160, slow 200, slower 200 (500 retired)', () => {
    const accent = block(':root[data-accent] {', MOTION_CSS);
    expect(decl(accent, '--dur-base')).toBe('160ms');
    expect(decl(accent, '--dur-slow')).toBe('200ms');
    expect(decl(accent, '--dur-slower')).toBe('200ms');
    expect(decl(accent, '--motion-fast')).toBe('120ms');
    expect(decl(accent, '--motion-base')).toBe('160ms');
    expect(decl(accent, '--motion-slow')).toBe('200ms');
  });
});

describe('arrival styles do not persist on the row', () => {
  it('the row animation has no fill-forwards and no box-shadow; tint and scan-line live on pseudo-elements', () => {
    const list = rules(MOTION_CSS).filter((r) => r.at === null);
    const row = list.find((r) => r.selector.trim() === ':root[data-accent] .motion-arrive')!;
    expect(row.body).not.toMatch(/\b(both|forwards)\b/);
    expect(row.body).not.toMatch(/box-shadow|position/);
    const before = list.find((r) => r.selector.trim() === ':root[data-accent] .motion-arrive::before')!;
    const after = list.find((r) => r.selector.trim() === ':root[data-accent] .motion-arrive::after')!;
    expect(before.body).toMatch(/motion-settle/);
    expect(after.body).toMatch(/motion-scan/);
    for (const r of [before, after]) expect(r.body).not.toMatch(/\b(both|forwards)\b/);
  });
});

describe('reduced motion', () => {
  it('has an opacity-only version of the arrival move (OS setting and /kit simulation)', () => {
    const reduced = rules(MOTION_CSS).filter((r) => r.at?.includes('prefers-reduced-motion') || r.selector.includes('[data-motion="reduce"]'));
    const arrive = reduced.filter((r) => /\.motion-arrive$/.test(r.selector.trim()));
    expect(arrive).toHaveLength(2);
    for (const r of arrive) expect(r.body).toMatch(/animation:\s*motion-fade-in/);
    const fade = /@keyframes motion-fade-in\s*{([\s\S]*?)}\s*}/.exec(strip(MOTION_CSS))?.[1] ?? '';
    expect(fade).toMatch(/opacity/);
    expect(fade).not.toMatch(/transform/);
  });
});

describe('motion JS budget', () => {
  it('the minified motion kit is <= 3.5 KB gzip', async () => {
    const files = ['motion.ts', 'useGlideIndicator.ts', 'NavIndicator.tsx', 'usePageSlide.ts', 'useArrivalFlash.ts', 'index.ts'];
    let code = '';
    for (const f of files) {
      const out = await transformWithEsbuild(read(`ui/motion/${f}`), f, { minify: true, jsx: 'automatic', format: 'esm' });
      code += out.code;
    }
    const gz = gzipSync(code).length;
    expect(gz).toBeLessThanOrEqual(3584);
  });
});
