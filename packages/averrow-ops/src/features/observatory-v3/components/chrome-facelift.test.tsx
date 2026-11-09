// Facelift Phase 6, screens 6a (top bar, lens strip, legends, stats bar, map controls) and 6b (panels, drawer, event rail,
// headline bar, replay timeline, wall overlay).
// Source guards (no raw colours, no sub-12px type, no capitals-with-tracking, no glow) + the behaviour they protect.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LensStrip } from './LensStrip';
import { ControlRail } from './ControlRail';
import { lensPreset } from '../lib/lenses';
import userEvent from '@testing-library/user-event';
import { DataFiltersPopover } from './DataFilters';
import { FiltersPopover } from './ToolbarControls';
import { BODY, FACT, LABEL } from '../lib/chrome-classes';
import { TYPE_OPTIONS } from '../lib/filters';
import { typeDisplayLabel, SEVERITY_COLORS, rgbCss } from '../lib/map-colors';
import { PeekSheet } from './PeekSheet';

const HERE = __dirname;
const V3 = resolve(HERE, '..');
const SRC = resolve(HERE, '../../..');
const read = (p: string) => readFileSync(p, 'utf8');

const SCOPE_FILES = [
  'ToolbarControls.tsx', 'LensStrip.tsx', 'DataFilters.tsx', 'ObservatorySearch.tsx', 'LegendChip.tsx',
  'LensLegend.tsx', 'ProjectionToggle.tsx', 'MapAttribution.tsx', 'ControlRail.tsx',
].map(f => resolve(HERE, f)).concat(resolve(V3, 'lib/chrome-classes.ts'));

/** 6b: the panels and the bars along the bottom. ObservatoryV3.tsx is guarded whole (every 6a and 6b region of it is clean). */
const PANEL_FILES = [
  'DrillDrawer.tsx', 'SidePanel.tsx', 'LensPanel.tsx', 'EventRail.tsx', 'EventChip.tsx', 'HeadlineBar.tsx', 'PeekSheet.tsx',
  'PanelDock.tsx', 'PanelTabs.tsx', 'PanelErrorBoundary.tsx', 'ReplayTimeline.tsx', 'WallOverlay.tsx',
].map(f => resolve(HERE, f));

describe('chrome source guards (6a + 6b)', () => {
  const sources: Array<[string, string]> = [
    ...SCOPE_FILES.map(f => [f.split('/').pop()!, read(f)] as [string, string]),
    ...PANEL_FILES.map(f => [f.split('/').pop()!, read(f)] as [string, string]),
    ['ObservatoryV3.tsx (whole file)', read(resolve(V3, 'ObservatoryV3.tsx'))],
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
      it('has no uppercase / capitalize class or letter-spaced capitals', () => {
        const joined = code.join('\n');
        expect(joined).not.toMatch(/(^|[\s"'`])(uppercase|capitalize)\b/);
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

describe('LensStrip paging chevrons', () => {
  it('are flex siblings of the scroller, not laid over it, so no tab text can sit beneath one', () => {
    const proto = HTMLElement.prototype;
    const saved = ['offsetWidth', 'offsetLeft', 'clientWidth', 'scrollWidth'].map(k => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    const isTab = (el: HTMLElement) => el.getAttribute('role') === 'tab';
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return isTab(this) ? 100 : 300; } });
    Object.defineProperty(proto, 'offsetLeft', { configurable: true, get(this: HTMLElement) { return isTab(this) ? Array.from(this.parentElement!.children).indexOf(this) * 103 : 0; } });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.getAttribute('role') === 'tablist' ? 252 : 300; } });
    Object.defineProperty(proto, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return this.getAttribute('role') === 'tablist' ? 721 : 300; } });
    try {
      render(<LensStrip lens="threats" onChange={() => {}} />);
      const strip = screen.getByRole('tablist');
      const chevron = document.querySelector('button[aria-hidden="true"]') as HTMLElement;
      expect(chevron).not.toBeNull();
      expect(chevron.className).not.toMatch(/\babsolute\b/);
      expect(strip.contains(chevron)).toBe(false);
      expect(strip.parentElement!.contains(chevron)).toBe(true);
    } finally {
      for (const [k, d] of saved) { if (d) Object.defineProperty(proto, k, d); else delete (proto as unknown as Record<string, unknown>)[k]; }
    }
  });
  it('the source has no absolutely positioned chevron', () => {
    expect(read(resolve(HERE, 'LensStrip.tsx'))).not.toMatch(/absolute top-0 bottom-0/);
  });
});

describe('ControlRail severity items', () => {
  it('show only the severity word, in the button and in the rail tooltip; the aria-label keeps the prefix', () => {
    render(<ControlRail lens="threats" layers={lensPreset('threats')} view="points" measure="index" colorBy="severity" reducedMotion={false}
      onLayers={() => {}} onView={() => {}} onMeasure={() => {}} onColorBy={() => {}} sev={[]} onSev={() => {}} />);
    const b = screen.getByRole('button', { name: 'Severity: Critical' });
    expect(b.parentElement!.textContent).not.toContain('Severity:');
    expect(b.parentElement!.textContent).toContain('Critical');
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
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it('a press on a focusable target keeps the focus it moved there', async () => {
    render(<div><button type="button">outside</button><DataFiltersPopover count={0}><button type="button">First</button></DataFiltersPopover></div>);
    await userEvent.click(screen.getByRole('button', { name: 'Data filters' }));
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    await new Promise(r => setTimeout(r, 10));
    expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus();
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

describe('panels and bars (6b)', () => {
  const css = read(resolve(SRC, 'index.css'));

  it('the live dot is static: no looping animation is attached to it', () => {
    expect(css).not.toMatch(/animation:\s*ev-live[^;]*infinite/);
    expect(css).not.toContain('@keyframes ev-live');
    const rule = css.match(/\.ev-live-dot\s*\{[^}]*\}/)![0];
    expect(rule).not.toMatch(/animation|box-shadow/);
  });
  it('the headline countdown stays (it has pause + reduced-motion handling)', () => {
    expect(css).toContain('@keyframes ev-progress');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[^}]*\.ev-progress/);
  });
  it('no chrome file loops a pulse or draws a glow', () => {
    for (const f of PANEL_FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/animate-pulse|animate-ping|animate-spin/);
      expect(src, f).not.toMatch(/boxShadow:\s*'0 0 \d/);
      expect(src, f).not.toMatch(/textShadow/);
    }
  });
  it('the replay histogram uses the map severity colours, with no glow on the playhead', () => {
    const src = read(resolve(HERE, 'ReplayTimeline.tsx'));
    expect(src).toContain("from '../lib/map-colors'");
    expect(src).toMatch(/rgbCss\(SEVERITY_COLORS\.critical/);
    expect(src).not.toMatch(/boxShadow/);
    expect(rgbCss(SEVERITY_COLORS.critical!)).toBe('rgb(200, 60, 60)');
  });
  it('touch targets follow the pointer, not the viewport width', () => {
    for (const f of ['DrillDrawer.tsx', 'EventRail.tsx', 'LensPanel.tsx', 'SidePanel.tsx', 'ReplayTimeline.tsx']) {
      expect(read(resolve(HERE, f)), f).not.toMatch(/max-\[899px\]|\bsm:min-h-/);
    }
  });
  it('the peek sheet casts the elevated card shadow, never the flat one', () => {
    render(<PeekSheet open onClose={() => {}} label="Test sheet"><div>content</div></PeekSheet>);
    const sheet = screen.getByRole('dialog', { name: 'Test sheet' });
    expect(sheet.style.boxShadow).toBe('var(--card-shadow-elevated)');
  });
  it('the panel tab strip lifts the kit 11px tab to 12px and keeps its names', () => {
    const src = read(resolve(HERE, 'PanelTabs.tsx'));
    expect(src).toContain('!text-[12px]');
  });
});
