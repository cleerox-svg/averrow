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

  describe('account-surface tokens (ACCOUNT_DESIGN_SPEC §4.0, §7)', () => {
    const css = read('../../../../shared/src/theme/tokens.css');
    const block = (open: string) => {
      const start = css.indexOf(open);
      return css.slice(start, css.indexOf('\n}', start));
    };
    const dark = block(':root {');
    const light = block('[data-theme="light"] {');
    const val = (b: string, name: string) => b.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();

    it('defines --violet, --violet-text, --tile-tint-pct, --focus-ring and --scrim in both themes', () => {
      expect(val(dark, '--violet')).toBe('#8B7CF6');
      expect(val(dark, '--violet-text')).toBe('#C4B5FD');
      expect(val(light, '--violet-text')).toBe('#6d28d9');
      expect(val(light, '--violet-text')).toBe(val(light, '--nexus-text'));
      expect(val(dark, '--tile-tint-pct')).toBe('16%');
      expect(val(light, '--tile-tint-pct')).toBe('20%');
      expect(val(dark, '--focus-ring')).toBe('var(--amber)');
      expect(val(light, '--focus-ring')).toBe('var(--amber-text)');
      expect(val(dark, '--scrim')).toBe('rgba(4, 7, 14, 0.62)');
      expect(val(light, '--scrim')).toBe('rgba(15, 20, 35, 0.35)');
    });

    it('--text-on-amber is defined once per theme (not duplicated)', () => {
      expect(dark.match(/--text-on-amber:/g)).toHaveLength(1);
      expect(light.match(/--text-on-amber:/g)).toHaveLength(1);
    });

    it('--violet-text clears 4.5:1 on its theme card surface', () => {
      const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
          .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const ratio = (a: string, b: string) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi! + 0.05) / (lo! + 0.05);
      };
      expect(ratio('#C4B5FD', '#161E30')).toBeGreaterThanOrEqual(4.5); // dark card
      expect(ratio('#6d28d9', '#FFFFFF')).toBeGreaterThanOrEqual(4.5); // light card
    });
  });
});
