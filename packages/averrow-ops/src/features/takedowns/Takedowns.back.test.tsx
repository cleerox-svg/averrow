// The open takedown lives in `?takedown=<id>`: system Back closes the drawer,
// a deep link opens it, switching replaces, and filters / scope keep working.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('a double click on View Detail pushes once: one Back closes the drawer', async () => {
    const router = mount(['/prev', '/takedowns']);
    const btn = screen.getAllByText('View Detail')[0]!;
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(drawerOpen()).toBe(true));
    back(router);
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(router.state.location.pathname).toBe('/takedowns');
  });

  it('clearing the brand filter while the drawer is open keeps the drawer\'s history mark (pop still works)', async () => {
    const router = mount(['/prev', '/takedowns?brand=brand_test']);
    viewDetail(0);
    await waitFor(() => expect(drawerOpen()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Close report' }));
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(router.state.historyAction).toBe('POP');
    expect(router.state.location.search).toBe('?brand=brand_test');
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

const NOTES = { name: /internal notes/i };

describe('the notes draft survives the system Back', () => {
  it('type a note, press Back, reopen: the draft is restored, with a Discard row', async () => {
    const router = mount(['/prev', '/takedowns']);
    viewDetail(0);
    await waitFor(() => expect(drawerOpen()).toBe(true));
    await userEvent.type(screen.getByRole('textbox', NOTES), 'half written');
    back(router); // immediately: the unmount flush must keep it
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(window.sessionStorage.getItem('takedown-notes-draft:td-001')).toBe('half written');

    viewDetail(0);
    await waitFor(() => expect(drawerOpen()).toBe(true));
    expect(screen.getByRole('textbox', NOTES)).toHaveValue('half written');
    expect(screen.getByText('Restored unsaved draft')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('textbox', NOTES)).toHaveValue('');
    expect(screen.queryByText('Restored unsaved draft')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('takedown-notes-draft:td-001')).toBeNull();
  });

  it('autosaves while typing (debounced) without closing', async () => {
    mount(['/prev', '/takedowns']);
    viewDetail(0);
    await userEvent.type(screen.getByRole('textbox', NOTES), 'abc');
    await waitFor(() => expect(window.sessionStorage.getItem('takedown-notes-draft:td-001')).toBe('abc'));
  });

  it('an untouched note leaves no draft behind', async () => {
    const router = mount(['/prev', '/takedowns']);
    viewDetail(0);
    await waitFor(() => expect(drawerOpen()).toBe(true));
    back(router);
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(window.sessionStorage.getItem('takedown-notes-draft:td-001')).toBeNull();
  });
});

describe('ReportPanel focus and semantics', () => {
  it('is a labelled modal dialog while open and inert while closed', async () => {
    mount(['/prev', '/takedowns']);
    expect(screen.queryByRole('dialog')).toBeNull(); // closed: hidden from the a11y tree
    viewDetail(0);
    const dlg = await screen.findByRole('dialog', { name: 'phishing.test.com' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
  });

  it('focuses Close on open and returns focus to the opener on a Back close', async () => {
    const router = mount(['/prev', '/takedowns']);
    const opener = screen.getAllByText('View Detail')[0]!;
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close report' })).toHaveFocus());
    back(router);
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(opener).toHaveFocus();
  });

  it('falls back to the list heading when the opener is gone', async () => {
    const router = mount(['/prev', '/takedowns?takedown=td-001']); // deep link: no opener
    await waitFor(() => expect(drawerOpen()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Close report' }));
    await waitFor(() => expect(drawerOpen()).toBe(false));
    expect(router.state.location.search).toBe('');
    const heading = screen.getByText('Takedowns').closest('[tabindex="-1"]');
    expect(heading).toHaveFocus();
  });
});
