import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(src, p), 'utf8');

function block(css: string, selector: string): string {
  const i = css.indexOf(`\n${selector} {`);
  expect(i, `missing ${selector}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
}

describe('shell card tokens under the facelift', () => {
  const index = read('index.css');
  const reset = block(index, ':root[data-accent] .shell-v4');

  it('resets radius, shadow and highlight for every theme', () => {
    expect(reset).toMatch(/--card-radius:\s*var\(--radius-lg\)/);
    // A list-safe empty shadow: `none` inside `var(--card-shadow), <glow>` would
    // invalidate the whole box-shadow and drop active/critical glows and rims.
    expect(reset).toMatch(/--card-shadow:\s*0 0 #0000;/);
  });

  it('never sets --card-shadow to `none` anywhere (it is composed in shadow lists)', () => {
    for (const f of ['index.css', 'features/home/home.css', 'components/layout/shell-v4.css']) {
      expect(read(f), f).not.toMatch(/--card-shadow:\s*none/);
    }
    expect(reset).toMatch(/--card-highlight:\s*transparent/);
    expect(reset).not.toContain('--card-flat-bg');
    expect(index).not.toContain(':root[data-accent][data-theme="light"] .shell-v4 {');
  });

  it('legacy shell values stay in shell-v4.css (FACELIFT=false)', () => {
    const shell = read('components/layout/shell-v4.css');
    expect(shell).toMatch(/\.shell-v4 \{\s*--card-shadow: 0 18px 50px[^}]*--card-radius: 18px/);
    expect(shell).toContain(':root:not([data-theme="light"]) .shell-v4 {');
  });

  it('Overview wrapper only keeps the flat surface', () => {
    expect(read('features/home/home.css')).not.toMatch(/--card-(shadow|radius|highlight)\s*:/);
  });

  it('floating Observatory surfaces and popovers use the elevated shadow', () => {
    const files = [
      'components/observatory/ObservatoryOverlay.tsx',
      'features/observatory-v3/ObservatoryV3.tsx',
      ...readdirSync(resolve(src, 'features/observatory-v3/components'))
        .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
        .map((f) => join('features/observatory-v3/components', f)),
    ];
    for (const f of files) {
      expect(statSync(resolve(src, f)).isFile()).toBe(true);
      expect(read(f), f).not.toMatch(/boxShadow:\s*'var\(--card-shadow\)'/);
    }
    expect(read('components/platform-status-flyout.css')).toContain('var(--card-shadow-elevated)');
    expect(read('components/NotificationBell.tsx')).toContain('variant="elevated"');
  });

  it('pins the frozen PortfolioHealthCard (.glass-card) light shadow to its pre-reset value', () => {
    const sel = ':root[data-accent][data-theme="light"] .glass-card:not(:hover)';
    const body = block(index, sel);
    expect(body).toContain('0 8px 28px rgba(15, 20, 35, 0.10)');
    expect(body).toContain('inset 0 1px 0 rgba(255, 255, 255, 0.90)');
    expect(body).not.toContain('var(--card-');
    // dark .glass-card reads no card tokens, so nothing to pin
    const dark = index.slice(index.indexOf('  .glass-card {'), index.indexOf('  .glass-card:hover {'));
    expect(dark).not.toMatch(/var\(--card-(shadow|radius|highlight)/);
  });
});
