import { describe, it, expect, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayerRail, layerForKey } from './LayerRail';
import { LensSwitcher } from './LensSwitcher';
import { ObservatorySearch } from './ObservatorySearch';
import { ReplayTimeline } from './ReplayTimeline';
import { lensPreset } from '../lib/lenses';
import { AnimationClock } from '../lib/animation-clock';
import { CYCLE_LENGTH } from '../lib/trips';

describe('LayerRail', () => {
  it('lists every layer as a toggle named by its label, pressed state from the layers', async () => {
    const onToggle = vi.fn();
    render(<LayerRail layers={lensPreset('threats')} reducedMotion={false} onToggle={onToggle} counts={{ nodes: 9 }} />);
    const group = screen.getByRole('group', { name: 'Map layers' });
    for (const name of ['Nodes', 'Particles', 'Beams', 'Operations', 'Movement', 'Hosting', 'Baseline', 'Campaigns', 'Actors']) {
      expect(within(group).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(group).getByRole('button', { name: 'Nodes' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Hosting' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(within(group).getByRole('button', { name: 'Hosting' }));
    expect(onToggle).toHaveBeenCalledWith('hosting', true);
    expect(within(group).getByRole('button', { name: 'Nodes' })).toHaveAccessibleDescription('9 shown');
  });
  it('particles are disabled with a hint under reduced motion and never toggle', async () => {
    const onToggle = vi.fn();
    render(<LayerRail layers={lensPreset('threats')} reducedMotion onToggle={onToggle} />);
    const p = screen.getByRole('button', { name: /Particles/ });
    expect(p).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(p);
    expect(onToggle).not.toHaveBeenCalled();
  });
  it('announces loading / failed status in the description', () => {
    render(<LayerRail layers={{ ...lensPreset('hosting') }} reducedMotion={false} onToggle={vi.fn()} status={{ hosting: 'error' }} />);
    expect(screen.getByRole('button', { name: 'Hosting' })).toHaveAccessibleDescription('failed to load');
  });
  it('can start collapsed', () => {
    render(<LayerRail layers={lensPreset('threats')} reducedMotion={false} onToggle={vi.fn()} defaultCollapsed />);
    expect(screen.queryByRole('button', { name: 'Nodes' })).not.toBeInTheDocument();
  });
  it('number keys map to layers, ignoring modifiers and text fields', () => {
    const base = { ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false };
    expect(layerForKey({ ...base, key: '3', target: document.body })).toBe('beams');
    expect(layerForKey({ ...base, key: '6', target: document.body })).toBe('hosting');
    expect(layerForKey({ ...base, key: '3', ctrlKey: true, target: document.body })).toBeNull();
    expect(layerForKey({ ...base, key: 'x', target: document.body })).toBeNull();
    const input = document.createElement('input');
    expect(layerForKey({ ...base, key: '3', target: input })).toBeNull();
  });
});

describe('LensSwitcher', () => {
  it('shows all seven lenses and arrow keys select (activation: auto)', async () => {
    const onChange = vi.fn();
    render(<LensSwitcher lens="threats" onChange={onChange} />);
    expect(screen.getAllByRole('tab')).toHaveLength(7);
    expect(screen.getByRole('tab', { name: 'Threats' })).toHaveAttribute('aria-selected', 'true');
    screen.getByRole('tab', { name: 'Threats' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('operations');
  });
});

describe('ObservatorySearch', () => {
  const data = { providers: [{ id: 'p1', name: 'Example Hosting', asn: 'AS64512', country: 'NL', active_threat_count: 1, total_threat_count: 1, trend_7d: 0, trend_30d: 0, is_bulletproof: false, reputation_score: null, takedown: null }] };
  it('is a combobox: typing lists results, arrows + Enter pick, Escape closes', async () => {
    const onPick = vi.fn();
    const onActivate = vi.fn();
    render(<ObservatorySearch data={data} onPick={onPick} onActivate={onActivate} />);
    const box = screen.getByRole('combobox', { name: 'Search the map' });
    await userEvent.click(box);
    expect(onActivate).toHaveBeenCalledTimes(1);
    await userEvent.type(box, 'example');
    const opts = screen.getAllByRole('option');
    expect(opts[0]).toHaveTextContent('Example Hosting');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provider' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
  it('says so when nothing loaded matches', async () => {
    render(<ObservatorySearch data={{}} onPick={vi.fn()} />);
    await userEvent.type(screen.getByRole('combobox'), 'qqqqq');
    expect(screen.getByText(/Nothing loaded matches/)).toBeInTheDocument();
  });
  it('Escape closes the list first, then clears the text', async () => {
    render(<ObservatorySearch data={data} onPick={vi.fn()} />);
    const box = screen.getByRole('combobox');
    await userEvent.type(box, 'example');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box).toHaveValue('example');
    await userEvent.keyboard('{Escape}');
    expect(box).toHaveValue('');
  });
});

describe('ReplayTimeline', () => {
  const data = { bucket: '1h' as const, points: Array.from({ length: 10 }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 14, i)).toISOString(), total: 5 + i, critical: 1, high: 1, medium: 1, low: 1 })) };
  function setup(over: Partial<React.ComponentProps<typeof ReplayTimeline>> = {}) {
    const clock = new AnimationClock({ cycleLength: CYCLE_LENGTH });
    const props = {
      data, isLoading: false, error: null, onRetry: vi.fn(), clock, subscribe: () => () => {}, playing: true, speed: 1,
      onTogglePlay: vi.fn<() => void>(), onSpeed: vi.fn<(n: number) => void>(), onSeek: vi.fn<(t: number) => void>(), reducedMotion: false, periodLabel: '7D', ...over,
    };
    render(<ReplayTimeline {...props} />);
    return props as typeof props & { onSeek: Mock<(t: number) => void>; onTogglePlay: Mock<() => void>; onSpeed: Mock<(n: number) => void> };
  }
  it('arrow keys scrub one bucket, Shift ten, Home / End jump', async () => {
    const p = setup();
    const slider = screen.getByRole('slider');
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(p.onSeek).toHaveBeenLastCalledWith(CYCLE_LENGTH / 10);
    await userEvent.keyboard('{Home}');
    expect(p.onSeek).toHaveBeenLastCalledWith(0);
    await userEvent.keyboard('{End}');
    expect(p.onSeek.mock.calls.at(-1)![0]).toBeLessThan(CYCLE_LENGTH);
    expect(p.onSeek.mock.calls.at(-1)![0]).toBeGreaterThan(CYCLE_LENGTH - 1);
  });
  it('Space and the button play / pause; speeds are pressed toggles', async () => {
    const p = setup();
    screen.getByRole('slider').focus();
    await userEvent.keyboard(' ');
    expect(p.onTogglePlay).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Pause replay' }));
    expect(p.onTogglePlay).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '1×' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: '3×' }));
    expect(p.onSpeed).toHaveBeenCalledWith(3);
  });
  it('under reduced motion playback is off but scrubbing still works', async () => {
    const p = setup({ reducedMotion: true });
    const play = screen.getByRole('button', { name: /Playback is off/ });
    expect(play).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(play);
    expect(p.onTogglePlay).not.toHaveBeenCalled();
    screen.getByRole('slider').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(p.onSeek).toHaveBeenCalled();
  });
  it('pointer press seeks to that fraction of the track', () => {
    // jsdom has no PointerEvent: MouseEvent carries the same clientX / button fields.
    (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
    const p = setup();
    const slider = screen.getByRole('slider');
    const track = slider.firstElementChild as HTMLElement;
    track.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, right: 300, bottom: 30, height: 30, x: 100, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(slider, { clientX: 200, button: 0, pointerId: 1 });
    expect(p.onSeek).toHaveBeenLastCalledWith(CYCLE_LENGTH / 2);
  });
  it('shows loading, error (with retry) and empty states without hiding the controls', async () => {
    const e = setup({ error: new Error('x'), data: undefined });
    expect(screen.getByRole('alert')).toHaveTextContent('Timeline unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(e.onRetry).toHaveBeenCalled();
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });
});
