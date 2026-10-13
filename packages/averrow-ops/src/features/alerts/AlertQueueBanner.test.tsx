import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlertQueueBanner, formatSpan, type AlertQueueBannerProps } from './AlertQueueBanner';

function setup(over: Partial<AlertQueueBannerProps> = {}) {
  const cb = { onShowBreached: vi.fn(), onShowApproaching: vi.fn(), onShowCritical: vi.fn() };
  const props: AlertQueueBannerProps = {
    unreviewed: 12, breached: 0, breachedCritical: 0, atRisk: 0, oldestBreachMs: 0, ...cb, ...over,
  };
  const utils = render(<AlertQueueBanner {...props} />);
  return { ...utils, ...cb };
}

beforeEach(() => { localStorage.clear(); });

describe('formatSpan', () => {
  it('formats minutes, hours and days', () => {
    expect(formatSpan(38 * 60_000)).toBe('38m');
    expect(formatSpan((5 * 60 + 12) * 60_000)).toBe('5h 12m');
    expect(formatSpan((3 * 24 + 4) * 3_600_000)).toBe('3d 4h');
  });
});

describe('AlertQueueBanner', () => {
  it('renders nothing when there is nothing to review or breach', () => {
    const { container } = setup({ unreviewed: 0 });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the amber banner with singular copy and approaching count', () => {
    setup({ unreviewed: 1, atRisk: 3 });
    expect(screen.getByText(/alert waiting for review/)).toBeInTheDocument();
    expect(screen.getByText(/approaching SLA/)).toBeInTheDocument();
  });

  it('says None past SLA when nothing is at risk', () => {
    setup({ unreviewed: 5 });
    expect(screen.getByText('None past SLA')).toBeInTheDocument();
  });

  it('uses the breached title (plural) with non-critical breaches', () => {
    setup({ breached: 1200, breachedCritical: 0, oldestBreachMs: 90 * 60_000 });
    expect(screen.getByText(/alerts past SLA/)).toBeInTheDocument();
    expect(screen.getByText((1200).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('persists open state and fires filter callbacks', async () => {
    const user = userEvent.setup();
    const { onShowBreached, onShowApproaching } = setup({ breached: 4, atRisk: 2, oldestBreachMs: 60_000 });
    await user.click(screen.getByText(/alerts past SLA/));
    expect(localStorage.getItem('alerts.queue_banner.open')).toBe('1');
    await user.click(screen.getByRole('button', { name: 'Show breached' }));
    await user.click(screen.getByRole('button', { name: 'Show approaching' }));
    expect(onShowBreached).toHaveBeenCalledTimes(1);
    expect(onShowApproaching).toHaveBeenCalledTimes(1);
  });

  it('hides oldest-breach row and breached action when nothing is breached', async () => {
    const user = userEvent.setup();
    setup({ breached: 0, atRisk: 2 });
    await user.click(screen.getByText(/waiting for review/));
    expect(screen.queryByText('Oldest breach')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show breached' })).toBeNull();
  });

  it('shows the sampled note only in sampled mode', () => {
    const { unmount } = setup({ sampled: true, sampledCount: 200 });
    expect(screen.getByText('Based on the 200 most recent alerts loaded')).toBeInTheDocument();
    unmount();
    setup({ sampled: false });
    expect(screen.queryByText(/most recent alerts loaded/)).toBeNull();
  });

  it('shows the incident card for critical breaches with correct copy and callbacks', async () => {
    const user = userEvent.setup();
    const { onShowCritical, onShowBreached } = setup({
      breached: 9, breachedCritical: 1, atRisk: 4, unreviewed: 30, oldestBreachMs: (3 * 24 + 4) * 3_600_000,
    });
    expect(screen.getByRole('region', { name: /1 critical alert past their response deadline/ })).toBeInTheDocument();
    expect(screen.getByRole('region')).toHaveTextContent('9 alerts are past SLA in total, with 30 waiting for review.');
    expect(screen.getByText('3d 4h')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show critical breaches' }));
    await user.click(screen.getByRole('button', { name: 'Show all breached' }));
    expect(onShowCritical).toHaveBeenCalledTimes(1);
    expect(onShowBreached).toHaveBeenCalledTimes(1);
  });

  it('snoozing falls back to the expandable banner and stores an expiry', async () => {
    const user = userEvent.setup();
    setup({ breached: 2, breachedCritical: 2, unreviewed: 5 });
    await user.click(screen.getByRole('button', { name: 'Snooze 1 hour' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByText(/alerts past SLA/)).toBeInTheDocument();
    expect(Number(localStorage.getItem('alerts.incident_snoozed_until'))).toBeGreaterThan(Date.now());
  });

  it('honours an unexpired snooze on mount and ignores an expired one', () => {
    localStorage.setItem('alerts.incident_snoozed_until', String(Date.now() + 60_000));
    const { unmount } = setup({ breached: 2, breachedCritical: 2 });
    expect(screen.queryByRole('region')).toBeNull();
    unmount();
    localStorage.setItem('alerts.incident_snoozed_until', String(Date.now() - 1000));
    setup({ breached: 2, breachedCritical: 2 });
    expect(screen.getByRole('region')).toBeInTheDocument();
  });
});
