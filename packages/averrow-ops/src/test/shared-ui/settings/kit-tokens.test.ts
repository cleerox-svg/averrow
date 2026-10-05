import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// jsdom can't compute CSS: guard the settings-kit tokens at source level.
const css = readFileSync(resolve(__dirname, '../../../../../shared/src/theme/tokens.css'), 'utf8');
const block = (selector: string): string => {
  const i = css.indexOf(`${selector} {`);
  return css.slice(i, css.indexOf('\n}', i));
};
const card = readFileSync(resolve(__dirname, '../../../../../shared/src/ui/Card.tsx'), 'utf8');

describe('settings kit tokens', () => {
  it('color-scheme follows the theme', () => {
    expect(block(':root')).toContain('color-scheme: dark');
    expect(block('[data-theme="light"]')).toContain('color-scheme: light');
  });

  it('defines switch off-state, help text, tile rim and elevated-card tokens in both themes', () => {
    for (const t of ['--switch-off-border', '--switch-knob-off', '--text-help', '--tile-rim', '--card-shadow-elevated', '--card-rim-elevated']) {
      expect(block(':root'), `:root ${t}`).toContain(`${t}:`);
      expect(block('[data-theme="light"]'), `light ${t}`).toContain(`${t}:`);
    }
    expect(block('[data-theme="light"]')).toMatch(/--card-shadow-elevated:\s*0 12px 40px rgba\(15, 20, 35/);
  });

  it('Card elevated no longer hardcodes the dark halo', () => {
    expect(card).toContain('var(--card-shadow-elevated)');
    expect(card).not.toContain('rgba(0, 0, 0, 0.75)');
  });

  it('--z-popover sits above --z-modal and below --z-toast', () => {
    const n = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)`).exec(css)?.[1]);
    expect(n('--z-popover')).toBeGreaterThan(n('--z-modal'));
    expect(n('--z-popover')).toBeLessThan(n('--z-toast'));
  });

  it('help copy in the settings kit uses --text-help, not tertiary', () => {
    for (const sel of ['.ds-sgroup-foot', '.ds-srow-meta', '.ds-hero-scope']) {
      const rule = css.match(new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*\\}`))?.[0] ?? '';
      expect(rule, sel).toContain('var(--text-help)');
    }
  });
});
