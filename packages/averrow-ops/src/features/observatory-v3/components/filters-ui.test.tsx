import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlRail } from './ControlRail';
import { FilterChips, TypeMultiSelect } from './DataFilters';
import { ProjectionToggle } from './ProjectionToggle';
import { lensPreset } from '../lib/lenses';
import { filterChips } from '../lib/filters';

const railProps = {
  lens: 'threats' as const, layers: lensPreset('threats'), view: 'points' as const, measure: 'index' as const, colorBy: 'severity' as const,
  reducedMotion: false, onLayers: vi.fn(), onView: vi.fn(), onMeasure: vi.fn(), onColorBy: vi.fn(),
};

describe('ControlRail severity chips', () => {
  it('critical / high / medium / low are toggles; none pressed = all severities', () => {
    render(<ControlRail {...railProps} sev={[]} onSev={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Severity filter' });
    const btns = within(group).getAllByRole('button');
    expect(btns.map(b => b.getAttribute('aria-label'))).toEqual(['Severity: Critical', 'Severity: High', 'Severity: Medium', 'Severity: Low']);
    expect(btns.every(b => b.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('pressing one selects it; pressing a pressed one removes it', async () => {
    const onSev = vi.fn();
    const { rerender } = render(<ControlRail {...railProps} sev={[]} onSev={onSev} />);
    await userEvent.click(screen.getByRole('button', { name: 'Severity: High' }));
    expect(onSev).toHaveBeenLastCalledWith(['high']);
    rerender(<ControlRail {...railProps} sev={['critical', 'high']} onSev={onSev} />);
    expect(screen.getByRole('button', { name: 'Severity: High' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Severity: High' }));
    expect(onSev).toHaveBeenLastCalledWith(['critical']);
    await userEvent.click(screen.getByRole('button', { name: 'Severity: Low' }));
    expect(onSev).toHaveBeenLastCalledWith(['critical', 'high', 'low']);
  });

  it('no handler, no chips (other callers are unchanged)', () => {
    render(<ControlRail {...railProps} />);
    expect(screen.queryByRole('group', { name: 'Severity filter' })).toBeNull();
  });

  it('on a phone the same chips render as labelled rows', () => {
    render(<ControlRail {...railProps} layout="panel" sev={['low']} onSev={vi.fn()} />);
    expect(screen.getByText('Severity filter')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Severity: Low' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('active filter chips', () => {
  const chips = filterChips({ sev: ['critical'], type: ['phishing'], brand: 'b_1' }, 'PayPal');

  it('each value is a chip with its own remove button', async () => {
    const onRemove = vi.fn();
    render(<FilterChips chips={chips} onRemove={onRemove} onClear={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Active filters' });
    expect(within(group).getByText('Critical')).toBeInTheDocument();
    expect(within(group).getByText('Phishing')).toBeInTheDocument();
    expect(within(group).getByText('PayPal')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove phishing type filter' }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ kind: 'type', value: 'phishing' }));
  });

  it('the brand chip says it applies to arcs and stats; "Clear all" appears with two or more', async () => {
    const onClear = vi.fn();
    render(<FilterChips chips={chips} onRemove={vi.fn()} onClear={onClear} />);
    expect(screen.getByText(/applies to arcs and stats/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClear).toHaveBeenCalled();
  });

  it('renders nothing with no filters, and no Clear all for a single chip', () => {
    const { container, rerender } = render(<FilterChips chips={[]} onRemove={vi.fn()} onClear={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FilterChips chips={chips.slice(0, 1)} onRemove={vi.fn()} onClear={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });
});

describe('TypeMultiSelect', () => {
  it('checkboxes for the API\'s threat types; ticking adds, unticking removes', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<TypeMultiSelect types={[]} onChange={onChange} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(10);
    await userEvent.click(screen.getByRole('checkbox', { name: /phishing/i }));
    expect(onChange).toHaveBeenLastCalledWith(['phishing']);
    rerender(<TypeMultiSelect types={['c2', 'phishing']} onChange={onChange} />);
    expect(screen.getByRole('checkbox', { name: /phishing/i })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: /phishing/i }));
    expect(onChange).toHaveBeenLastCalledWith(['c2']);
  });
});

describe('Projection toggle: a visible label, not icon-only', () => {
  it('desktop: reads "Flat | Globe" with the G hint; the current projection is lit', () => {
    render(<ProjectionToggle projection="globe" onToggle={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Globe view' });
    expect(btn).toHaveTextContent('Flat');
    expect(btn).toHaveTextContent('Globe');
    expect(btn).toHaveTextContent('G');
    expect(btn).toHaveAttribute('aria-keyshortcuts', 'G');
    expect(btn.title).toMatch(/\(G\)/);
  });
  it('touch keeps the plain 44px icon', () => {
    render(<ProjectionToggle projection="flat" onToggle={vi.fn()} touch />);
    expect(screen.getByRole('button')).not.toHaveTextContent('Flat');
  });
});
