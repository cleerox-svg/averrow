import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { AiSpend } from './AiSpend';
import type { AiSpendPayload } from '@/hooks/useMetrics';

// Tier 4: AiSpend absorbed the standalone Cost Optimization tab — the
// per-agent grid now reads `by_agent[window]` (per-window, cost-sorted,
// top-20) instead of the 30d-only `by_agent_30d`, each row carries the
// server-computed `out_in_ratio`, and a collapsed-by-default
// "Cost-reduction levers" sub-section holds the cartographer trend +
// the static lever roster.

vi.mock('@/hooks/useMetrics', () => ({ useAiSpend: vi.fn() }));
vi.mock('recharts', () => ({
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  ComposedChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  Legend: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { useAiSpend } from '@/hooks/useMetrics';

function makePayload(): AiSpendPayload {
  return {
    windows: {
      '24h': { calls: 10, input_tokens: 1000, output_tokens: 500, cost_usd: 1.5 },
      '7d':  { calls: 70, input_tokens: 7000, output_tokens: 3500, cost_usd: 10.5 },
      '30d': { calls: 300, input_tokens: 30000, output_tokens: 15000, cost_usd: 45 },
    },
    by_agent_30d: [
      { agent_id: 'cartographer', calls: 200, input_tokens: 20000, output_tokens: 8000, cost_usd: 30 },
      { agent_id: 'analyst', calls: 100, input_tokens: 10000, output_tokens: 7000, cost_usd: 15 },
    ],
    by_agent: {
      '24h': [
        { agent_id: 'cartographer', calls: 6, input_tokens: 600, output_tokens: 200, cost_usd: 0.9, out_in_ratio: 0.33 },
        { agent_id: 'analyst', calls: 4, input_tokens: 400, output_tokens: 300, cost_usd: 0.6, out_in_ratio: 0.75 },
      ],
      '7d': [
        { agent_id: 'cartographer', calls: 42, input_tokens: 4200, output_tokens: 1400, cost_usd: 6.3, out_in_ratio: 0.33 },
        { agent_id: 'analyst', calls: 28, input_tokens: 2800, output_tokens: 2100, cost_usd: 4.2, out_in_ratio: 0.75 },
      ],
      '30d': [
        { agent_id: 'cartographer', calls: 200, input_tokens: 20000, output_tokens: 8000, cost_usd: 30, out_in_ratio: 0.4 },
        { agent_id: 'analyst', calls: 100, input_tokens: 10000, output_tokens: 7000, cost_usd: 15, out_in_ratio: 0.7 },
      ],
    },
    daily_30d: [
      { day: '2026-07-10', calls: 100, input_tokens: 10000, output_tokens: 5000, cost_usd: 15 },
      { day: '2026-07-11', calls: 200, input_tokens: 20000, output_tokens: 10000, cost_usd: 30 },
    ],
    cartographer_daily_30d: [
      { day: '2026-07-10', calls: 60, input_tokens: 6000, output_tokens: 2000, cost_usd: 9 },
      { day: '2026-07-11', calls: 140, input_tokens: 14000, output_tokens: 6000, cost_usd: 21 },
    ],
    generated_at: new Date().toISOString(),
  };
}

describe('AiSpend — merged cost view (Tier 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockSpend(data: AiSpendPayload) {
    (useAiSpend as ReturnType<typeof vi.fn>).mockReturnValue({
      data, isLoading: false, isError: false,
    });
  }

  it('renders the per-agent grid from by_agent[window] for the default (24h) window', () => {
    mockSpend(makePayload());
    renderWithProviders(<AiSpend />);

    // 24h window costs, not the legacy 30d figures.
    expect(screen.getByText('$0.90')).toBeInTheDocument();
    expect(screen.getByText('$0.60')).toBeInTheDocument();
    expect(screen.queryByText('$30.00')).not.toBeInTheDocument();
  });

  it('switches the per-agent grid to the selected window', async () => {
    mockSpend(makePayload());
    renderWithProviders(<AiSpend />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: '30d' }));

    expect(screen.getByText('$30.00')).toBeInTheDocument();
    expect(screen.getByText('$15.00')).toBeInTheDocument();
    expect(screen.queryByText('$0.90')).not.toBeInTheDocument();
  });

  it('shows out_in_ratio in the agent detail panel on expand', async () => {
    mockSpend(makePayload());
    renderWithProviders(<AiSpend />);
    const user = userEvent.setup();

    await user.click(screen.getByText('Cartographer'));

    expect(screen.getByText('Out:in ratio')).toBeInTheDocument();
    expect(screen.getByText('0.33')).toBeInTheDocument();
  });

  it('renders the Cost-reduction levers sub-section collapsed by default', () => {
    mockSpend(makePayload());
    renderWithProviders(<AiSpend />);

    const toggle = screen.getByRole('button', { name: /Cost-reduction levers/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Lever roster')).not.toBeInTheDocument();
  });

  it('expands the levers sub-section to reveal the cartographer trend + lever roster', async () => {
    mockSpend(makePayload());
    renderWithProviders(<AiSpend />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Cost-reduction levers/ }));

    expect(screen.getByText('Lever roster')).toBeInTheDocument();
    expect(screen.getByText('Cartographer · 30d trend')).toBeInTheDocument();
    // A couple of the static levers should be present.
    expect(screen.getByText(/output-schema tightening/)).toBeInTheDocument();
    expect(screen.getByText(/Message Batches API/)).toBeInTheDocument();
  });

  it('does not render a standalone Cost Optimization panel anymore', () => {
    mockSpend(makePayload());
    renderWithProviders(<AiSpend />);
    expect(screen.queryByText(/^Cost Optimization$/)).not.toBeInTheDocument();
  });
});
