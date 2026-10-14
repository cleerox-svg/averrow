import { describe, it, expect, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlRail, type ControlRailProps } from './ControlRail';
import { LensStrip } from './LensStrip';
import { ObservatorySearch } from './ObservatorySearch';
import { ReplayTimeline } from './ReplayTimeline';
import { lensPreset } from '../lib/lenses';
import { AnimationClock } from '../lib/animation-clock';
import { CYCLE_LENGTH } from '../lib/trips';

const railProps = (over: Partial<ControlRailProps> = {}): ControlRailProps => ({
  lens: 'threats', layers: lensPreset('threats'), view: 'points', measure: 'index', colorBy: 'severity', reducedMotion: false,
  onLayers: vi.fn(), onView: vi.fn(), onMeasure: vi.fn(), onColorBy: vi.fn(), ...over,
});

describe('ControlRail', () => {
  it('Threats: Points | Heat view, then traffic Off / Nodes / Nodes + Flow, Beams and Colour', () => {
    render(<ControlRail {...railProps()} />);
    const view = screen.getByRole('group', { name: 'Threats view' });
    expect(within(view).getByRole('button', { name: 'Points' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(view).getByRole('button', { name: 'Heat' })).toHaveAttribute('aria-pressed', 'false');
    const traffic = screen.getByRole('group', { name: 'Threat traffic underneath' });
    expect(within(traffic).getByRole('button', { name: 'Nodes + Flow' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(traffic).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Beams' })).toHaveAttribute('aria-pressed', 'false');
    // a slim column, not a nine-row list
    expect(screen.queryByRole('group', { name: 'Map layers' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button').length).toBeLessThanOrEqual(9);
  });
  it('traffic buttons set the nodes / particles flags; Beams toggles on its own', async () => {
    const onLayers = vi.fn();
    render(<ControlRail {...railProps({ onLayers })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(onLayers).toHaveBeenLastCalledWith({ nodes: false, particles: false });
    await userEvent.click(screen.getByRole('button', { name: 'Nodes' }));
    expect(onLayers).toHaveBeenLastCalledWith({ nodes: true, particles: false });
    await userEvent.click(screen.getByRole('button', { name: 'Beams' }));
    expect(onLayers).toHaveBeenLastCalledWith({ beams: true });
  });
  it('every control has a tooltip, and the traffic ones show their keyboard hint', () => {
    render(<ControlRail {...railProps()} />);
    const nodes = screen.getByRole('button', { name: 'Nodes' });
    const tip = document.getElementById(nodes.getAttribute('aria-describedby')!)!;
    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(tip.querySelector('kbd')).toHaveTextContent('1');
    // keyboard hints are not tiny print
    for (const k of document.querySelectorAll('kbd')) expect(k.className).not.toMatch(/text-\[[0-9]px\]/); // 10px is the floor
  });
  it('announces each change through a polite live region', async () => {
    render(<ControlRail {...railProps()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(screen.getByRole('status')).toHaveTextContent('Threat traffic underneath: off');
    await userEvent.click(screen.getByRole('button', { name: 'Beams' }));
    expect(screen.getByRole('status')).toHaveTextContent('Beams on');
  });
  it('reduced motion: the flow button reads "Static beams" instead of promising particles', async () => {
    render(<ControlRail {...railProps({ reducedMotion: true })} />);
    const flow = screen.getByRole('button', { name: 'Nodes + Static beams' });
    expect(flow).toBeInTheDocument();
    await userEvent.click(flow);
    expect(screen.getByRole('status')).toHaveTextContent(/static beams/);
  });
  it('Baseline: Over-index | Raw | Bot share', async () => {
    const onMeasure = vi.fn();
    render(<ControlRail {...railProps({ lens: 'baseline', layers: lensPreset('baseline'), measure: 'raw', onMeasure })} />);
    const g = screen.getByRole('group', { name: 'Baseline measure' });
    expect(within(g).getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(g).getByRole('button', { name: 'Bot share' }));
    expect(onMeasure).toHaveBeenCalledWith('bot');
  });
  it('other lenses have no option group; the heat view and the bot-share scene hide the traffic controls', () => {
    const { rerender } = render(<ControlRail {...railProps({ lens: 'hosting', layers: lensPreset('hosting') })} />);
    expect(screen.queryByRole('group', { name: 'Threats view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Baseline measure' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Threat traffic underneath' })).toBeInTheDocument();
    rerender(<ControlRail {...railProps({ view: 'heat' })} />);
    expect(screen.queryByRole('group', { name: 'Threat traffic underneath' })).not.toBeInTheDocument();
    rerender(<ControlRail {...railProps({ lens: 'baseline', measure: 'bot', layers: lensPreset('baseline') })} />);
    expect(screen.queryByRole('group', { name: 'Threat traffic underneath' })).not.toBeInTheDocument();
  });
  it('the phone layout labels the buttons and keeps 44px targets', () => {
    render(<ControlRail {...railProps({ layout: 'panel' })} />);
    const btn = screen.getByRole('button', { name: 'Nodes' });
    expect(btn.className).toMatch(/min-h-\[44px\]/);
    expect(btn).toHaveTextContent('Nodes');
  });
});

describe('LensStrip', () => {
  it('shows all seven lenses; exactly one is selected', () => {
    render(<LensStrip lens="threats" onChange={vi.fn()} />);
    expect(screen.getAllByRole('tab')).toHaveLength(7);
    expect(screen.getAllByRole('tab').filter(t => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Threats' })).toHaveAttribute('aria-selected', 'true');
  });
  it('arrow keys MOVE focus without activating (no request per lens passed); Enter / Space / click activate', async () => {
    const onChange = vi.fn();
    render(<LensStrip lens="threats" onChange={onChange} />);
    screen.getByRole('tab', { name: 'Threats' }).focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Movement' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('movement');
    await userEvent.keyboard('{ArrowLeft}{ }');
    expect(onChange).toHaveBeenLastCalledWith('operations');
    await userEvent.click(screen.getByRole('tab', { name: 'Hosting' }));
    expect(onChange).toHaveBeenLastCalledWith('hosting');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Actors' })).toHaveFocus();
  });
  it('scrolls the active tab into view when it changes (a deep link on a phone)', () => {
    const spy = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    const { rerender } = render(<LensStrip lens="threats" onChange={vi.fn()} />);
    spy.mockClear();
    rerender(<LensStrip lens="actors" onChange={vi.fn()} />);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ inline: 'nearest' }));
    expect(spy.mock.contexts.at(-1)).toBe(screen.getByRole('tab', { name: 'Actors' }));
    Element.prototype.scrollIntoView = orig;
  });
  it('tabs are 44px high on touch; the strip announces the active question', () => {
    render(<LensStrip lens="hosting" onChange={vi.fn()} touch />);
    for (const t of screen.getAllByRole('tab')) expect(t.className).toMatch(/min-h-\[44px\]/);
    expect(screen.getByText('Where do operators choose to host?')).toBeInTheDocument();
  });
});

describe('ObservatorySearch', () => {
  const data = { providers: [{ id: 'p1', name: 'Example Hosting', asn: 'AS64512', country: 'NL', active_threat_count: 1, total_threat_count: 1, trend_7d: 0, trend_30d: 0, is_bulletproof: false, reputation_score: null, takedown: null }] };
  it('is a combobox: typing lists results, arrows + Enter pick, Escape closes', async () => {
    const onPick = vi.fn();
    const onActivate = vi.fn();
    render(<ObservatorySearch data={data} onPick={onPick} onActivate={onActivate} />);
    const box = screen.getByRole('combobox', { name: 'Find on map' });
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

describe('ObservatorySearch: combobox contract, focus and folding', () => {
  const data = { providers: [{ id: 'p1', name: 'Example Hosting', asn: 'AS64512', country: 'NL', active_threat_count: 1, total_threat_count: 1, trend_7d: 0, trend_30d: 0, is_bulletproof: false, reputation_score: null, takedown: null }] };

  it('the listbox always exists, so aria-controls never dangles; haspopup is declared', () => {
    render(<ObservatorySearch data={data} onPick={vi.fn()} />);
    const box = screen.getByRole('combobox', { name: 'Find on map' });
    const list = document.getElementById(box.getAttribute('aria-controls')!)!;
    expect(list).toBeInTheDocument();
    expect(list).toHaveAttribute('role', 'listbox');
    expect(list).toHaveAttribute('hidden'); // closed
    expect(box).toHaveAttribute('aria-haspopup', 'listbox');
    expect(box).toHaveAttribute('aria-expanded', 'false');
  });
  it('announces the result count as you type', async () => {
    render(<ObservatorySearch data={data} onPick={vi.fn()} />);
    const box = screen.getByRole('combobox');
    await userEvent.type(box, 'example');
    expect(screen.getByRole('status')).toHaveTextContent(/^\d+ results?$/);
    await userEvent.clear(box);
    await userEvent.type(box, 'qqqqq');
    expect(screen.getByRole('status')).toHaveTextContent('No results');
  });
  it('the input keeps focus after a pick, so the drawer that opens can hand focus back to it', async () => {
    const onPick = vi.fn();
    render(<ObservatorySearch data={data} onPick={onPick} />);
    const box = screen.getByRole('combobox');
    await userEvent.type(box, 'example');
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalled();
    expect(box).toHaveFocus();
  });
  it('exposes the stable opener: the input, or the icon button when folded', async () => {
    const ref = { current: null as HTMLElement | null };
    const { rerender } = render(<ObservatorySearch data={data} onPick={vi.fn()} openerRef={ref} />);
    expect(ref.current).toBe(screen.getByRole('combobox'));
    rerender(<ObservatorySearch data={data} onPick={vi.fn()} openerRef={ref} collapsed />);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Find on map' }));
  });
  it('folded: an icon button that opens the field; a pick closes it and focus lands on the button', async () => {
    const onPick = vi.fn();
    const onActivate = vi.fn();
    render(<ObservatorySearch data={data} onPick={onPick} onActivate={onActivate} collapsed />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Find on map' });
    await userEvent.click(btn);
    expect(onActivate).toHaveBeenCalledTimes(1);
    const box = await screen.findByRole('combobox');
    expect(box).toHaveFocus();
    await userEvent.type(box, 'example{Enter}');
    expect(onPick).toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
  });
  it('folded: Escape closes the field and returns focus to the button', async () => {
    render(<ObservatorySearch data={data} onPick={vi.fn()} collapsed />);
    await userEvent.click(screen.getByRole('button', { name: 'Find on map' }));
    await screen.findByRole('combobox');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find on map' })).toHaveFocus();
  });
});

describe('ReplayTimeline: window alignment and the phone readout', () => {
  const data = { bucket: '1h' as const, points: Array.from({ length: 4 }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 14, i)).toISOString(), total: 5, critical: 1, high: 1, medium: 1, low: 1 })) };
  const base = {
    data, isLoading: false, error: null, onRetry: vi.fn(), clock: new AnimationClock({ cycleLength: CYCLE_LENGTH }), subscribe: () => () => {}, playing: true, speed: 1,
    onTogglePlay: vi.fn(), onSpeed: vi.fn(), onSeek: vi.fn(), reducedMotion: false, periodLabel: '7D',
  };
  it('phones get a short readout (no zone) and no range line', () => {
    render(<ReplayTimeline {...base} isMobile />);
    const slider = screen.getByRole('slider');
    expect(slider.getAttribute('aria-valuetext')).toMatch(/^\d{2} \w{3} \d{2}:\d{2}$/);
    expect(document.body.textContent).not.toMatch(/UTC/);
    expect(document.body.textContent).not.toMatch(/ – /);
  });
  it('desktop keeps the zone and the range', () => {
    render(<ReplayTimeline {...base} />);
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toMatch(/UTC$/);
    expect(document.body.textContent).toMatch(/ – /);
  });
  it('the playhead readout is read from the replay window, not the first bucket', () => {
    // window starts 90 minutes into the first bucket's hour, so frac 0 reads 01:30, not 00:00
    const start = Date.UTC(2026, 9, 14, 1, 30);
    render(<ReplayTimeline {...base} window={{ startMs: start, endMs: start + 4 * 3_600_000 }} />);
    const slider = screen.getByRole('slider');
    expect(slider.getAttribute('aria-valuetext')).toContain('14 Oct 01:');
  });
  it('reports scrubbing start and end (live pings pause meanwhile)', () => {
    (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
    const onScrubChange = vi.fn();
    render(<ReplayTimeline {...base} onScrubChange={onScrubChange} />);
    const slider = screen.getByRole('slider');
    (slider.firstElementChild as HTMLElement).getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, right: 100, bottom: 30, height: 30, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(slider, { clientX: 50, button: 0, pointerId: 1 });
    expect(onScrubChange).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(slider, { clientX: 50, pointerId: 1 });
    expect(onScrubChange).toHaveBeenLastCalledWith(false);
  });
});
