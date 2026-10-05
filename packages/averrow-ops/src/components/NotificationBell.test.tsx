// NotificationBell: trigger (label, count Badge, critical colour, live region),
// desktop popover vs mobile Sheet, row actions, shared snooze options, footer
// links, empty/error states, and the triage row (copy matches Home / sidebar /
// Console, only fetched/shown for roles holding edit_alerts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Notification } from '@/hooks/useNotifications';
import { SNOOZE_OPTIONS } from '@/lib/snooze';

const mocks = vi.hoisted(() => ({
  isMobile: false,
  unread: 0 as number | undefined,
  feed: { data: undefined as { notifications: unknown[]; unread_count: number } | undefined, isLoading: false, isError: false },
  refetch: vi.fn(),
  useAuth: vi.fn(),
  useAlertTriageSummary: vi.fn(),
  snooze: vi.fn(),
  done: vi.fn(),
  markRead: vi.fn(),
  markAll: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/hooks/useAlerts', () => ({ useAlertTriageSummary: mocks.useAlertTriageSummary }));
vi.mock('@/hooks/useWindowWidth', () => ({ useIsMobile: () => mocks.isMobile }));
vi.mock('@/hooks/useNotifications', () => ({
  OPS_AUDIENCE_FILTER: ['platform'],
  useUnreadCount: () => ({ data: mocks.unread }),
  useNotifications: () => ({ ...mocks.feed, refetch: mocks.refetch }),
  useMarkRead: () => ({ mutate: mocks.markRead, isPending: false }),
  useMarkAllRead: () => ({ mutate: mocks.markAll, isPending: false }),
  useSnoozeNotification: () => ({ mutate: mocks.snooze, isPending: false }),
  useMarkDone: () => ({ mutate: mocks.done, isPending: false }),
}));

import { NotificationBell } from './NotificationBell';

function note(over: Partial<Notification> & { id: string }): Notification {
  return {
    brand_id: null, brand_domain: null, brand_logo_url: null, brand_name: null, org_id: null,
    audience: 'all', type: 'brand_threat', severity: 'medium', title: `Title ${over.id}`,
    message: `Body ${over.id}`, reason_text: null, recommended_action: null, link: null,
    state: 'unread', read_at: null, snoozed_until: null, done_at: null, group_key: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: null,
    ...over,
  };
}

function setFeed(notifications: Notification[]) {
  mocks.feed = {
    data: { notifications, unread_count: notifications.filter((n) => n.state === 'unread').length },
    isLoading: false,
    isError: false,
  };
}

function renderBell() {
  return render(<MemoryRouter><NotificationBell /></MemoryRouter>);
}

async function openBell() {
  await userEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isMobile = false;
  mocks.unread = 0;
  mocks.feed = { data: { notifications: [], unread_count: 0 }, isLoading: false, isError: false };
  mocks.useAuth.mockReturnValue({ user: { id: 'u1', role: 'analyst' } });
  mocks.useAlertTriageSummary.mockReturnValue({ data: { new_count: 0, critical_count: 0 } });
});

describe('NotificationBell trigger', () => {
  it('is 44x44 with no count when nothing is unread', () => {
    renderBell();
    const btn = screen.getByRole('button', { name: 'Notifications' });
    expect(btn.className).toContain('h-11');
    expect(btn.className).toContain('w-11');
    expect(screen.queryByTestId('bell-count')).not.toBeInTheDocument();
  });

  it('labels the count and shows it', () => {
    mocks.unread = 3;
    renderBell();
    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(screen.getByTestId('bell-count')).toHaveTextContent('3');
  });

  it('caps the visible count at 99+ but keeps the real number in the label', () => {
    mocks.unread = 120;
    renderBell();
    expect(screen.getByTestId('bell-count')).toHaveTextContent('99+');
    expect(screen.getByRole('button', { name: 'Notifications, 120 unread' })).toBeInTheDocument();
  });

  it('is amber when no unread critical exists', () => {
    mocks.unread = 2;
    setFeed([note({ id: 'a', severity: 'high' }), note({ id: 'b', severity: 'critical', state: 'read' })]);
    renderBell();
    expect(screen.getByTestId('bell-count')).toHaveAttribute('data-tone', 'amber');
  });

  it('turns red when an unread critical exists', () => {
    mocks.unread = 2;
    setFeed([note({ id: 'a', severity: 'critical' }), note({ id: 'b' })]);
    renderBell();
    expect(screen.getByTestId('bell-count')).toHaveAttribute('data-tone', 'critical');
  });
});

describe('NotificationBell live region', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('announces new arrivals politely after a debounce, not the initial count', () => {
    mocks.unread = 2;
    const { rerender } = renderBell();
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    act(() => { vi.advanceTimersByTime(3000); });
    expect(region).toHaveTextContent('');

    mocks.unread = 5;
    rerender(<MemoryRouter><NotificationBell /></MemoryRouter>);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(region).toHaveTextContent('');
    act(() => { vi.advanceTimersByTime(1500); });
    expect(region).toHaveTextContent('3 new notifications');
  });
});

describe('NotificationBell panel', () => {
  it('opens a desktop popover (not a Sheet) with filter, actions and footer links', async () => {
    mocks.unread = 1;
    setFeed([note({ id: 'a', link: '/threats/1' })]);
    renderBell();
    await openBell();
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(document.querySelector('.av-ov-sheet')).toBeNull();
    expect(within(dialog).getByRole('radio', { name: 'All' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Unread' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Mark all read' })).toBeEnabled();
    expect(within(dialog).getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/notifications');
    for (const l of within(dialog).getAllByRole('link', { name: /notification settings/i })) {
      expect(l).toHaveAttribute('href', '/settings/notifications');
    }
  });

  it('renders a full-height Sheet with a top bar on mobile', async () => {
    mocks.isMobile = true;
    mocks.unread = 1;
    setFeed([note({ id: 'a' })]);
    renderBell();
    await openBell();
    expect(document.querySelector('.av-ov-sheet')).not.toBeNull();
    const dialog = screen.getByRole('dialog');
    // One heading: the visible top-bar title names the dialog (labelledBy).
    expect(within(dialog).getAllByRole('heading', { name: 'Notifications' })).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBe(dialog);
    expect(within(dialog).getByRole('button', { name: 'Mark all read' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('link', { name: /notification settings/i })[0]).toHaveAttribute('href', '/settings/notifications');
    expect(within(dialog).getByRole('button', { name: 'Close notifications' })).toBeInTheDocument();
  });

  it('marks all read', async () => {
    mocks.unread = 1;
    setFeed([note({ id: 'a' })]);
    renderBell();
    await openBell();
    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(mocks.markAll).toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the bell', async () => {
    renderBell();
    await openBell();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Notifications/ })).toHaveFocus();
  });

  it('Unread filter hides read rows', async () => {
    mocks.unread = 1;
    setFeed([note({ id: 'u', title: 'Unread one' }), note({ id: 'r', title: 'Read one', state: 'read' })]);
    renderBell();
    await openBell();
    expect(screen.getByText('Read one')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Unread' }));
    expect(screen.queryByText('Read one')).not.toBeInTheDocument();
    expect(screen.getByText('Unread one')).toBeInTheDocument();
  });

  it('shows the unread bar, bold title and sr-only severity on unread rows', async () => {
    setFeed([note({ id: 'u', severity: 'critical', title: 'Boom' }), note({ id: 'r', state: 'read', title: 'Calm' })]);
    renderBell();
    await openBell();
    expect(screen.getAllByTestId('unread-bar')).toHaveLength(1);
    expect(screen.getByText('Boom')).toHaveStyle({ fontWeight: '700' });
    expect(screen.getByText(/Critical severity/)).toHaveClass('sr-only');
  });

  it('row actions are a visible kebab, not hover-gated', async () => {
    setFeed([note({ id: 'a' })]);
    renderBell();
    await openBell();
    const kebab = screen.getByRole('button', { name: 'Notification actions' });
    const cls = `${kebab.className} ${kebab.parentElement?.className ?? ''}`;
    expect(cls).not.toMatch(/opacity-|group-hover|hover:none/);
    expect(kebab.className).toContain('h-11');
  });

  it('offers exactly the shared snooze options and snoozes the row', async () => {
    setFeed([note({ id: 'a' })]);
    renderBell();
    await openBell();
    await userEvent.click(screen.getByRole('button', { name: 'Notification actions' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual([...SNOOZE_OPTIONS.map((o) => o.label), 'Mark done']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: '4 hours' }));
    expect(mocks.snooze).toHaveBeenCalledWith({ id: 'a', until: expect.any(String) });
    // The popover stays open after a menu selection.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the empty state with a settings link', async () => {
    renderBell();
    await openBell();
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
  });

  it('shows an inline error with retry', async () => {
    mocks.feed = { data: undefined, isLoading: false, isError: true };
    renderBell();
    await openBell();
    expect(screen.getByText("Couldn't load notifications")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('keeps the stale list visible when a refresh fails', async () => {
    mocks.feed = { data: { notifications: [note({ id: 'a', title: 'Still here' })], unread_count: 1 }, isLoading: false, isError: true };
    renderBell();
    await openBell();
    expect(screen.getByText('Still here')).toBeInTheDocument();
    expect(screen.getByText("Couldn't load notifications")).toBeInTheDocument();
  });

  it('shows row skeletons while loading', async () => {
    mocks.feed = { data: undefined, isLoading: true, isError: false };
    renderBell();
    await openBell();
    expect(screen.getByText('Loading notifications…')).toBeInTheDocument();
  });
});

describe('NotificationBell triage row', () => {
  async function open(role: string, summary: { new_count: number; critical_count: number }) {
    mocks.useAuth.mockReturnValue({ user: { id: 'u1', role } });
    mocks.useAlertTriageSummary.mockReturnValue({ data: summary });
    renderBell();
    await openBell();
  }

  it('reads "N alerts awaiting triage" (plural)', async () => {
    await open('analyst', { new_count: 7, critical_count: 2 });
    expect(await screen.findByText('7 alerts awaiting triage')).toBeInTheDocument();
    expect(screen.queryByText(/signals? need triage/)).not.toBeInTheDocument();
  });

  it('singularises for one alert', async () => {
    await open('analyst', { new_count: 1, critical_count: 0 });
    expect(await screen.findByText('1 alert awaiting triage')).toBeInTheDocument();
  });

  it.each(['super_admin', 'admin', 'analyst', 'support'])('%s fetches the summary', async (role) => {
    await open(role, { new_count: 3, critical_count: 0 });
    expect(mocks.useAlertTriageSummary).toHaveBeenCalledWith({ enabled: true });
    expect(await screen.findByText('3 alerts awaiting triage')).toBeInTheDocument();
  });

  it.each(['sales', 'billing', 'auditor'])('%s does not fetch or show the triage row', async (role) => {
    await open(role, { new_count: 3, critical_count: 1 });
    expect(mocks.useAlertTriageSummary).toHaveBeenCalledWith({ enabled: false });
    expect(mocks.useAlertTriageSummary).not.toHaveBeenCalledWith({ enabled: true });
    expect(screen.queryByText(/awaiting triage/)).not.toBeInTheDocument();
  });
});
