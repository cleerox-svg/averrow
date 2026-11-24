// The open takedown lives in `?takedown=<id>`: system Back closes the drawer,
// a deep link opens it, switching replaces, and filters / scope keep working.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { createMockTakedown } from '@/test/mocks';
import { Takedowns } from './Takedowns';

vi.mock('@/hooks/useTakedowns', () => ({
  useAdminTakedowns: vi.fn(),
  useAdminTakedownsAll: vi.fn().mockReturnValue({ data: null, isLoading: false }),
  useUpdateTakedown: vi.fn().mockReturnValue({ mutate: vi.fn() }),
}));
import { useAdminTakedowns } from '@/hooks/useTakedowns';

const data = {
  takedowns: [
    createMockTakedown({ id: 'td-001', target_value: 'phishing.test.com' }),
    createMockTakedown({ id: 'td-002', status: 'submitted', target_value: 'evil.com', severity: 'CRITICAL' }),
  ],
  total: 2,
  statusCounts: [{ status: 'draft', count: 1 }, { status: 'submitted', count: 1 }],
};

type Router = ReturnType<typeof createMemoryRouter>;
function mount(entries: string[], index = entries.length - 1): Router {
  const router = createMemoryRouter(
    [{ path: '/takedowns', element: <Takedowns /> }, { path: '/prev', element: <div>PREV</div> }],
    { initialEntries: entries, initialIndex: index },
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={qc}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>);
  return router;
}
const back = (r: Router) => act(() => { void r.navigate(-1); });
const viewDetail = (n: number) => fireEvent.click(screen.getAllByText('View Detail')[n]!);
// The panel is always mounted (slid off-screen); its title is the placeholder while closed.
const drawerOpen = () => screen.queryByText('Takedown Request') === null;

beforeEach(() => {
  vi.clearAllMocks();
  (useAdminTakedowns as ReturnType<typeof vi.fn>).mockReturnValue({ data, isLoading: false });
});

describe('Takedowns drawer in the URL', () => {
  it('opening pushes ?takedown=<id>; system Back closes the drawer and stays on the page', async () => {
    const router = mount(['/prev', '/takedowns']);
    viewDetail(0);
    await waitFor(() => expect(drawerOpen()).toBe(true));
    expect(router.state.location.search).toBe('?takedown=td-001');
    expect(router.state.historyAction).toBe('PUSH');
    back(router);
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(router.state.location.pathname).toBe('/takedowns');
    expect(router.state.location.search).toBe('');
  });

  it('a cold deep link opens the drawer; closing it replaces and never leaves the page', async () => {
    const router = mount(['/takedowns?takedown=td-002']);
    await waitFor(() => expect(drawerOpen()).toBe(true));
    expect(screen.getAllByText('evil.com').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Close report' }));
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.pathname).toBe('/takedowns');
    expect(router.state.location.search).toBe('');
  });

  it('closing from the drawer pops the entry it pushed: the next Back leaves the page', async () => {
    const router = mount(['/prev', '/takedowns']);
    viewDetail(0);
    await waitFor(() => expect(drawerOpen()).toBe(true));
    const close = screen.getByRole('button', { name: 'Close report' });
    fireEvent.click(close);
    fireEvent.click(close); // no double pop
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(router.state.location.pathname).toBe('/takedowns');
    back(router);
    await screen.findByText('PREV');
  });

  it('switching to another takedown replaces, so one Back closes the drawer', async () => {
    const router = mount(['/prev', '/takedowns']);
    viewDetail(0);
    await waitFor(() => expect(router.state.location.search).toBe('?takedown=td-001'));
    viewDetail(1);
    await waitFor(() => expect(router.state.location.search).toBe('?takedown=td-002'));
    expect(router.state.historyAction).toBe('REPLACE');
    expect(drawerOpen()).toBe(true);
    back(router);
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(router.state.location.pathname).toBe('/takedowns');
    expect(router.state.location.search).toBe('');
  });

  it('an id that is not in the list is dropped with a replace (no pop, no stuck param)', async () => {
    const router = mount(['/prev', '/takedowns?takedown=td-gone']);
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.historyAction).toBe('REPLACE');
    expect(drawerOpen()).toBe(false);
    expect(router.state.location.pathname).toBe('/takedowns');
  });

  it('keeps the scope and brand params while the drawer opens and closes', async () => {
    const router = mount(['/prev', '/takedowns?brand=brand_test']);
    viewDetail(0);
    await waitFor(() => expect(drawerOpen()).toBe(true));
    expect(new URLSearchParams(router.state.location.search).get('brand')).toBe('brand_test');
    back(router);
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(router.state.location.search).toBe('?brand=brand_test');
  });
});
