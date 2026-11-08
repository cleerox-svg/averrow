// Facelift Phase 6, screen 6a: the Observatory's top bar, lens strip, legends, stats bar and map controls.
// Source guards (no raw colours, no sub-12px type, no capitals-with-tracking, no glow) + the behaviour they protect.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { LensStrip } from './LensStrip';
import userEvent from '@testing-library/user-event';
import { DataFiltersPopover } from './DataFilters';
import { FiltersPopover } from './ToolbarControls';
import { BODY, FACT, LABEL } from '../lib/chrome-classes';
import { TYPE_OPTIONS } from '../lib/filters';
import { typeDisplayLabel } from '../lib/map-colors';

const HERE = __dirname;
const V3 = resolve(HERE, '..');
const SRC = resolve(HERE, '../../..');
const read = (p: string) => readFileSync(p, 'utf8');

const SCOPE_FILES = [
  'ToolbarControls.tsx', 'LensStrip.tsx', 'DataFilters.tsx', 'ObservatorySearch.tsx', 'LegendChip.tsx',
  'LensLegend.tsx', 'ProjectionToggle.tsx', 'MapAttribution.tsx', 'ControlRail.tsx',
].map(f => resolve(HERE, f)).concat(resolve(V3, 'lib/chrome-classes.ts'));

/** The stats bar, loading pill and panel toggles in ObservatoryV3.tsx are in scope; the rest of that file is not. */
function statsBarAndPill(): string {
  const src = read(resolve(V3, 'ObservatoryV3.tsx'));
  const a = src.indexOf('Subtle loading / updating pill');
  const b = src.indexOf('Bot share: loading / error / empty states');
  const c = src.indexOf('{/* ─── Stats bar');
  const d = src.indexOf('{/* ─── Headline bar');
  if (!(a >= 0 && a < b && b < c && c < d)) throw new Error('ObservatoryV3.tsx section markers moved: update statsBarAndPill()');
  return src.slice(a, b) + src.slice(c, d);
}

describe('chrome source guards (6a)', () => {
  const sources: Array<[string, string]> = [
    ...SCOPE_FILES.map(f => [f.split('/').pop()!, read(f)] as [string, string]),
    ['ObservatoryV3.tsx (stats bar + pill)', statsBarAndPill()],
  ];

  for (const [name, src] of sources) {
    describe(name, () => {
      const lines = src.split('\n');
      const code = lines.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));

      it('has no hex colour (map colours come from lib/map-colors tuples)', () => {
        expect(code.join('\n')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      });
      it('has no rgba() and no alpha-slash colour syntax', () => {
        const joined = code.join('\n');
        expect(joined).not.toMatch(/rgba\(/);
        expect(joined).not.toMatch(/rgb\([^)]*\/[^)]*\)/);
      });
      it('has no 10px / 11px type', () => {
        const joined = code.join('\n');
        expect(joined).not.toMatch(/text-\[1[01]px\]/);
        expect(joined).not.toMatch(/fontSize:\s*1[01]\b/);
      });
      it('has no uppercase class or letter-spaced capitals', () => {
        const joined = code.join('\n');
        expect(joined).not.toMatch(/(^|[\s"'`])uppercase\b/);
        expect(joined).not.toMatch(/tracking-\[0\.2em\]|tracking-wider|tracking-wide\b/);
      });
      it('has no primary-glow box-shadow', () => {
        expect(code.join('\n')).not.toMatch(/boxShadow[^\n]*--primary-glow|0 0 \d+px var\(--primary-glow\)/);
      });
      it('never uses the flat --card-shadow token as a boxShadow', () => {
        expect(code.join('\n')).not.toMatch(/boxShadow:\s*'var\(--card-shadow\)'/);
      });
    });
  }

  it('the four duplicated LABEL constants are gone: the files import the shared module', () => {
    for (const f of ['LegendChip.tsx', 'LensLegend.tsx', 'ToolbarControls.tsx']) {
      expect(read(resolve(HERE, f))).not.toMatch(/^(export )?const (FILTER_)?LABEL = /m);
    }
    expect(read(resolve(HERE, 'LegendChip.tsx'))).toContain("from '../lib/chrome-classes'");
    expect(read(resolve(HERE, 'LensLegend.tsx'))).toContain("from '../lib/chrome-classes'");
  });
});

describe('threat type labels keep their acronyms', () => {
  it('typeDisplayLabel', () => {
    expect(typeDisplayLabel('malicious_ip')).toBe('Malicious IP');
    expect(typeDisplayLabel('malicious_ssl')).toBe('Malicious SSL');
    expect(typeDisplayLabel('spam_botnet_c2')).toBe('Spam botnet C2');
    expect(typeDisplayLabel('credential_harvesting')).toBe('Credential harvesting');
  });
  it('the filter options use the same labels', () => {
    const byId = Object.fromEntries(TYPE_OPTIONS.map(t => [t.id, t.label]));
    expect(byId['malicious_ip']).toBe('Malicious IP');
    expect(byId['malicious_ssl']).toBe('Malicious SSL');
    expect(byId['c2']).toBe('C2');
  });
});

describe('chrome type classes', () => {
  it('labels and prose are sans at 12px+, facts are mono', () => {
    expect(LABEL).toContain('text-type-label');
    expect(BODY).toContain('text-type-label');
    expect(`${LABEL} ${BODY}`).not.toContain('font-mono');
    expect(FACT).toContain('font-mono');
  });
});

describe('LensStrip active state is flat', () => {
  it('uses the primary tint and border, with no glow, no gradient', () => {
    render(<LensStrip lens="threats" onChange={() => {}} controls="map-region" />);
    const tab = screen.getByRole('tab', { name: 'Threats' });
    expect(tab.style.background).toBe('var(--primary-tint)');
    expect(tab.style.border).toContain('var(--primary-border)');
    expect(tab.style.boxShadow).toBe('');
    expect(tab.style.background).not.toContain('gradient');
  });
  it('every tab names the map region it controls', () => {
    render(<LensStrip lens="threats" onChange={() => {}} controls="map-region" />);
    for (const t of screen.getAllByRole('tab')) expect(t).toHaveAttribute('aria-controls', 'map-region');
  });
});

describe('FiltersPopover focus', () => {
  it('moves focus into the dialog on open and Escape returns it to the trigger', async () => {
    render(<FiltersPopover period="7d" source="all"><button type="button">First</button></FiltersPopover>);
    const trigger = screen.getByRole('button', { name: /^Filters: 7D/ });
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });
});

describe('DataFiltersPopover focus', () => {
  it('moves focus in on open; an outside press with focus inside returns it to the trigger', async () => {
    render(<div><button type="button">outside</button><DataFiltersPopover count={0}><button type="button">First</button></DataFiltersPopover></div>);
    const trigger = screen.getByRole('button', { name: 'Data filters' });
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(trigger).toHaveFocus();
  });
  it('Escape returns focus to the trigger', async () => {
    render(<DataFiltersPopover count={2}><button type="button">First</button></DataFiltersPopover>);
    const trigger = screen.getByRole('button', { name: 'Data filters: 2 active' });
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });
});

describe('LegendChip trigger', () => {
  it('is sentence case, not letter-spaced capitals', () => {
    const src = read(resolve(HERE, 'LegendChip.tsx'));
    expect(src).toMatch(/>Legend<\/span>/);
    expect(src).not.toMatch(/uppercase/);
  });
});

describe('MapLibre control override (index.css)', () => {
  const css = read(resolve(SRC, 'index.css'));
  const start = css.indexOf('/* Observatory map controls');
  const block = css.slice(start);

  it('exists, scoped under the Observatory root class', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('.obs-root .maplibregl-ctrl.maplibregl-ctrl-group');
    expect(read(resolve(V3, 'ObservatoryV3.tsx'))).toMatch(/className="obs-root /);
  });
  it('paints the group with chrome tokens, never the flat --card-shadow', () => {
    for (const t of ['var(--bg-card)', 'var(--border-base)', 'var(--card-shadow-elevated)', 'var(--text-secondary)', 'var(--focus-ring)']) {
      expect(block).toContain(t);
    }
    expect(block).not.toContain('var(--card-shadow)');
  });
  it('has no raw colours (the zoom icons are masks over a token fill)', () => {
    const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![^"]*")/);
    expect(noComments).not.toMatch(/rgba?\(/);
    expect(noComments).toContain('mask-image');
    expect(noComments).toContain('maplibregl-ctrl-zoom-in');
    expect(noComments).toContain('maplibregl-ctrl-zoom-out');
  });
  it('the group does not clip its children (the Heat "flat-only" reason hangs outside the group), buttons round their own corners', () => {
    const rule = block.match(/\.obs-root \.maplibregl-ctrl\.maplibregl-ctrl-group \{[^}]*\}/)![0];
    expect(rule).not.toMatch(/overflow\s*:\s*hidden/);
    expect(block).toMatch(/button:first-child[^{]*\{[^}]*border-radius/);
    expect(block).toMatch(/button:last-child[^{]*\{[^}]*border-radius/);
  });
  it('nothing outside the Observatory styles MapLibre controls', () => {
    expect(css.slice(0, start)).not.toMatch(/\.maplibregl-ctrl/);
  });
});
