// Facelift P3-6 review fixes: leftover primary amber follows the accent, while
// the legacy look (no data-accent / FACELIFT=false) keeps its values.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ICON_TILE_TONES, roleBadgeProps } from '@averrow/shared/ui';
import { getAccountSections } from '@averrow/shared/account';

const PACKAGES = resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(resolve(PACKAGES, rel), 'utf8');

describe('threats table', () => {
  const css = read('shared/src/threats-table/threats-table.css');
  it('keeps the legacy amber rules (no accent) and overrides them under [data-accent]', () => {
    expect(css).toContain('.tt-chip[data-active="true"] {\n  color: var(--amber-text); background: rgba(229,168,50,0.10); border-color: rgba(229,168,50,0.30);');
    for (const sel of [
      ':root[data-accent] .tt-chip[data-active="true"]',
      ':root[data-accent] .tt-th[data-active="true"]',
      ':root[data-accent] .tt-link',
      ':root[data-accent] .tt-btn[data-variant="primary"]',
      ':root[data-accent] .tt-row[data-open="true"] .tt-expand-icon',
    ]) {
      const i = css.indexOf(`${sel} {`);
      expect(i, sel).toBeGreaterThan(-1);
      const body = css.slice(i, css.indexOf('}', i));
      expect(body, sel).not.toMatch(/amber|229,\s*168/);
      expect(body, sel).toMatch(/var\(--(primary|link)/);
    }
  });
  it('severity pills stay amber (status colour)', () => {
    expect(css).not.toMatch(/:root\[data-accent\] \.tt-pill/);
  });
});

describe('settings tiles + role badge', () => {
  it('the primary tile tone is amber in the legacy look (--primary / --primary-text) and follows the accent', () => {
    expect(ICON_TILE_TONES.primary).toEqual({ tint: 'var(--primary)', glyph: 'var(--primary-text)' });
    const tokens = read('shared/src/theme/tokens.css');
    expect(tokens).toMatch(/--primary:\s+var\(--amber\);/);
    expect(tokens).toMatch(/--primary-text:\s+var\(--amber-text\);/);
  });
  it('Profile uses the primary tone; every section tone is distinct', () => {
    const sections = getAccountSections();
    expect(sections.find((s) => s.id === 'profile')?.tone).toBe('primary');
    const tones = sections.map((s) => s.tone);
    expect(new Set(tones).size).toBe(tones.length);
  });
  it('Profile rows and the staff-view toggle no longer use the amber tile', () => {
    expect(read('shared/src/account/ProfileSettings.tsx')).not.toContain('tone="amber"');
    const channels = read('shared/src/account/notifications/ChannelsSection.tsx');
    expect(channels).toMatch(/tone="primary"\s*\n\s*title="Show customer notifications"/);
  });
  it('admins get a neutral badge with the facelift on, amber medium when reverted', async () => {
    expect(roleBadgeProps('super_admin').tone).toEqual({ status: 'draft' });
    expect(roleBadgeProps('admin').tone).toEqual({ status: 'draft' });
    expect(roleBadgeProps('analyst').tone).toEqual({ severity: 'low' });
    vi.resetModules();
    vi.doMock('../../../../shared/src/theme/appearanceDefaults', async (orig) => ({
      ...(await orig<typeof import('../../../../shared/src/theme/appearanceDefaults')>()),
      FACELIFT: false,
    }));
    try {
      const m = await import('../../../../shared/src/ui/settings/roleBadge');
      expect(m.roleBadgeProps('super_admin').tone).toEqual({ severity: 'medium' });
    } finally {
      vi.doUnmock('../../../../shared/src/theme/appearanceDefaults');
      vi.resetModules();
    }
  });
});

describe('shell', () => {
  it('the top wash follows the accent; the legacy red wash is kept without one', () => {
    const shell = read('averrow-ops/src/components/layout/shell-v4.css');
    expect(shell).toContain('radial-gradient(1200px 700px at 80% -12%, rgba(200,60,60,0.14), transparent 60%)');
    const i = shell.indexOf(':root[data-accent] .shell-v4::before {');
    expect(i).toBeGreaterThan(-1);
    const body = shell.slice(i, shell.indexOf('}', i));
    expect(body).not.toContain('200,60,60');
    expect(body).toContain('var(--primary)');
  });
  it('light cards in the shell use a soft ink shadow under an accent', () => {
    const css = read('averrow-ops/src/index.css');
    const i = css.indexOf(':root[data-accent][data-theme="light"] .shell-v4 {');
    expect(i).toBeGreaterThan(-1);
    const body = css.slice(i, css.indexOf('}', i));
    expect(body).toMatch(/--card-shadow:\s*0 8px 28px rgba\(15, 20, 35, 0\.10\)/);
  });
});
