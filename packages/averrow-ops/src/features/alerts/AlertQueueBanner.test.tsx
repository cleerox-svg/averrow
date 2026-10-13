import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlertQueueBanner, type AlertQueueBannerProps } from './AlertQueueBanner';
import { formatSpan } from '@/lib/time';

function setup(over: Partial<AlertQueueBannerProps> = {}) {
  const cb = { onShowBreached: vi.fn(), onShowApproaching: vi.fn(), onShowCritical: vi.fn(), onAnnounce: vi.fn() };
  const props: AlertQueueBannerProps = {
    unreviewed: 12, breached: 0, breachedCritical: 0, atRisk: 0, oldestBreachMs: 0, ...cb, ...over,
  };
  const utils = render(<AlertQueueBanner {...props} />);
  return { ...utils, ...cb };
}

beforeEach(() => { localStorage.clear(); });


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
    expect(screen.getByRole('region', { name: /1 critical alert past the response deadline/ })).toBeInTheDocument();
    expect(screen.getByRole('region')).toHaveTextContent('Oldest breach is 3d 4h past its deadline.');
    expect(screen.getAllByText('3d 4h')).toHaveLength(2); // stats row + oldest-breach line
    await user.click(screen.getByRole('button', { name: 'Show critical breaches' }));
    await user.click(screen.getByRole('button', { name: 'Show all breached' }));
    expect(onShowCritical).toHaveBeenCalledTimes(1);
    expect(onShowBreached).toHaveBeenCalledTimes(1);
  });

  it('snoozing falls back to the banner, stores {until,count}, announces and moves focus', async () => {
    const user = userEvent.setup();
    const { onAnnounce } = setup({ breached: 2, breachedCritical: 2, unreviewed: 5 });
    await user.click(screen.getByRole('button', { name: 'Snooze 1 hour' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByText(/alerts past SLA/)).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem('alerts.incident_snoozed_until') ?? '{}') as { until: number; count: number };
    expect(stored.until).toBeGreaterThan(Date.now());
    expect(stored.count).toBe(2);
    expect(onAnnounce).toHaveBeenCalledWith('Critical SLA card snoozed for 1 hour');
    await waitFor(() => expect(document.activeElement?.tagName).toBe('SUMMARY'));
  });

  it('honours a valid snooze and ignores expired / skewed / unparseable / legacy ones', () => {
    const put = (v: string) => localStorage.setItem('alerts.incident_snoozed_until', v);
    put(JSON.stringify({ until: Date.now() + 60_000, count: 2 }));
    let r = setup({ breached: 2, breachedCritical: 2 });
    expect(screen.queryByRole('region')).toBeNull();
    r.unmount();
    for (const bad of [
      JSON.stringify({ until: Date.now() - 1000, count: 2 }),
      JSON.stringify({ until: Date.now() + 5 * 3_600_000, count: 2 }),
      'garbage',
      String(Date.now() + 60_000),
    ]) {
      put(bad);
      r = setup({ breached: 2, breachedCritical: 2 });
      expect(screen.getByRole('region')).toBeInTheDocument();
      r.unmount();
    }
  });

  it('brings the card back when the incident worsens past the snoozed count', () => {
    localStorage.setItem('alerts.incident_snoozed_until', JSON.stringify({ until: Date.now() + 60_000, count: 1 }));
    const { rerender, ...cb } = setup({ breached: 1, breachedCritical: 1 });
    expect(screen.queryByRole('region')).toBeNull();
    rerender(<AlertQueueBanner unreviewed={12} breached={3} breachedCritical={3} atRisk={0} oldestBreachMs={0} {...cb} />);
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(cb.onAnnounce).not.toHaveBeenCalled();
  });

  it('stays visible for approaching-only queues', () => {
    setup({ unreviewed: 0, atRisk: 3 });
    expect(screen.getByText(/alerts approaching SLA/)).toBeInTheDocument();
    expect(screen.getByText('None past SLA')).toBeInTheDocument();
  });
});
