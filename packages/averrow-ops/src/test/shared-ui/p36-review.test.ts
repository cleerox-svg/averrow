// Facelift P3-6 review fixes: leftover primary amber follows the accent, while
// the legacy look (no data-accent / FACELIFT=false) keeps its values.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ICON_TILE_TONES, roleBadgeProps } from '@averrow/shared/ui';
import { getAccountSections } from '@averrow/shared/account';

const PACKAGES = resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(resolve(PACKAGES, rel), 'utf8');

/** selector -> (custom property -> value) for the flat rule blocks of a CSS file. */
function cssBlocks(css: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = out.get(m[1]!.trim()) ?? new Map<string, string>();
    for (const d of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(d[1]!, d[2]!.trim());
    out.set(m[1]!.trim(), decls);
  }
  return out;
}
function rgbDistance(a: string, b: string): number {
  const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [ch(a), ch(b)];
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!);
}

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
  // A distinct tone NAME is not enough: Profile's tone is the primary, so under
  // the Violet accent it used to match Devices' violet. Resolve every section
  // tile tint per accent and mode and require visibly different colours.
  describe.each(['indigo', 'violet', 'mono', 'lime'] as const)('section tile tints under %s', (accent) => {
    const appearance = cssBlocks(read('shared/src/theme/appearance.css'));
    const tokens = read('shared/src/theme/tokens.css');
    it.each(['dark', 'light'] as const)('%s: every section tint differs from every other and from the alert reds', (mode) => {
      const scopes = mode === 'dark'
        ? [`:root[data-accent="${accent}"]:not([data-base="navy"]):not([data-theme="light"])`, `:root[data-accent="${accent}"]:not([data-theme="light"])`, ':root[data-accent]:not([data-theme="light"])']
        : [`:root[data-accent="${accent}"][data-theme="light"]`, ':root[data-accent][data-theme="light"]'];
      const lookup = (name: string): string => {
        for (const sel of scopes) {
          const v = appearance.get(sel)?.get(name);
          if (v) return v;
        }
        const m = tokens.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm'));
        if (!m) throw new Error(`unresolved ${name} (${accent} ${mode})`);
        return m[1]!.trim();
      };
      const resolveColor = (value: string, depth = 0): string => {
        const ref = value.match(/^var\((--[\w-]+)\)$/);
        if (!ref) return value;
        if (depth > 5) throw new Error(`var() cycle at ${value}`);
        return resolveColor(lookup(ref[1]!), depth + 1);
      };
      const tints = getAccountSections().map((s) => ({ id: s.id, hex: resolveColor(ICON_TILE_TONES[s.tone ?? 'neutral'].tint) }));
      for (const t of tints) expect(t.hex, t.id).toMatch(/^#[0-9a-f]{6}$/i);
      // Every pair of section tiles is visibly different ...
      for (let i = 0; i < tints.length; i++) {
        for (let j = i + 1; j < tints.length; j++) {
          const d = rgbDistance(tints[i]!.hex, tints[j]!.hex);
          expect(d, `${tints[i]!.id} vs ${tints[j]!.id}: ${tints[i]!.hex} / ${tints[j]!.hex}`).toBeGreaterThanOrEqual(60);
        }
      }
      // ... and none reads as the critical / alert red.
      for (const name of ['--sev-critical', '--red']) {
        const red = resolveColor(`var(${name})`);
        for (const t of tints) {
          expect(rgbDistance(t.hex, red), `${t.id} vs ${name}: ${t.hex} / ${red}`).toBeGreaterThanOrEqual(60);
        }
      }
    });
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
