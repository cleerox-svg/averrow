import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { TempoBand, tempoChipText } from './TempoBand';
import { computeTempo } from '@/lib/threat-tempo';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
import { api } from '@/lib/api';

const get = api.get as unknown as ReturnType<typeof vi.fn>;

function inflow(window: '24h' | '7d', totals: number[]) {
  return {
    window,
    buckets: totals.map((_, i) => `2026-10-03 ${String(i % 24).padStart(2, '0')}:00:00`),
    series: [{ threat_type: 'phishing', counts: totals, total: totals.reduce((s, n) => s + n, 0) }],
    total: totals.reduce((s, n) => s + n, 0),
    generated_at: '2026-10-03T12:00:00Z',
  };
}

/** 24h: [...23 quiet hours at `base`, last completed hour = current, partial]. */
function serve(current: number, baseline = 100) {
  get.mockImplementation(async (url: string) => {
    if (url === '/api/threats/inflow?window=24h') {
      return inflow('24h', [...new Array<number>(22).fill(baseline), current, 3]);
    }
    if (url === '/api/threats/inflow?window=7d') {
      return inflow('7d', [...new Array<number>(167).fill(baseline), 3]);
    }
    throw new Error(`unexpected url ${url}`);
  });
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter><TempoBand /></MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, ...utils };
}

describe('TempoBand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(true); // StatTile counts up unless reduced motion; settle instantly
  });

  it('shows the current hourly rate and a surge chip at >= 1.5x baseline', async () => {
    serve(180);
    const { container } = setup();
    expect(await screen.findByText('180')).toBeInTheDocument();
    const chip = container.querySelector('[data-tempo-state]')!;
    expect(chip).toHaveAttribute('data-tempo-state', 'surge');
    expect(chip).toHaveTextContent('1.8× baseline');
    expect(screen.getByText(/7d baseline 100\/hr/)).toBeInTheDocument();
  });

  it('shows a neutral chip around the baseline', async () => {
    serve(110);
    const { container } = setup();
    await screen.findByText('110');
    const chip = container.querySelector('[data-tempo-state]')!;
    expect(chip).toHaveAttribute('data-tempo-state', 'normal');
    expect(chip).toHaveTextContent('1.1× baseline');
  });

  it('reads "quiet" (not calm) below 0.5x baseline', async () => {
    serve(20);
    const { container } = setup();
    await screen.findByText('20');
    const chip = container.querySelector('[data-tempo-state]')!;
    expect(chip).toHaveAttribute('data-tempo-state', 'quiet');
    expect(chip).toHaveTextContent('quiet · 0.2× baseline');
  });

  it('a genuinely silent pipeline shows 0/hr and quiet, not a dash', async () => {
    get.mockImplementation(async (url: string) => (url.endsWith('24h')
      ? inflow('24h', new Array<number>(24).fill(0))
      : inflow('7d', new Array<number>(168).fill(0))));
    const { container } = setup();
    expect(await screen.findByText('0')).toBeInTheDocument();
    expect(container.querySelector('[data-tempo-state]')).toHaveAttribute('data-tempo-state', 'quiet');
    expect(container.querySelector('[data-tempo-state]')).toHaveTextContent('no ingest in 7d');
  });

  it('is loading (null value, aria-busy), never 0, until both windows land', () => {
    get.mockReturnValue(new Promise(() => {}));
    const { container } = setup();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('requests exactly the two inflow windows and shares the Threats query keys', async () => {
    serve(150);
    const { client } = setup();
    await screen.findByText('150');
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual([
      '/api/threats/inflow?window=24h',
      '/api/threats/inflow?window=7d',
    ]);
    // Same keys as ThreatInflowChart => one cache entry between Home and /threats.
    expect(client.getQueryData(['threats', 'inflow', '24h'])).toBeDefined();
    expect(client.getQueryData(['threats', 'inflow', '7d'])).toBeDefined();
  });

  it('a failed window is an error with retry, never a calm 0', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.endsWith('7d')) throw new Error('HTTP 500');
      return inflow('24h', [10, 10, 10]);
    });
    setup();
    expect(await screen.findByText("Couldn't load threat tempo")).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();

    serve(130);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('130')).toBeInTheDocument();
  });

  it('the error envelope is an error too', async () => {
    get.mockResolvedValue({ success: false, error: 'internal' });
    setup();
    await waitFor(() => expect(screen.getByText("Couldn't load threat tempo")).toBeInTheDocument());
  });
});

describe('tempoChipText', () => {
  const t = (h: number[], w: number[]) => {
    const mk = (totals: number[]) => ({
      buckets: totals.map((_, i) => String(i)),
      series: [{ threat_type: 'x', counts: totals, total: 0 }],
    });
    return computeTempo(mk(h), mk(w))!;
  };
  it('formats the ratio with one decimal', () => {
    expect(tempoChipText(t([200, 0], [...new Array<number>(100).fill(100), 0]))).toBe('2.0× baseline');
  });
  it('says the baseline is unavailable instead of inventing one', () => {
    expect(tempoChipText(t([200, 0], [1, 2, 0]))).toBe('baseline unavailable');
  });
});
