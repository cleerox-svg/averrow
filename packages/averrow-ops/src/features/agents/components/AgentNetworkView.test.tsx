// Network view: shared hover between the canvas and the tape, the
// reduced-motion path (no frames, no particles), the frame loop pausing when
// the tab is hidden, and the empty / error timeline states.

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { AgentNetworkView } from './AgentNetworkView';
import {
  AGENTS_FIXTURE, FEEDS_FIXTURE, TIMELINE_FIXTURE,
} from '../network/fixtures';
import { computeLayout, placeAgents } from '../network/model';
import { buildTapeLanes, tapeGeometry } from '../network/tape';
import { indexTimeline } from '../network/activity';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
import { api } from '@/lib/api';
const get = api.get as unknown as ReturnType<typeof vi.fn>;

// ── canvas stub: a 2D context that records arcs ───────────────────────
const arcs: number[][] = [];
function stubContext(): CanvasRenderingContext2D {
  const base: Record<string, unknown> = {
    measureText: (t: string) => ({ width: t.length * 6 }),
    arc: (...a: number[]) => { arcs.push(a); },
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
    set: (t, k, v) => { t[k as string] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}
/** Particle cores are the only arcs drawn with radius 2.2. */
const particleArcs = () => arcs.filter((a) => a[2] === 2.2).length;

let frames: Array<() => void> = [];
let reduced = false;

function installMatchMedia() {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('reduce'),
    media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function mockApi(timeline: 'ok' | 'error' | 'empty' = 'ok') {
  get.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/feeds/overview')) return { success: true, data: FEEDS_FIXTURE };
    if (path.startsWith('/api/agents/timeline')) {
      if (timeline === 'error') return { success: false, error: 'boom' };
      if (timeline === 'empty') {
        return { success: true, data: { ...TIMELINE_FIXTURE, runs: [], pulls: [], events: [] } };
      }
      return { success: true, data: TIMELINE_FIXTURE };
    }
    return { success: true, data: [] };
  });
}

function pointer(el: Element, x: number, y: number, type = 'pointermove') {
  fireEvent(el, new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

beforeEach(() => {
  arcs.length = 0;
  frames = [];
  reduced = false;
  installMatchMedia();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => stubContext());
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(() => cb(0));
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  mockApi('ok');
});
afterEach(() => { vi.restoreAllMocks(); });

const renderView = (onSelect = vi.fn(), selected: string | null = null) =>
  renderWithProviders(<AgentNetworkView agents={AGENTS_FIXTURE} selectedAgent={selected} onSelect={onSelect} />);

const flow = () => screen.getByTestId('flow-canvas');
const flowCanvas = () => flow().querySelector('canvas') as HTMLCanvasElement;
const tapeCanvas = async () => (await screen.findByTestId('run-tape')).querySelector('canvas') as HTMLCanvasElement;
const runFrame = () => act(() => { frames.shift()?.(); });

describe('AgentNetworkView', () => {
  it('draws the structure immediately and the tape once the timeline arrives', async () => {
    renderView();
    expect(flowCanvas()).toBeInTheDocument();
    expect(await tapeCanvas()).toBeInTheDocument();
  });

  it('lists every canvas agent and its state in text for screen readers', async () => {
    renderView();
    await tapeCanvas();
    const list = screen.getByRole('list', { name: 'Agents and their current state', hidden: true });
    expect(list).toHaveTextContent('Sentinel: idle');
    await waitFor(() => expect(list).toHaveTextContent('Cartographer: running'));
    expect(list).toHaveTextContent('Attributor: last run failed');
  });

  it('collapses retired agents behind a chip and lists on-demand agents in a rail', async () => {
    const onSelect = vi.fn();
    renderView(onSelect);
    await tapeCanvas();
    expect(screen.queryByText('Brand Report')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retired \(10\)/ }));
    const retiredChip = await screen.findAllByRole('button');
    expect(retiredChip.length).toBeGreaterThan(10);
    fireEvent.click(screen.getByRole('button', { name: 'Pathfinder' }));
    expect(onSelect).toHaveBeenCalledWith('pathfinder');
  });

  it('click on a canvas node selects that agent', async () => {
    const onSelect = vi.fn();
    renderView(onSelect);
    await tapeCanvas();
    const layout = computeLayout({
      width: 1000, placement: placeAgents(AGENTS_FIXTURE), feeds: FEEDS_FIXTURE, labelOf: (id) => id,
    });
    const n = layout.nodes.observer!;
    pointer(flowCanvas(), n.x, n.y, 'click');
    expect(onSelect).toHaveBeenCalledWith('observer');
  });

  describe('shared hover', () => {
    it('lights the tape lane when a canvas node is hovered', async () => {
      renderView();
      const tape = await tapeCanvas();
      const layout = computeLayout({
        width: 1000, placement: placeAgents(AGENTS_FIXTURE), feeds: FEEDS_FIXTURE, labelOf: (id) => id,
      });
      const n = layout.nodes.nexus!;
      pointer(flowCanvas(), n.x, n.y);
      expect(screen.getByTestId('agent-network')).toHaveAttribute('data-hover', 'nexus');
      expect(flow()).toHaveAttribute('data-hover', 'nexus');
      expect(tape.parentElement).toHaveAttribute('data-hover', 'nexus');
      fireEvent(flowCanvas(), new MouseEvent('pointerout', { bubbles: true }));
      expect(screen.getByTestId('agent-network')).toHaveAttribute('data-hover', '');
    });

    it('lights the canvas node when a tape bar is hovered', async () => {
      renderView();
      const tape = await tapeCanvas();
      const placement = placeAgents(AGENTS_FIXTURE);
      const index = indexTimeline(TIMELINE_FIXTURE, FEEDS_FIXTURE);
      const { lanes } = buildTapeLanes(placement, index, (id) => id);
      const li = lanes.findIndex((l) => l.id === 'sparrow');
      const g = tapeGeometry(1000, lanes.length, Date.parse(TIMELINE_FIXTURE.generated_at));
      pointer(tape, g.gx + 5, g.top + li * g.lh + g.lh / 2);
      expect(flow()).toHaveAttribute('data-hover', 'sparrow');
      expect(tape.parentElement).toHaveAttribute('data-hover', 'sparrow');
    });

    it('maps a feed dot to its group lane on the tape', async () => {
      renderView();
      const tape = await tapeCanvas();
      const layout = computeLayout({
        width: 1000, placement: placeAgents(AGENTS_FIXTURE), feeds: FEEDS_FIXTURE, labelOf: (id) => id,
      });
      const dot = layout.dots.find((d) => d.name === 'reddit')!;
      pointer(flowCanvas(), dot.x, dot.y);
      expect(tape.parentElement).toHaveAttribute('data-hover', 'feeds:social');
    });
  });

  describe('motion', () => {
    it('animates and draws particles while an upstream run is live', async () => {
      renderView();
      await tapeCanvas();
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));
      arcs.length = 0;
      runFrame();
      expect(particleArcs()).toBeGreaterThan(0);
    });

    it('under reduced motion requests no frames and draws no particles', async () => {
      reduced = true;
      installMatchMedia();
      renderView();
      await tapeCanvas();
      // Let the timeline-driven redraw settle, then check nothing animates.
      await waitFor(() => expect(arcs.length).toBeGreaterThan(0));
      expect(frames).toHaveLength(0);
      expect(window.requestAnimationFrame).not.toHaveBeenCalled();
      expect(particleArcs()).toBe(0);
    });

    it('stops the frame loop while the tab is hidden', async () => {
      renderView();
      await tapeCanvas();
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));
      const before = (window.requestAnimationFrame as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      frames = [];
      const calls = () => (window.requestAnimationFrame as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      const afterHide = calls();
      await new Promise((r) => setTimeout(r, 20));
      expect(calls()).toBe(afterHide);
      expect(afterHide).toBeGreaterThanOrEqual(before);
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    });
  });

  describe('timeline states', () => {
    it('draws the map and says the timeline is unavailable on error, without particles', async () => {
      mockApi('error');
      renderView();
      expect(await screen.findByText(/Live timeline unavailable/)).toBeInTheDocument();
      expect(flowCanvas()).toBeInTheDocument();
      expect(screen.getByTestId('run-tape-empty')).toHaveTextContent('Run timeline unavailable');
      expect(frames).toHaveLength(0);
      expect(particleArcs()).toBe(0);
    });

    it('shows a quiet note when nothing ran in the last hour', async () => {
      mockApi('empty');
      renderView();
      expect(await screen.findByText(/No agent runs or feed pulls in the last hour/)).toBeInTheDocument();
    });
  });
});
