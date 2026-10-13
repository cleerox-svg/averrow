// Regression coverage for the same bug class as PlatformStatusBadge's
// PALETTE[status] crash (Jul 2026 "/v2/" root-route outage): PALETTE has
// no index signature, so an unrecognized `severity` string reaching
// `PALETTE[alert.severity]` would resolve to `undefined` and crash the
// render. The fix made the lookup total: `PALETTE[alert.severity] ??
// PALETTE.info`. This locks that a notification with an unrecognized
// severity still renders (falling back to the 'info' entry) instead of
// throwing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { PlatformAlertBanner } from './PlatformAlertBanner';
import type { Notification } from '@/hooks/useNotifications';

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: vi.fn(),
  useMarkRead: vi.fn(),
}));

import { useNotifications, useMarkRead } from '@/hooks/useNotifications';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

function renderOnHome(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    brand_id: null,
    brand_domain: null,
    brand_logo_url: null,
    brand_name: null,
    org_id: null,
    audience: 'super_admin',
    type: 'platform_feed_silent',
    severity: 'critical',
    title: 'Feed silent',
    message: 'A feed has stopped ingesting.',
    reason_text: null,
    recommended_action: null,
    link: null,
    state: 'unread',
    read_at: null,
    snoozed_until: null,
    done_at: null,
    group_key: null,
    created_at: '2026-07-13T00:00:00Z',
    updated_at: '2026-07-13T00:00:00Z',
    metadata: null,
    ...overrides,
  } as Notification;
}

describe('PlatformAlertBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useMarkRead as ReturnType<typeof vi.fn>).mockReturnValue({ mutate: vi.fn() });
  });

  it('renders a known-severity platform_* notification normally', () => {
    (useNotifications as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { notifications: [makeNotification({ severity: 'critical' })], unread_count: 1 },
    });
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.getByText('Feed silent')).toBeInTheDocument();
  });

  it('renders without throwing when severity is an unrecognized string, falling back to the info palette', () => {
    const bogus = makeNotification({
      severity: 'unknown_future_severity' as unknown as Notification['severity'],
    });
    (useNotifications as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { notifications: [bogus], unread_count: 1 },
    });
    expect(() => renderOnHome(<PlatformAlertBanner />)).not.toThrow();
    expect(screen.getByText('Feed silent')).toBeInTheDocument();
  });

  it('renders nothing when there are no unread platform_* notifications', () => {
    (useNotifications as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { notifications: [], unread_count: 0 },
    });
    const { container } = renderOnHome(<PlatformAlertBanner />);
    expect(container.firstChild).toBeNull();
  });

  function mockList(list: Notification[]) {
    (useNotifications as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { notifications: list, unread_count: list.length },
    });
  }

  it('View link uses alert.link and strips a /v2 prefix', () => {
    mockList([makeNotification({ link: '/v2/admin/operations?tab=feeds' })]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/admin/operations?tab=feeds');
  });

  it('View link keeps a plain in-app link as-is', () => {
    mockList([makeNotification({ link: '/providers/p1' })]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/providers/p1');
  });

  it('View link falls back to the notifications inbox when link is missing or external', () => {
    mockList([makeNotification({ link: null })]);
    const first = renderOnHome(<PlatformAlertBanner />);
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/notifications');
    first.unmount();
    mockList([makeNotification({ link: 'https://evil.example/x' })]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/notifications');
  });

  it('shows +N more for additional unread platform notifications only', () => {
    mockList([
      makeNotification({ id: 'a' }),
      makeNotification({ id: 'b', severity: 'low' }),
      makeNotification({ id: 'c', severity: 'low' }),
      makeNotification({ id: 'd', type: 'brand_threat', severity: 'low' }),
    ]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.getByRole('link', { name: '+2 more' })).toHaveAttribute('href', '/notifications');
  });

  it('shows no +N more link for a single alert', () => {
    mockList([makeNotification()]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it('dismiss hides the banner and persists the id', () => {
    mockList([makeNotification({ id: 'dismiss-me' })]);
    const { container } = renderOnHome(<PlatformAlertBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss platform alert' }));
    expect(container.firstChild).toBeNull();
    expect(localStorage.getItem('averrow:platform-alerts:dismissed-v1')).toContain('dismiss-me');
  });

  it('View marks the alert read (mutate) and dismisses; there is no separate Mark read button', () => {
    const mutate = vi.fn();
    (useMarkRead as ReturnType<typeof vi.fn>).mockReturnValue({ mutate });
    mockList([makeNotification({ id: 'read-me' })]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'View' }));
    expect(mutate).toHaveBeenCalledWith('read-me');
    expect(localStorage.getItem('averrow:platform-alerts:dismissed-v1')).toContain('read-me');
  });

  it('announces critical/high politely with role=status, not lower severities', () => {
    mockList([makeNotification({ severity: 'critical' })]);
    const a = renderOnHome(<PlatformAlertBanner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    a.unmount();
    mockList([makeNotification({ severity: 'low' })]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is not sticky', () => {
    mockList([makeNotification({ severity: 'low' })]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.getByRole('region', { name: 'Platform alert' }).style.position).not.toBe('sticky');
  });

  it('details toggle reveals reason and recommended action', () => {
    mockList([makeNotification({ reason_text: 'No rows for 3h', recommended_action: 'Re-run the feed' })]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.getByText(/Re-run the feed/)).not.toBeVisible();
    const toggle = screen.getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Re-run the feed/)).toBeVisible();
    expect(screen.getByText(/No rows for 3h/)).toBeInTheDocument();
  });

  it('has no details toggle for a short alert without extras', () => {
    mockList([makeNotification({ severity: 'low' })]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.queryByRole('button', { name: /details/i })).toBeNull();
  });

  it('is a labelled region, not role="alert"', () => {
    mockList([makeNotification({ severity: 'low' })]);
    renderOnHome(<PlatformAlertBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('region', { name: 'Platform alert' })).toBeInTheDocument();
  });
});
