// useHistoryDismiss / Dialog `dismissOnBack`: the system Back gesture
// (`router.navigate(-1)`) closes the open overlay instead of leaving the page,
// and closing an overlay from its own UI removes the entry it pushed.

import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Link, RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { ConfirmDialog, Dialog, Sheet, SheetContent } from '@averrow/shared/ui';
import { HistoryDismiss, useHistoryDismiss } from '@averrow/shared/nav';
import { installDomStubs, stubViewport } from './shared-ui/overlays/helpers';

type Router = ReturnType<typeof createMemoryRouter>;
const back = (r: Router) => act(() => { void r.navigate(-1); });
const overlays = (r: Router) => ((r.state.location.state as { overlays?: string[] } | null)?.overlays ?? []).length;

function Page({ nestedConfirm = false, confirmClosesPanel = false, presentation = 'dialog' as const }: { nestedConfirm?: boolean; confirmClosesPanel?: boolean; presentation?: 'dialog' | 'auto' }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      <Dialog open={open} onOpenChange={setOpen} dismissOnBack title="Panel" presentation={presentation}
        footer={<button type="button" onClick={() => setOpen(false)}>Close panel</button>}>
        <Link to="/other">go other</Link>
        {nestedConfirm && <button type="button" onClick={() => setConfirm(true)}>ask</button>}
        {nestedConfirm && (
          <ConfirmDialog open={confirm} onOpenChange={setConfirm} dismissOnBack tone="primary"
            title="Sure?" confirmLabel="Do it" onConfirm={() => { if (confirmClosesPanel) setOpen(false); }} />
        )}
      </Dialog>
    </div>
  );
}

function mount(element = <Page />) {
  const router = createMemoryRouter(
    [{ path: '/', element }, { path: '/other', element: <div>OTHER</div> }, { path: '/prev', element: <div>PREV</div> }],
    { initialEntries: ['/prev', '/'], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => { installDomStubs(); stubViewport(false); });

describe('Dialog dismissOnBack (memory router)', () => {
  it('opening pushes exactly one same-URL entry marked in history state', async () => {
    const router = mount();
    const key0 = router.state.location.key;
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog');
    expect(router.state.historyAction).toBe('PUSH');
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.key).not.toBe(key0);
    expect(overlays(router)).toBe(1);
    // One Back returns to the entry we left (no second entry was pushed).
    back(router);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.key).toBe(key0);
  });

  it('system Back closes the dialog and stays on the page', async () => {
    const router = mount();
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog');
    back(router);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/');
  });

  it('works for the bottom-sheet presentation too', async () => {
    stubViewport(true);
    const router = mount(<Page presentation="auto" />);
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog');
    back(router);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/');
  });

  it('closing from the UI pops its entry exactly once (Close button, then Esc on a second open)', async () => {
    const router = mount();
    const key0 = router.state.location.key;
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByText('Close panel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(router.state.location.key).toBe(key0));
    expect(router.state.location.pathname).toBe('/'); // not /prev: no double pop

    fireEvent.click(screen.getByText('open'));
    const dlg = await screen.findByRole('dialog');
    fireEvent.keyDown(dlg, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(router.state.location.key).toBe(key0));
    expect(router.state.location.pathname).toBe('/');
  });

  it('a link inside the dialog navigates forward: the dialog closes and nothing is popped', async () => {
    const router = mount();
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByText('go other'));
    await screen.findByText('OTHER');
    expect(router.state.historyAction).toBe('PUSH');
    expect(router.state.location.pathname).toBe('/other');
    // Back lands on the page the dialog was opened on, dialog closed.
    back(router);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('nested: a ConfirmDialog opened from the dialog stacks; Back closes only the top one', async () => {
    const router = mount(<Page nestedConfirm />);
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog', { name: 'Panel' });
    fireEvent.click(screen.getByText('ask'));
    await screen.findByRole('dialog', { name: 'Sure?' });
    expect(overlays(router)).toBe(2);

    back(router); // closes the confirm only
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sure?' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Panel' })).toBeInTheDocument();
    expect(overlays(router)).toBe(1);

    back(router); // then the panel
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/');
  });

  it('nested: cancelling the confirm from its UI pops one entry and leaves the panel open', async () => {
    const router = mount(<Page nestedConfirm />);
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog', { name: 'Panel' });
    fireEvent.click(screen.getByText('ask'));
    const confirm = await screen.findByRole('dialog', { name: 'Sure?' });
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sure?' })).not.toBeInTheDocument());
    await waitFor(() => expect(overlays(router)).toBe(1));
    expect(screen.getByRole('dialog', { name: 'Panel' })).toBeInTheDocument();
    expect(confirm).not.toBeInTheDocument();
  });

  it('confirming closes only the confirm; the panel keeps its entry', async () => {
    const router = mount(<Page nestedConfirm />);
    const key0 = router.state.location.key;
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog', { name: 'Panel' });
    fireEvent.click(screen.getByText('ask'));
    await screen.findByRole('dialog', { name: 'Sure?' });
    fireEvent.click(screen.getByText('Do it'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sure?' })).not.toBeInTheDocument());
    // Only the confirm closed; the panel (and its one entry) stays.
    expect(screen.getByRole('dialog', { name: 'Panel' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Close panel'));
    await waitFor(() => expect(router.state.location.key).toBe(key0));
    expect(router.state.location.pathname).toBe('/');
  });

  it('a confirm that also closes its panel pops both entries, back to where it started', async () => {
    const router = mount(<Page nestedConfirm confirmClosesPanel />);
    const key0 = router.state.location.key;
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog', { name: 'Panel' });
    fireEvent.click(screen.getByText('ask'));
    await screen.findByRole('dialog', { name: 'Sure?' });
    fireEvent.click(screen.getByText('Do it'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(router.state.location.key).toBe(key0));
    expect(router.state.location.pathname).toBe('/');
  });

  it('without dismissOnBack nothing is pushed', async () => {
    function Plain() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>open</button><Dialog open={open} onOpenChange={setOpen} title="Plain" presentation="dialog" /></>;
    }
    const router = mount(<Plain />);
    const key0 = router.state.location.key;
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog');
    expect(router.state.location.key).toBe(key0);
  });

  it('Sheet dismissOnBack closes on Back', async () => {
    function S() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open</button>
          <Sheet open={open} onOpenChange={setOpen} dismissOnBack><SheetContent title="Filters">x</SheetContent></Sheet>
        </>
      );
    }
    const router = mount(<S />);
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog');
    back(router);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('useHistoryDismiss (hook, unmount-free overlay)', () => {
  it('keeps unrelated location state on the pushed entry', async () => {
    function Hook() {
      const [open, setOpen] = useState(false);
      useHistoryDismiss(open, () => setOpen(false));
      return <button type="button" onClick={() => setOpen(true)}>{open ? 'is-open' : 'is-closed'}</button>;
    }
    const router = createMemoryRouter([{ path: '/', element: <Hook /> }], {
      initialEntries: [{ pathname: '/', state: { alertPushed: true } }],
    });
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByText('is-closed'));
    await screen.findByText('is-open');
    expect(router.state.location.state).toMatchObject({ alertPushed: true });
    expect(overlays(router)).toBe(1);
    back(router);
    await screen.findByText('is-closed');
  });
});

describe('dismissOnBack with the real browser history (BrowserRouter)', () => {
  function Where() { return <div data-testid="where">{useLocation().pathname}</div>; }
  function Real() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Where />
        <button type="button" onClick={() => setOpen(true)}>open</button>
        <HistoryDismiss open={open} onClose={() => setOpen(false)} />
        <div data-testid="state">{open ? 'open' : 'closed'}</div>
      </>
    );
  }
  it('the browser Back (history.back) closes it; react-router idx stays an integer', async () => {
    window.history.replaceState(null, '', '/');
    render(<BrowserRouter><Real /></BrowserRouter>);
    expect((window.history.state as { idx: number }).idx).toBe(0);
    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('open'));
    expect((window.history.state as { idx: number }).idx).toBe(1);
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
    expect((window.history.state as { idx: number }).idx).toBe(0);
  });

  it('a confirm nested in a panel that closes with it pops both real entries (idx back to 0)', async () => {
    window.history.replaceState(null, '', '/');
    render(<BrowserRouter><Page nestedConfirm confirmClosesPanel /></BrowserRouter>);
    fireEvent.click(screen.getByText('open'));
    await screen.findByRole('dialog', { name: 'Panel' });
    fireEvent.click(screen.getByText('ask'));
    await screen.findByRole('dialog', { name: 'Sure?' });
    expect((window.history.state as { idx: number }).idx).toBe(2);
    fireEvent.click(screen.getByText('Do it'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect((window.history.state as { idx: number }).idx).toBe(0));
  });
});
