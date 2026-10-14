import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LensPanel } from './LensPanel';
import type { PanelSection } from '../lib/panel-rows';

const section: PanelSection = {
  title: 'Top operations',
  empty: 'none',
  more: 7,
  rows: [
    { key: 'a', primary: 'Alpha', badge: 'shared cert', secondary: '3 countries · 90% conf · a-very-long-actor-name-that-would-truncate', trailing: '120', linked: true, target: { kind: 'country', code: 'US' } },
    { key: 'b', primary: 'Beta', badge: 'same ASN', secondary: '2 countries', trailing: '4', target: { kind: 'country', code: 'DE' } },
  ],
};

describe('LensPanel (operations rows)', () => {
  const view = () => render(<LensPanel lens="operations" section={section} loading={false} error={false} onRetry={vi.fn()} onSelect={vi.fn()} placement="sheet" />);

  it('shows the evidence tier as its own badge, apart from the (truncating) secondary line', () => {
    view();
    expect(screen.getByText('shared cert')).toBeInTheDocument();
    expect(screen.getByText('same ASN')).toBeInTheDocument();
    expect(screen.getByText(/3 countries · 90% conf/)).toBeInTheDocument();
  });
  it('marks only the linked rows, in text for assistive tech too', () => {
    view();
    expect(screen.getAllByText('links drawn on the map')).toHaveLength(1);
  });
  it('says how many operations the list does not show', () => {
    view();
    expect(screen.getByText('+7 more — search or filter')).toBeInTheDocument();
  });
  it('no "more" row when nothing is hidden', () => {
    render(<LensPanel lens="operations" section={{ ...section, more: undefined }} loading={false} error={false} onRetry={vi.fn()} onSelect={vi.fn()} placement="sheet" />);
    expect(screen.queryByText(/more — search or filter/)).not.toBeInTheDocument();
  });
});
