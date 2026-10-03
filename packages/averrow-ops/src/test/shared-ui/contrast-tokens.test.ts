import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Source-level guards for theme-aware text colours (jsdom can't compute CSS).
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('theme-aware text colour guards', () => {
  it('.detail-stat-metric-label uses a theme token, not a hard-coded 25% white', () => {
    const css = read('../../../../shared/src/theme/tokens.css');
    const rule = css.match(/\.detail-stat-metric-label\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('color: var(--text-secondary)');
    expect(rule).not.toMatch(/rgba\(255,\s*255,\s*255/);
  });

  it('HeroCards pills and counts use --sev-*-text tokens, not fixed Tailwind hues or white alphas', () => {
    const src = read('../../features/brands/components/HeroCards.tsx');
    expect(src).not.toMatch(/text-(red|green|amber)-400/);
    expect(src).not.toMatch(/bg-(red|green|amber)-900|border-(red|green|amber)-500/);
    expect(src).not.toMatch(/text-white\/(30|40|50|60)(?![\d\]])/);
    expect(src).toContain('var(--sev-critical-text)');
  });

  it('AdminAudit outcome chips use --sev-*-text/bg tokens', () => {
    const src = read('../../features/admin/AdminAudit.tsx');
    expect(src).not.toMatch(/text-(red|green|amber)-400/);
    expect(src).toContain('var(--sev-${t}-bg)');
  });
});
