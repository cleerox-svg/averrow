import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { FeedFailures } from './FeedFailures';
import type { FeedFailurePayload, FeedFailureRow } from '@/hooks/useMetrics';

vi.mock('@/hooks/useMetrics', () => ({ useFeedFailures: vi.fn() }));

import { useFeedFailures } from '@/hooks/useMetrics';

function makeRow(overrides: Partial<FeedFailureRow> = {}): FeedFailureRow {
  return {
    feed_name: 'certstream',
    display_name: 'CertStream',
    enabled: true,
    paused_reason: null,
    pulls: 20,
    success: 5,
    failed: 15,
    partial: 0,
    failure_rate_pct: 75,
    records_ingested: 10,
    last_success_at: null,
    last_failure_at: null,
    consecutive_failures: 4,
    threshold: 5,
    // >= 80 -> feedRiskTier 'critical' -> included in the default
    // at-risk-only grid without needing the "Show all" toggle.
    pct_to_auto_pause: 85,
    verdict: { tone: 'failed', label: 'FAILED' },
    ...overrides,
  };
}

function makePayload(rows: FeedFailureRow[]): FeedFailurePayload {
  return {
    totals_24h: { total_pulls: 20, total_success: 5, total_failed: 15, total_records: 10, feeds_active: 1 },
    per_feed: rows,
    recent_errors: [],
    generated_at: new Date().toISOString(),
  };
}

describe('FeedFailures — FeedRiskCard keyboard access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockFeeds(rows: FeedFailureRow[]) {
    (useFeedFailures as ReturnType<typeof vi.fn>).mockReturnValue({
      data: makePayload(rows),
      isLoading: false,
      isError: false,
    });
  }

  it('renders the at-risk card as a focusable, expandable button', () => {
    mockFeeds([makeRow()]);
    renderWithProviders(<FeedFailures />);

    const card = screen.getByRole('button', { name: /Expand CertStream details/i });
    expect(card).toHaveAttribute('tabIndex', '0');
    expect(card).toHaveAttribute('aria-expanded', 'false');
  });

  it('Enter key expands the card — same effect as a click', async () => {
    mockFeeds([makeRow()]);
    renderWithProviders(<FeedFailures />);

    const card = screen.getByRole('button', { name: /Expand CertStream details/i });
    card.focus();
    expect(card).toHaveFocus();

    await userEvent.keyboard('{Enter}');

    // Detail panel (FeedRiskDetail) mounts on expand — "24h pulls" stat
    // label is unique to that panel.
    expect(screen.getByText('24h pulls')).toBeInTheDocument();
    expect(card).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Collapse CertStream details/i })).toBe(card);
  });

  it('Space key toggles the same expand/collapse handler as Enter and click', async () => {
    mockFeeds([makeRow()]);
    renderWithProviders(<FeedFailures />);

    const card = screen.getByRole('button', { name: /Expand CertStream details/i });
    card.focus();

    await userEvent.keyboard(' ');
    expect(card).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('24h pulls')).toBeInTheDocument();

    // Space again collapses it — proves it's the same toggle handler as
    // click, not a one-way keyboard shortcut.
    await userEvent.keyboard(' ');
    expect(card).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('24h pulls')).not.toBeInTheDocument();
  });

  it('a plain click produces the exact same expanded state as Enter', async () => {
    mockFeeds([makeRow()]);
    const user = userEvent.setup();
    renderWithProviders(<FeedFailures />);

    const card = screen.getByRole('button', { name: /Expand CertStream details/i });
    await user.click(card);

    expect(card).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('24h pulls')).toBeInTheDocument();
  });

  it('other keys (e.g. Tab, ArrowDown) do not toggle the card', async () => {
    mockFeeds([makeRow()]);
    renderWithProviders(<FeedFailures />);

    const card = screen.getByRole('button', { name: /Expand CertStream details/i });
    card.focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(card).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('24h pulls')).not.toBeInTheDocument();
  });
});
