// Regression coverage for the same bug class as PlatformStatusBadge's
// PALETTE[status] crash (Jul 2026 "/v2/" root-route outage): PALETTE has
// no index signature, so an unrecognized `severity` string reaching
// `PALETTE[alert.severity]` would resolve to `undefined` and crash the
// render. The fix made the lookup total: `PALETTE[alert.severity] ??
// PALETTE.info`. This locks that a notification with an unrecognized
// severity still renders (falling back to the 'info' entry) instead of
// throwing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
