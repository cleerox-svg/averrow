// Phase 6 screen 3b: the facelifted Threats tab. Panel titles are sentence-case sans,
// the inflow chart and panels read theme tokens (no hex), and the shared ThreatsTable
// is keyboard-operable with token pills and 44px coarse targets.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreatsTable, type ThreatRow, type ThreatsTableState } from '@averrow/shared/threats-table';
import { PanelHeader } from './PanelHeader';

const FEATURE = resolve(__dirname);
const SHARED = resolve(__dirname, '..', '..', '..', '..', 'shared', 'src', 'threats-table');
const read = (p: string) => readFileSync(p, 'utf8');
const HEX = /#[0-9a-fA-F]{3,8}\b/;

describe('PanelHeader', () => {
  it('renders a sentence-case h2 on the h2 type scale, acronyms kept', () => {
    render(<PanelHeader title="TOP OF PILE ASN" subtitle="Where the pressure is concentrated" />);
    const h = screen.getByRole('heading', { level: 2 });
    expect(h).toHaveTextContent('Top of pile ASN');
    expect(h).toHaveClass('thr-panel-title');
    const css = read(resolve(FEATURE, 'threats.css'));
    const rule = css.slice(css.indexOf('.threats-v4 .thr-panel-title {'));
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/--type-h2-size/);
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/text-transform: none/);
  });
});

describe('Threats sources use tokens, not hex', () => {
  it.each(['Threats.tsx', 'ThreatInflowChart.tsx', 'MultiFeedConsensusPanel.tsx', 'PanelHeader.tsx', 'threats.css'])(
    '%s has no hex colour',
    (file) => {
      expect(read(resolve(FEATURE, file))).not.toMatch(HEX);
    },
  );

  it('ThreatInflowChart resolves its series colours from theme tokens at runtime', () => {
    const src = read(resolve(FEATURE, 'ThreatInflowChart.tsx'));
    expect(src).toMatch(/useTokenColors/);
    expect(src).toMatch(/'--chart-1'/);
    expect(src).not.toMatch(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0?\.\d+\)/);
    expect(src).not.toMatch(/FALLBACK_COLORS/);
  });

  it('the cards use the FACELIFT-gated flat variant and the old accent glow is gone', () => {
    expect(read(resolve(FEATURE, 'threatsCard.ts'))).toMatch(/FACELIFT \? 'flat' : 'base'/);
    const src = read(resolve(FEATURE, 'Threats.tsx'));
    expect(src).not.toMatch(/variant="active"/);
    expect(src).not.toMatch(/radial-gradient|textShadow/);
  });

  it('the dead Slicers / chips code is gone', () => {
    const src = read(resolve(FEATURE, 'Threats.tsx'));
    expect(src).not.toMatch(/SlicersBar|ActiveFilterChips/);
  });
});

const STATE: ThreatsTableState = {
  q: '', severity: '', type: '', status: '', brandId: '', country: '', sort: 'last_seen', dir: 'desc', page: 0,
};
const ROW: ThreatRow = {
  id: 't1', threat_type: 'phishing', malicious_domain: 'evil.example.com', malicious_url: null,
  ip_address: null, target_brand_id: 'b1', brand_name: 'Acme', source_feed: 'urlhaus',
  severity: 'high', status: 'false_positive',
};

function table(onToggleSort = vi.fn()) {
  return (
    <ThreatsTable
      columns={['target', 'severity', 'status']}
      rows={[ROW]}
      total={120}
      loading={false}
      state={STATE}
      pageSize={50}
      onFilter={vi.fn()}
      onSearch={vi.fn()}
      onToggleSort={onToggleSort}
      onPage={vi.fn()}
      sortKeys={{ target: 'target' }}
    />
  );
}

describe('ThreatsTable keyboard + labels', () => {
  it('a row expands from the keyboard (Enter and Space) via its expand button, and toggles once per press', async () => {
    const user = userEvent.setup();
    render(table());
    const btn = screen.getByRole('button', { name: 'Show evidence for evil.example.com' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Reputation')).not.toBeInTheDocument();
    btn.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Reputation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide evidence for evil.example.com' })).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(screen.queryByText('Reputation')).not.toBeInTheDocument();
  });

  it('a mouse click on the row still expands it', async () => {
    render(table());
    await userEvent.setup().click(screen.getByText('evil.example.com'));
    expect(screen.getByText('Reputation')).toBeInTheDocument();
  });

  it('sortable headers are buttons and sort through the th handler', async () => {
    const onSort = vi.fn();
    render(table(onSort));
    const btn = screen.getByRole('button', { name: /Domain \/ URL/ });
    btn.focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(onSort).toHaveBeenCalledWith('target');
  });

  it('severity and status render sentence case (display only)', () => {
    render(table());
    const t = within(screen.getByRole('table'));
    expect(t.getByText('High')).toBeInTheDocument();
    expect(t.getByText('False positive')).toBeInTheDocument();
  });
});

describe('threats-table.css facelift rules', () => {
  const css = read(resolve(SHARED, 'threats-table.css'));
  const block = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    expect(i, sel).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i));
  };

  it('the high / medium pills use --sev-*-text under [data-accent]', () => {
    expect(block(':root[data-accent] .tt-pill[data-tone="high"]')).toMatch(/color: var\(--sev-high-text\)/);
    expect(block(':root[data-accent] .tt-pill[data-tone="medium"]')).toMatch(/color: var\(--sev-medium-text\)/);
  });

  it('pager buttons get 44px coarse targets and 12px+ type; the info line is tabular', () => {
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse.slice(0, coarse.indexOf('\n}'))).toMatch(/\.tt-btn \{ min-height: 44px; min-width: 44px; \}/);
    expect(block(':root[data-accent] .tt-btn')).toMatch(/font-size: var\(--type-label-size, 12px\)/);
    expect(block(':root[data-accent] .tt-pager-info')).toMatch(/tabular-nums/);
  });

  it('labels are not uppercase mono, hovers use tokens (light darkens), selects follow the theme', () => {
    expect(block(':root[data-accent] .tt-th')).toMatch(/text-transform: none/);
    expect(block(':root[data-accent] .tt-pill')).toMatch(/text-transform: none/);
    expect(block(':root[data-accent] .tt-btn')).toMatch(/text-transform: none/);
    expect(block(':root[data-accent] .tt-row:hover,\n:root[data-accent] .tt-row[data-open="true"]')).toMatch(/var\(--bg-page\)/);
    expect(css).toMatch(/:root\[data-accent\]\[data-theme="light"\] \.tt-row:hover/);
    expect(block(':root[data-accent] .tt-select,\n:root[data-accent] .tt-search')).toMatch(/color-scheme: inherit/);
    expect(block(':root[data-accent] .tt-select,\n:root[data-accent] .tt-search')).not.toMatch(/rgba/);
  });

  it('keyboard focus shows the ring (light uses --text-primary)', () => {
    expect(css).toMatch(/\.tt-expand:focus-visible[\s\S]*outline: 2px solid var\(--focus-ring\)/);
    expect(css).toMatch(/\[data-theme="light"\] \.tt-expand:focus-visible[\s\S]*outline-color: var\(--text-primary\)/);
  });
});
