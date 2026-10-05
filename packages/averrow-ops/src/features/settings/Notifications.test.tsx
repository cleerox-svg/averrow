// /notifications inbox: tabs, grouping, row anatomy, always-visible actions,
// shared snooze options, filters (desktop bar vs mobile Sheet), pagination,
// and empty / error / loading states.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Notification } from '@/hooks/useNotifications';
import { SNOOZE_OPTIONS } from '@/lib/snooze';

const mocks = vi.hoisted(() => ({
  isMobile: false,
  archive: vi.fn(),
  refetch: vi.fn(),
  snooze: vi.fn(),
  done: vi.fn(),
  markRead: vi.fn(),
  markAll: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('@/hooks/useWindowWidth', () => ({ useIsMobile: () => mocks.isMobile }));
vi.mock('@/hooks/useNotifications', () => ({
  OPS_AUDIENCE_FILTER: ['super_admin', 'team', 'all'],
  useNotificationsArchive: (f: unknown) => mocks.archive(f),
  useMarkRead: () => ({ mutate: mocks.markRead, isPending: false }),
  useMarkAllRead: () => ({ mutate: mocks.markAll, isPending: false }),
  useSnoozeNotification: () => ({ mutate: mocks.snooze, isPending: false }),
  useMarkDone: () => ({ mutate: mocks.done, isPending: false }),
}));

import { Notifications } from './Notifications';

function note(over: Partial<Notification> & { id: string }): Notification {
  return {
    brand_id: null, brand_domain: null, brand_logo_url: null, brand_name: null, org_id: null,
    audience: 'all', type: 'brand_threat', severity: 'high', title: `Title ${over.id}`,
    message: `Body ${over.id}`, reason_text: null, recommended_action: null, link: null,
    state: 'unread', read_at: null, snoozed_until: null, done_at: null, group_key: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: null,
    ...over,
  };
}

function result(over: Record<string, unknown> = {}) {
  return {
    data: { notifications: [], unread_count: 0, next_cursor: null },
    isLoading: false, isFetching: false, isError: false, isPlaceholderData: false,
    refetch: mocks.refetch,
    ...over,
  };
}

function withRows(rows: Notification[], extra: Record<string, unknown> = {}, page: Record<string, unknown> = {}) {
  mocks.archive.mockReturnValue(result({
    data: { notifications: rows, unread_count: rows.filter((r) => r.state === 'unread').length, next_cursor: null, ...page },
    ...extra,
  }));
}

const lastFilters = () => mocks.archive.mock.calls[mocks.archive.mock.calls.length - 1]![0] as Record<string, unknown>;

function renderPage() {
  return render(<MemoryRouter><Notifications /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isMobile = false;
  mocks.archive.mockReturnValue(result());
});

describe('Notifications header + tabs', () => {
  it('has the title, Mark all read and a settings gear', () => {
    withRows([note({ id: 'a' })]);
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Notification settings' })).toHaveAttribute('href', '/settings/notifications');
  });

  it('disables Mark all read when nothing is unread', () => {
    withRows([note({ id: 'a', state: 'read' })]);
    renderPage();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('shows state tabs with the unread count on Inbox and switches state', async () => {
    withRows([note({ id: 'a' }), note({ id: 'b' })]);
    renderPage();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Inbox2', 'Snoozed', 'Done', 'All']);
    expect(lastFilters()).toMatchObject({ state: 'inbox' });
    await userEvent.click(screen.getByRole('tab', { name: /Snoozed/ }));
    expect(lastFilters()).toMatchObject({ state: 'snoozed' });
  });
});

describe('Notifications rows', () => {
  it('groups by day with headings and renders row anatomy', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    withRows([
      note({ id: 'a', severity: 'critical', title: 'Fresh critical' }),
      note({ id: 'b', state: 'read', title: 'Older', created_at: yesterday }),
    ]);
    renderPage();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeInTheDocument();
    expect(screen.getAllByTestId('unread-bar')).toHaveLength(1);
    expect(screen.getByText(/Critical severity\. Unread\./)).toHaveClass('sr-only');
    expect(screen.getByText('Fresh critical')).toHaveStyle({ fontWeight: '700' });
    expect(screen.getByText('Older')).toHaveStyle({ fontWeight: '600' });
  });

  it('uses a token background on sticky day headings', () => {
    withRows([note({ id: 'a' })]);
    renderPage();
    const h = screen.getByRole('heading', { name: 'Today' });
    expect(h.className).toContain('sticky');
    expect(h.className).toContain('var(--bg-elevated-solid)');
  });

  it('keeps Snooze and Done always visible (not hover-gated) and keyboard reachable', () => {
    withRows([note({ id: 'a' })]);
    renderPage();
    for (const name of ['Snooze notification', 'Mark done']) {
      const btn = screen.getByRole('button', { name });
      expect(`${btn.className} ${btn.parentElement?.className}`).not.toMatch(/opacity-|group-hover|hover:none/);
      expect(btn.className).toContain('h-11');
      expect(btn).not.toHaveAttribute('tabindex', '-1');
    }
  });

  it('marks done', async () => {
    withRows([note({ id: 'a' })]);
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(mocks.done).toHaveBeenCalledWith('a', expect.any(Object));
  });

  it('offers exactly the shared snooze options', async () => {
    withRows([note({ id: 'a' })]);
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Snooze notification' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(SNOOZE_OPTIONS.map((o) => o.label));
    await userEvent.click(within(menu).getByRole('menuitem', { name: '1 day' }));
    expect(mocks.snooze).toHaveBeenCalledWith({ id: 'a', until: expect.any(String) }, expect.any(Object));
  });

  it('opens the link and marks an unread row read on activation', async () => {
    withRows([note({ id: 'a', link: '/threats/9', title: 'Go' })]);
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Go/ }));
    expect(mocks.markRead).toHaveBeenCalledWith('a', expect.any(Object));
    expect(mocks.navigate).toHaveBeenCalledWith('/threats/9');
  });

  it('collapses same-group rows and expands them', async () => {
    withRows([
      note({ id: 'a', group_key: 'g', title: 'Head' }),
      note({ id: 'b', group_key: 'g', title: 'Second' }),
    ]);
    renderPage();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Show 1 more similar/ }));
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('hides snooze on snoozed rows and all actions on done rows', () => {
    withRows([
      note({ id: 's', state: 'snoozed', snoozed_until: new Date(Date.now() + 3_600_000).toISOString() }),
      note({ id: 'd', state: 'done' }),
    ]);
    renderPage();
    expect(screen.queryByRole('button', { name: 'Snooze notification' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mark done' })).toHaveLength(1);
  });
});

describe('Notifications filters', () => {
  it('desktop shows a compact FilterBar row, not a Filters button', async () => {
    withRows([note({ id: 'a' })]);
    renderPage();
    expect(screen.queryByRole('button', { name: /^Filters/ })).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search notifications' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Critical' }));
    expect(lastFilters()).toMatchObject({ severity: 'critical' });
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'brand_threat');
    expect(lastFilters()).toMatchObject({ type: 'brand_threat' });
  });

  it('Enter applies the search immediately; Esc clears it immediately', async () => {
    withRows([note({ id: 'a' })]);
    renderPage();
    const box = screen.getByRole('searchbox', { name: 'Search notifications' });
    await userEvent.type(box, 'acme{Enter}');
    expect(lastFilters()).toMatchObject({ q: 'acme' });
    await userEvent.keyboard('{Escape}');
    expect(box).toHaveValue('');
    expect(lastFilters()).not.toHaveProperty('q');
  });

  it('mobile hides filters behind a Filters button that opens a Sheet', async () => {
    mocks.isMobile = true;
    withRows([note({ id: 'a' })]);
    renderPage();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    const dialog = await screen.findByRole('dialog');
    expect(document.querySelector('.av-ov-sheet')).not.toBeNull();
    expect(within(dialog).getByLabelText('Search')).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText('Severity'), 'high');
    expect(lastFilters()).toMatchObject({ severity: 'high' });
    expect(within(dialog).getByRole('button', { name: 'Clear filters' })).toBeEnabled();
  });

  it('resets the cursor when a filter changes and paginates with the cursor', async () => {
    withRows([note({ id: 'a' })], {}, { next_cursor: 'CUR1' });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Older/ }));
    expect(lastFilters()).toMatchObject({ cursor: 'CUR1' });
    await userEvent.click(screen.getByRole('button', { name: 'Critical' }));
    expect(lastFilters()).not.toHaveProperty('cursor');
  });
});

describe('Notifications states', () => {
  it('shows the caught-up empty state with a settings link', () => {
    renderPage();
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Notification settings' });
    expect(links.some((l) => l.getAttribute('href') === '/settings/notifications')).toBe(true);
  });

  it('shows a filtered-empty state with a way out', async () => {
    mocks.archive.mockReturnValue(result());
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'High' }));
    expect(screen.getByText('No notifications match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(lastFilters()).not.toHaveProperty('severity');
  });

  it('shows row skeletons while loading', () => {
    mocks.archive.mockReturnValue(result({ data: undefined, isLoading: true }));
    renderPage();
    expect(screen.getByText('Loading notifications…')).toBeInTheDocument();
  });

  it('shows a blocking error with retry when there is no data', async () => {
    mocks.archive.mockReturnValue(result({ data: undefined, isError: true }));
    renderPage();
    expect(screen.getByText("Couldn't load notifications")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('keeps the stale list when a refresh fails', () => {
    withRows([note({ id: 'a', title: 'Stale row' })], { isError: true });
    renderPage();
    expect(screen.getByText('Stale row')).toBeInTheDocument();
    expect(screen.getByText("Couldn't refresh notifications")).toBeInTheDocument();
  });

  it('never calls a failed fetch "all caught up"', () => {
    mocks.archive.mockReturnValue(result({ data: undefined, isError: true }));
    renderPage();
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
  });
});
