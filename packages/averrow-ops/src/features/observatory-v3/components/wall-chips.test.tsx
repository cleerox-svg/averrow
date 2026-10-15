import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ArcData } from '@/hooks/useObservatory';
import { BrandFilter, FilterChips, FILTERS_MUTED_NOTE, TypeMultiSelect } from './DataFilters';
import { ControlRail } from './ControlRail';
import { WallOverlay, WALL_EXIT_HIDE_MS } from './WallOverlay';
import { filterChips, withFallbackBrands, hasBrandIds } from '../lib/filters';
import { lensPreset } from '../lib/lenses';

afterEach(() => { vi.useRealTimers(); });

describe('filter chips: one row, with a +N overflow', () => {
  const chips = filterChips({ sev: ['critical', 'high'], type: ['phishing', 'c2'], brand: 'b_1' }, 'PayPal'); // 5 chips

  it('single row that scrolls sideways; extra chips fold into "+N"', async () => {
    render(<FilterChips chips={chips} onRemove={vi.fn()} onClear={vi.fn()} max={3} />);
    const group = screen.getByRole('group', { name: 'Active filters' });
    expect(group.className).toContain('flex-nowrap');
    expect(group.className).toContain('overflow-x-auto');
    expect(group.querySelectorAll('[data-chip]')).toHaveLength(3);
    const more = screen.getByRole('button', { name: 'Show 2 more active filters' });
    expect(more).toHaveTextContent('+2');
    await userEvent.click(more);
    expect(group.querySelectorAll('[data-chip]')).toHaveLength(5);
    expect(screen.queryByText('+2')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(group.querySelectorAll('[data-chip]')).toHaveLength(3);
  });

  it('a spent expansion does not linger: once the chips fit again the row is single-line, and the next overflow starts folded', async () => {
    const { rerender } = render(<FilterChips chips={chips} onRemove={vi.fn()} onClear={vi.fn()} max={3} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 more active filters' }));
    const group = screen.getByRole('group', { name: 'Active filters' });
    expect(group.className).toContain('flex-wrap');
    rerender(<FilterChips chips={chips.slice(0, 2)} onRemove={vi.fn()} onClear={vi.fn()} max={3} />);
    expect(screen.getByRole('group', { name: 'Active filters' }).className).toContain('flex-nowrap');
    rerender(<FilterChips chips={chips} onRemove={vi.fn()} onClear={vi.fn()} max={3} />);
    expect(screen.getByRole('group', { name: 'Active filters' }).className).toContain('flex-nowrap');
    expect(screen.getByRole('button', { name: 'Show 2 more active filters' })).toBeInTheDocument();
  });

  it('defaults to 2 on touch and 4 otherwise', () => {
    const { unmount } = render(<FilterChips chips={chips} onRemove={vi.fn()} onClear={vi.fn()} touch />);
    expect(document.querySelectorAll('[data-chip]')).toHaveLength(2);
    unmount();
    render(<FilterChips chips={chips} onRemove={vi.fn()} onClear={vi.fn()} />);
    expect(document.querySelectorAll('[data-chip]')).toHaveLength(4);
  });

  it('muted: chips stay removable but dim, with the "applies to Threats" note', async () => {
    const onRemove = vi.fn();
    render(<FilterChips chips={chips.slice(0, 2)} onRemove={onRemove} onClear={vi.fn()} muted mutedNote={FILTERS_MUTED_NOTE} />);
    const group = screen.getByRole('group', { name: 'Active filters' });
    expect(group).toHaveAttribute('data-muted');
    expect((group.querySelector('[data-chip]') as HTMLElement).style.opacity).toBe('0.55');
    expect(within(group).getByText('Applies to Threats')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Remove critical severity filter/ }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe('brand filter picks by id', () => {
  const arc = (id: string | undefined, name: string): ArcData => ({
    sourcePosition: [5, 52], targetPosition: [-100, 40], threat_type: 'phishing', severity: 'high', source_region: 'NL',
    target_brand: name, brand_name: name, volume: 3, ...(id ? { target_brand_id: id } : null),
  });

  it('onChange gets the id from the entry; brands without an id are not offered', async () => {
    const onChange = vi.fn();
    render(<BrandFilter brand={null} data={{ arcs: [arc('b_ing', 'ING'), arc(undefined, 'Ingress Legacy')] }} onChange={onChange} />);
    await userEvent.type(screen.getByRole('combobox'), 'ing');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    await userEvent.click(options[0]!);
    expect(onChange).toHaveBeenCalledWith({ id: 'b_ing', name: 'ING' });
  });
});

describe('brand filter while the cached arcs carry no brand ids (right after a deploy)', () => {
  const legacyArc = (name: string): ArcData => ({
    sourcePosition: [5, 52], targetPosition: [-100, 40], threat_type: 'phishing', severity: 'high', source_region: 'NL',
    target_brand: name, brand_name: name, volume: 3,
  });
  const top = [{ id: 'b_pp', name: 'PayPal', threat_count: 40 }, { id: 'b_ing', name: 'ING', threat_count: 9 }];

  it('is offered the top brands instead of an empty list, and picking one reports its id', async () => {
    const arcs = [legacyArc('PayPal')];
    expect(hasBrandIds(arcs)).toBe(false);
    const onChange = vi.fn();
    render(<BrandFilter brand={null} data={{ arcs: withFallbackBrands(arcs, top) }} onChange={onChange} />);
    await userEvent.type(screen.getByRole('combobox'), 'pay');
    await userEvent.click(screen.getAllByRole('option')[0]!);
    expect(onChange).toHaveBeenCalledWith({ id: 'b_pp', name: 'PayPal' });
  });

  it('does not repeat a brand whose id the arcs already carry, and returns the arcs untouched when nothing is added', () => {
    const withId: ArcData = { ...legacyArc('PayPal'), target_brand_id: 'b_pp' };
    const merged = withFallbackBrands([withId], top)!;
    expect(merged.filter(a => a.target_brand_id === 'b_pp')).toHaveLength(1);
    expect(merged.filter(a => a.target_brand_id === 'b_ing')).toHaveLength(1);
    const arcs = [withId];
    expect(withFallbackBrands(arcs, [top[0]!])).toBe(arcs);
    expect(withFallbackBrands(arcs, undefined)).toBe(arcs);
    expect(withFallbackBrands(arcs, 'nope' as never)).toBe(arcs);
  });

  it('says "Loading brands…" instead of the empty-looking hint while the data that would supply them loads', () => {
    const { rerender } = render(<BrandFilter brand={null} data={{}} onChange={vi.fn()} loading />);
    expect(screen.getByText('Loading brands…')).toBeInTheDocument();
    rerender(<BrandFilter brand={null} data={{}} onChange={vi.fn()} />);
    expect(screen.queryByText('Loading brands…')).toBeNull();
  });
});

describe('phone filters card', () => {
  it('threat types are one column on touch (labels do not truncate), two otherwise', () => {
    const { container, rerender } = render(<TypeMultiSelect types={[]} onChange={vi.fn()} touch />);
    expect(container.querySelector('.grid')!.className).toContain('grid-cols-1');
    rerender(<TypeMultiSelect types={[]} onChange={vi.fn()} />);
    expect(container.querySelector('.grid')!.className).toContain('grid-cols-2');
  });

  it('ControlRail can split severity from the rest, so severity can sit next to Type', () => {
    const base = {
      lens: 'threats' as const, layers: lensPreset('threats'), view: 'points' as const, measure: 'index' as const, colorBy: 'severity' as const,
      reducedMotion: false, onLayers: vi.fn(), onView: vi.fn(), onMeasure: vi.fn(), onColorBy: vi.fn(), sev: [], onSev: vi.fn(), layout: 'panel' as const,
    };
    const { unmount } = render(<ControlRail {...base} part="severity" />);
    expect(screen.getByRole('group', { name: 'Severity filter' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Threat traffic underneath' })).toBeNull();
    unmount();
    render(<ControlRail {...base} part="rest" />);
    expect(screen.queryByRole('group', { name: 'Severity filter' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Threat traffic underneath' })).toBeInTheDocument();
  });
});

describe('wall overlay', () => {
  const props = { periodLabel: '7D', threats: 12345, countries: 87, operations: null, loadFailed: false, phone: false, onExit: vi.fn(), zIndex: 22 };

  it('headline numbers with a period label and a live indicator', () => {
    render(<WallOverlay {...props} operations={14} />);
    const group = screen.getByRole('group', { name: 'Headline numbers, 7D' });
    expect(within(group).getByText('Threats')).toBeInTheDocument();
    expect(within(group).getByText('Countries')).toBeInTheDocument();
    expect(within(group).getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('7D')).toBeInTheDocument();
    // the numbers are at least 32px
    const css = document.querySelector('style')!.textContent!;
    expect(css).toMatch(/clamp\(32px/);
    expect(screen.getByTestId('map-attribution')).toBeInTheDocument();
  });

  it('custom tiles replace the defaults (bot-share scene), with their sub-line', () => {
    render(<WallOverlay {...props} tiles={[{ label: 'Global bot share', value: '31.2%' }, { label: 'Most automated', value: '62.0%', sub: 'Peru (PE)' }]} />);
    const group = screen.getByRole('group', { name: 'Headline numbers, 7D' });
    expect(within(group).getByText('Global bot share')).toBeInTheDocument();
    expect(within(group).getByText('Peru (PE)')).toBeInTheDocument();
    expect(within(group).queryByText('Threats')).toBeNull();
    expect(within(group).queryByText('Countries')).toBeNull();
  });

  it('operations are shown only when available', () => {
    render(<WallOverlay {...props} />);
    expect(screen.queryByText('Operations')).toBeNull();
  });

  it('the exit button is 12px+, --text-secondary, hidden until the pointer moves, then fades out again', () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    render(<WallOverlay {...props} onExit={onExit} />);
    const btn = screen.getByRole('button', { name: 'Exit wall screen' });
    expect(btn.className).toContain('text-xs'); // 12px
    expect(btn.style.color).toBe('var(--text-secondary)');
    expect(btn.style.opacity).toBe('0');
    expect(btn.style.pointerEvents).toBe('none');
    act(() => { window.dispatchEvent(new Event('pointermove')); });
    expect(btn.style.opacity).toBe('1');
    expect(btn.style.pointerEvents).toBe('auto');
    act(() => { vi.advanceTimersByTime(WALL_EXIT_HIDE_MS + 10); });
    expect(btn.style.opacity).toBe('0');
    act(() => { btn.focus(); });
    expect(btn.style.opacity).toBe('1');
    btn.click();
    expect(onExit).toHaveBeenCalled();
  });
});
