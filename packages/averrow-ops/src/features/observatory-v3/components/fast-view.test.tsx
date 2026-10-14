import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ControlRail, type ControlRailProps } from './ControlRail';
import { SourceSelect } from './ToolbarControls';
import { ReplayTimeline } from './ReplayTimeline';
import { VelocitySection } from './LensLegend';
import { lensPreset } from '../lib/lenses';
import { AnimationClock } from '../lib/animation-clock';
import { CYCLE_LENGTH } from '../lib/trips';
import { buildVelocityModel, VELOCITY_FILLING } from '../lib/lens/velocity';

const railProps = (over: Partial<ControlRailProps> = {}): ControlRailProps => ({
  lens: 'threats', layers: lensPreset('threats'), view: 'points', measure: 'index', colorBy: 'severity', reducedMotion: false,
  onLayers: vi.fn(), onView: vi.fn(), onMeasure: vi.fn(), onColorBy: vi.fn(), ...over,
});

describe('ControlRail: Fast weaponization view', () => {
  it('is the third Threats view, announced and wired', async () => {
    const onView = vi.fn();
    render(<ControlRail {...railProps({ onView })} />);
    const view = screen.getByRole('group', { name: 'Threats view' });
    const btn = within(view).getByRole('button', { name: 'Fast weaponization' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(onView).toHaveBeenCalledWith('fast');
    expect(screen.getByRole('status')).toHaveTextContent('Threats view: fast weaponization');
  });
  it('is its own picture: the threat-traffic controls do not apply (like Heat)', () => {
    render(<ControlRail {...railProps({ view: 'fast' })} />);
    expect(screen.getByRole('button', { name: 'Fast weaponization' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('group', { name: 'Threat traffic underneath' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Beams' })).not.toBeInTheDocument();
  });
  it('phone panel layout labels it in full', () => {
    render(<ControlRail {...railProps({ layout: 'panel' })} />);
    expect(screen.getByRole('button', { name: 'Fast weaponization' })).toHaveTextContent('Fast weaponization');
  });
});

describe('SourceSelect with no source split', () => {
  it('shows All sources, is disabled and says why', () => {
    const onChange = vi.fn();
    render(<SourceSelect source="feeds" onChange={onChange} disabledReason="Fast weaponization is always all sources" />);
    const select = screen.getByRole('combobox', { name: 'Source' });
    expect(select).toBeDisabled();
    expect(select).toHaveValue('all');
    expect(select).toHaveAccessibleDescription('Fast weaponization is always all sources');
  });
  it('is a normal select otherwise', () => {
    render(<SourceSelect source="feeds" onChange={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: 'Source' });
    expect(select).toBeEnabled();
    expect(select).toHaveValue('feeds');
  });
});

describe('ReplayTimeline velocity series', () => {
  const vdata = {
    bucket: '1h' as const,
    points: Array.from({ length: 6 }, (_, i) => ({
      t: new Date(Date.UTC(2026, 9, 14, i)).toISOString(), total: i + 1, critical: 0, high: 0, medium: 0, low: 0, very_fast: i, fast: 1,
    })),
  };
  function setup(over: Partial<React.ComponentProps<typeof ReplayTimeline>> = {}) {
    const clock = new AnimationClock({ cycleLength: CYCLE_LENGTH });
    const subscribe = vi.fn(() => () => {});
    render(
      <ReplayTimeline
        data={vdata} isLoading={false} error={null} onRetry={vi.fn()} clock={clock} subscribe={subscribe} playing speed={1}
        onTogglePlay={vi.fn()} onSpeed={vi.fn()} onSeek={vi.fn()} reducedMotion={false} periodLabel="7D" series="velocity" {...over}
      />,
    );
    return { subscribe };
  }
  it('is a labelled still chart: no transport, no playhead, no slider', () => {
    const { subscribe } = setup();
    expect(screen.getByRole('group', { name: 'Fast weaponization timeline' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Fast weaponization, 7D: 21 threats/ })).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /replay/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Replay speed' })).not.toBeInTheDocument();
    expect(subscribe).not.toHaveBeenCalled(); // nothing follows the clock
  });
  it('keys the two classes in text', () => {
    setup();
    expect(screen.getByText(/very fast \(≤ 24h\)/)).toBeInTheDocument();
    expect(screen.getByText(/fast \(≤ 72h\)/)).toBeInTheDocument();
  });
  it('an all-zero series says coverage is still filling, not "no activity"', () => {
    setup({ data: { bucket: '1h', points: vdata.points.map(p => ({ ...p, total: 0, very_fast: 0, fast: 0 })) } });
    expect(screen.getByText(/Coverage still filling/)).toBeInTheDocument();
    expect(screen.queryByText('No activity in this period')).not.toBeInTheDocument();
  });
  it('the default series is unchanged (a slider with transport)', () => {
    setup({ series: undefined });
    expect(screen.getByRole('slider')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Replay timeline' })).toBeInTheDocument();
  });
});

describe('VelocitySection (legend)', () => {
  const q = { isLoading: false, error: null, refetch: vi.fn() };
  const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
  it('explains the two classes, size and the always-all-sources rule, with counts', () => {
    const model = buildVelocityModel([
      { lat: 1, lng: 2, threat_count: 9, country_code: 'NL', very_fast: 6, fast: 3, precision: 'country' },
      { lat: 3, lng: 4, threat_count: 2, country_code: 'US', very_fast: 0, fast: 2, precision: 'country' },
    ], 5);
    wrap(<VelocitySection s={{ model, q }} />);
    expect(screen.getByText(/Very fast: live within 24h/)).toBeInTheDocument();
    expect(screen.getByText(/Fast: live within 72h/)).toBeInTheDocument();
    expect(screen.getByText(/2 countries · 11 threats/)).toBeInTheDocument();
    expect(screen.getByText(/Always all sources/)).toBeInTheDocument();
    expect(screen.getByText(/5 without a placeable country not shown/)).toBeInTheDocument();
  });
  it('an empty model is "coverage still filling", never "none"', () => {
    wrap(<VelocitySection s={{ model: buildVelocityModel([]), q }} />);
    expect(screen.getByRole('status')).toHaveTextContent(VELOCITY_FILLING);
  });
  it('loading and error states', () => {
    wrap(<VelocitySection s={{ model: null, q: { ...q, isLoading: true } }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading fast weaponization…');
  });
});
