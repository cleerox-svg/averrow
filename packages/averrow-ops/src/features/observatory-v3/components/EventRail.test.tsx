import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useState } from 'react';

const fetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ api: { fetch: (...a: unknown[]) => fetchMock(...a) } }));

import { EventRail, type EventRailProps } from './EventRail';
import { eventsKey } from '@/hooks/useObservatoryEvents';
import { useObservatoryUrlState } from '../lib/url-state';
import type { EventKind, EventPeriod, EventsResult, ObservatoryEvent } from '../lib/events';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ev = (id: string, kind: EventKind, min: number, over: Partial<ObservatoryEvent> = {}): ObservatoryEvent => ({
  id, kind, severity: kind === 'critical' ? 'critical' : 'high', title: `Title ${id}`, entity: { type: 'domain', id, name: id },
  place: { country_code: 'NL', country_name: 'Netherlands', lat: 52, lng: 5 }, count: 1, occurred_at: ago(min),
  source: kind === 'critical' ? 'sentinel' : 'nexus', target: { lens: 'threats', select: 'country:NL' }, ...over,
});
const DATA = [ev('c1', 'critical', 5), ev('o1', 'operation', 20), ev('f1', 'fast', 30), ev('l1', 'lookalike', 50)];
const envelope = (data: ObservatoryEvent[], meta: Record<string, unknown> = {}, counts: Record<string, number> = { critical: 14, operation: 3, fast: 1, lookalike: 22 }) =>
  ({ success: true, data, counts_by_kind: counts, meta: { generated_at: null, period: '1h', omitted_kinds: ['takedown'], capped_kinds: [], failed_kinds: [], ...meta } });

let qc: QueryClient;
let search = '';
function Loc() { search = useLocation().search; return null; }

/** The rail wired exactly as the page wires it: kinds come from, and go to, the URL. */
const onClose = vi.fn();
function UrlHarness({ onOpenEvent }: { onOpenEvent: EventRailProps['onOpenEvent'] }) {
  const { state, update } = useObservatoryUrlState();
  const [period, setPeriod] = useState<EventPeriod>('1h');
  return <EventRail period={period} onPeriod={setPeriod} kinds={state.ev} onKinds={ev => update({ ev })} onOpenEvent={onOpenEvent} onClose={onClose} placement="embedded" />;
}
function renderRail(path = '/observatory', onOpenEvent: EventRailProps['onOpenEvent'] = vi.fn()) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Loc />
        <UrlHarness onOpenEvent={onOpenEvent} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const urls = () => fetchMock.mock.calls.map(c => c[0] as string);

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    const kinds = new URL(url, 'http://x').searchParams.get('kinds');
    const data = kinds ? DATA.filter(e => kinds.split(',').includes(e.kind)) : DATA;
    return Promise.resolve(envelope(data));
  });
  search = '';
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('groups and rows', () => {
  it('groups by age: last 15 min, 15–45 min, older, newest first', async () => {
    renderRail();
    await screen.findByText('Title c1');
    const heads = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(heads).toEqual(['Last 15 min', '15–45 min', 'Older']);
    const recent = screen.getByRole('region', { name: 'Last 15 min' });
    expect(within(recent).getByText('Title c1')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '15–45 min' })).getAllByRole('button').map(b => b.getAttribute('data-event-id'))).toEqual(['o1', 'f1']);
    expect(within(screen.getByRole('region', { name: 'Older' })).getByText('Title l1')).toBeInTheDocument();
  });

  it('a row shows the title, a kind chip, a severity word, "via source" and the age', async () => {
    renderRail();
    const row = (await screen.findByText('Title c1')).closest('button')!;
    expect(within(row).getByText('CRITICAL')).toBeInTheDocument(); // the shared EventChip, not a raw lowercase token
    expect(row).toHaveTextContent('Critical · via Sentinel');
    expect(row).toHaveTextContent('5m');
    const op = screen.getByText('Title o1').closest('button')!;
    expect(within(op).getByText('OPERATION')).toBeInTheDocument();
    expect(op).toHaveTextContent('High · via NEXUS');
  });

  it('sets the leading entity name bold when the title starts with it', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(envelope([
      ev('b1', 'critical', 5, { title: 'Acme Bank targeted by 12 new phishing pages', entity: { type: 'brand', id: 'b1', name: 'Acme Bank' } }),
      ev('b2', 'fast', 6, { title: 'Unrelated sentence', entity: { type: 'brand', id: 'b2', name: 'Acme Bank' } }),
    ])));
    renderRail();
    const lead = await screen.findByText('Acme Bank');
    expect(lead.tagName).toBe('STRONG');
    expect(screen.getByText('Unrelated sentence').querySelector('strong')).toBeNull();
  });

  it('the close button returns to Intel', async () => {
    onClose.mockClear();
    renderRail();
    await screen.findByText('Title c1');
    fireEvent.click(screen.getByRole('button', { name: 'Close events, back to Intel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking a row hands the event to the page', async () => {
    const open = vi.fn();
    renderRail('/observatory', open);
    fireEvent.click((await screen.findByText('Title o1')).closest('button')!);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1', kind: 'operation' }));
  });

  it('empty feed says so; a failed request offers a retry', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(envelope([])));
    const { unmount } = renderRail();
    expect(await screen.findByText('No new threat events in the past hour or so')).toBeInTheDocument();
    unmount();
    qc.clear();
    fetchMock.mockImplementation(() => Promise.resolve({ success: false, error: 'down' }));
    renderRail();
    expect(await screen.findByText('Failed to load events')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('says which kinds could not be loaded when the feed is partial', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(envelope(DATA, { failed_kinds: ['lookalike'] })));
    renderRail();
    expect(await screen.findByText(/Partial feed\. Lookalikes could not be loaded\./)).toBeInTheDocument();
    expect(screen.getByText('Title c1')).toBeInTheDocument();
  });

  it('a flashing row keeps its flash (no restart) when it changes time group, and loses it after the flash length', async () => {
    renderRail();
    await screen.findByText('Title c1');
    const next: EventsResult = {
      events: [ev('c2', 'critical', 14.9), ...DATA], counts: {},
      meta: { generated_at: null, period: '1h', omitted_kinds: ['takedown'], capped_kinds: [], failed_kinds: [] },
    };
    act(() => { qc.setQueryData(eventsKey('1h', [], 40), next); });
    await waitFor(() => expect(document.querySelectorAll('.ev-row-new')).toHaveLength(1));
    const row = document.querySelector('.ev-row-new') as HTMLElement;
    expect(row.getAttribute('data-event-id')).toBe('c2');
    // Resumes at its elapsed time on a remount: the style carries a negative delay, never a fresh start.
    expect(row.style.animationDelay).toMatch(/^-?\d+ms$/);
    // (only Date is faked here, so the real flash timer runs out on its own)
    await waitFor(() => expect(document.querySelectorAll('.ev-row-new')).toHaveLength(0), { timeout: 3_000 });
  });

  it('a row that arrives later flashes once; the rows already there do not', async () => {
    renderRail();
    await screen.findByText('Title c1');
    expect(document.querySelectorAll('.ev-row-new')).toHaveLength(0);
    const next: EventsResult = {
      events: [ev('c2', 'critical', 1), ...DATA], counts: {},
      meta: { generated_at: null, period: '1h', omitted_kinds: ['takedown'], capped_kinds: [], failed_kinds: [] },
    };
    act(() => { qc.setQueryData(eventsKey('1h', [], 40), next); });
    await waitFor(() => expect(screen.getByText('Title c2')).toBeInTheDocument());
    const flashing = [...document.querySelectorAll('.ev-row-new')].map(n => n.getAttribute('data-event-id'));
    expect(flashing).toEqual(['c2']);
  });
});

describe('kind filter', () => {
  it('shows a chip per kind with its count, minus the kinds this role cannot see', async () => {
    renderRail();
    const group = await screen.findByRole('group', { name: 'Filter events by kind' });
    await waitFor(() => expect(within(group).getByRole('button', { name: /Critical/ })).toHaveTextContent('14'));
    const names = within(group).getAllByRole('button').map(b => b.textContent?.replace(/\d+$/, ''));
    // The count is records, not items: the chip says so in its title and name.
    const crit = within(group).getByRole('button', { name: /^Critical/ });
    expect(crit).toHaveAttribute('title', '14 critical records in 1 item');
    expect(crit).toHaveAttribute('aria-label', 'Critical: 14 critical records in 1 item');
    expect(names).toEqual(['All', 'Critical', 'Operations', 'Fast', 'Lookalikes', 'Actors', 'Spikes']);
    expect(within(group).queryByRole('button', { name: /Takedowns/ })).toBeNull();
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a manager sees the Takedowns chip', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(envelope(DATA, { omitted_kinds: [] }, { takedown: 2 })));
    renderRail();
    expect(await screen.findByRole('button', { name: /Takedowns/ })).toBeInTheDocument();
  });

  it('round-trips through the URL: pick, request with kinds, reload from the link', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = renderRail();
    await screen.findByText('Title c1');
    await user.click(screen.getByRole('button', { name: /^Critical/ }));
    await user.click(screen.getByRole('button', { name: /^Fast/ }));
    await waitFor(() => expect(search).toContain('ev=critical%2Cfast'));
    await waitFor(() => expect(urls()).toContain('/api/observatory/events?period=1h&kinds=critical%2Cfast&limit=40'));
    await waitFor(() => expect(screen.queryByText('Title o1')).toBeNull());
    expect(screen.getByText('Title f1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Fast/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    // The count chips keep showing the unfiltered totals.
    expect(screen.getByRole('button', { name: /^Lookalikes/ })).toHaveTextContent('22');
    unmount();

    // Opening the same link restores the filter.
    renderRail('/observatory?ev=critical,fast');
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Critical/ }).at(-1)).toHaveAttribute('aria-pressed', 'true'));
  });

  it('All clears the filter and the URL key; toggling a chip off removes just that kind', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRail('/observatory?ev=critical,fast');
    await screen.findByText('Title c1');
    await user.click(screen.getByRole('button', { name: /^Critical/ }));
    await waitFor(() => expect(search).toContain('ev=fast'));
    expect(search).not.toContain('critical');
    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(search).not.toContain('ev='));
  });

  it('a link naming a kind this role cannot see is corrected, and that kind is never requested', async () => {
    renderRail('/observatory?ev=takedown,fast');
    await waitFor(() => expect(search).toBe('?ev=fast'));
    await waitFor(() => expect(urls().some(u => u.includes('kinds=fast'))).toBe(true));
    expect(urls().some(u => u.includes('takedown'))).toBe(false);
  });

  it('a link naming only withheld kinds falls back to every kind', async () => {
    renderRail('/observatory?ev=takedown');
    await waitFor(() => expect(search).not.toContain('ev='));
    expect(await screen.findByText('Title c1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so when a kind has nothing in the period', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(envelope(new URL(url, 'http://x').searchParams.get('kinds') ? [] : DATA)));
    renderRail('/observatory?ev=actor');
    expect(await screen.findByText('No actors events in the past hour or so')).toBeInTheDocument();
  });
});

describe('period', () => {
  it('switches between 1h, 24h and 7d, each with its own request', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRail();
    await screen.findByText('Title c1');
    const radios = within(screen.getByRole('radiogroup', { name: 'Event period' })).getAllByRole('radio');
    expect(radios.map(r => r.textContent)).toEqual(['1h', '24h', '7d']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    await user.click(radios[1]!);
    await waitFor(() => expect(urls()).toContain('/api/observatory/events?period=24h&limit=100'));
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Events · 24H');
    await user.click(radios[2]!);
    await waitFor(() => expect(urls()).toContain('/api/observatory/events?period=7d&limit=100'));
  });

  it('the period radios are a roving radio group: arrows (and Home / End) move and select, focus follows', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRail();
    await screen.findByText('Title c1');
    const radios = within(screen.getByRole('radiogroup', { name: 'Event period' })).getAllByRole('radio');
    expect(radios.map(r => r.tabIndex)).toEqual([0, -1, -1]);
    radios[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    expect(radios[2]).toHaveFocus();
    await user.keyboard('{ArrowRight}'); // wraps
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(radios[2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(radios[0]).toHaveFocus();
    expect(radios.map(r => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it('the 1h view asks for exactly the warmed request', async () => {
    renderRail();
    await screen.findByText('Title c1');
    expect(urls()).toEqual(['/api/observatory/events?period=1h&limit=40']);
  });
});
