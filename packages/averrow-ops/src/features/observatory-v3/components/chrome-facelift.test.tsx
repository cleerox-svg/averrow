// Facelift Phase 6, screen 6a: the Observatory's top bar, lens strip, legends, stats bar and map controls.
// Source guards (no raw colours, no sub-12px type, no capitals-with-tracking, no glow) + the behaviour they protect.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { LensStrip } from './LensStrip';
import { LegendChip } from './LegendChip';
import { FiltersPopover } from './ToolbarControls';
import { BODY, FACT, LABEL, sentence } from '../lib/chrome-classes';

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
  const c = src.indexOf('Stats bar');
  const d = src.indexOf('Headline bar');
  return src.slice(a, b) + src.slice(c, d);
}

/** Lines that are documented map-colour literals (the legend repeats what a WebGL layer draws). */
const isMapColourLine = (line: string, prev: string) => /\(map colour\)/.test(line) || /\(map colour\)/.test(prev);

describe('chrome source guards (6a)', () => {
  const sources: Array<[string, string]> = [
    ...SCOPE_FILES.map(f => [f.split('/').pop()!, read(f)] as [string, string]),
    ['ObservatoryV3.tsx (stats bar + pill)', statsBarAndPill()],
  ];

  for (const [name, src] of sources) {
    describe(name, () => {
      const lines = src.split('\n');
      const code = lines.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));

      it('has no hex colour except a documented map-colour literal', () => {
        lines.forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !isMapColourLine(line, lines[i - 1] ?? '')) {
            throw new Error(`${name}:${i + 1} raw hex: ${line.trim()}`);
          }
        });
      });
      it('has no rgba()', () => { expect(code.join('\n')).not.toMatch(/rgba\(/); });
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

describe('chrome type classes', () => {
  it('labels and prose are sans at 12px+, facts are mono', () => {
    expect(LABEL).toContain('text-type-label');
    expect(BODY).toContain('text-type-label');
    expect(`${LABEL} ${BODY}`).not.toContain('font-mono');
    expect(FACT).toContain('font-mono');
  });
  it('sentence() capitalises only the first letter', () => {
    expect(sentence('malware distribution')).toBe('Malware distribution');
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
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<FiltersPopover period="7d" source="all"><button type="button">First</button></FiltersPopover>);
    const trigger = screen.getByRole('button', { name: /^Filters: 7D/ });
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
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
  it('nothing outside the Observatory styles MapLibre controls', () => {
    expect(css.slice(0, start)).not.toMatch(/\.maplibregl-ctrl/);
  });
});

// keep the unused-import linter honest: LegendChip is exercised by shell.test.tsx
void LegendChip;
