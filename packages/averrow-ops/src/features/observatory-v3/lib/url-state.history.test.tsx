import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { DEFAULT_STATE, isSelectionPick, useObservatoryUrlState, type ObservatoryUrlState } from './url-state';

let api: ReturnType<typeof useObservatoryUrlState> | null = null;
function Probe() { api = useObservatoryUrlState(); return null; }

describe('isSelectionPick', () => {
  it('is true only on the none -> selection transition', () => {
    expect(isSelectionPick(DEFAULT_STATE, { sel: 'b' })).toBe(true);
    expect(isSelectionPick(DEFAULT_STATE, { node: 'n1' })).toBe(true);
    expect(isSelectionPick(DEFAULT_STATE, { arc: 'x' })).toBe(true);
    expect(isSelectionPick(DEFAULT_STATE, { period: '30d' })).toBe(false);
    expect(isSelectionPick(DEFAULT_STATE, { sel: null })).toBe(false);
  });
  it('selection -> another selection, and clears, do not push', () => {
    const prev: ObservatoryUrlState = { ...DEFAULT_STATE, node: '1.5,2.5' };
    expect(isSelectionPick(prev, { node: '3.5,4.5' })).toBe(false);
    expect(isSelectionPick(prev, { arc: 'x' })).toBe(false);
    expect(isSelectionPick({ ...DEFAULT_STATE, sel: 'a' }, { sel: 'b' })).toBe(false);
    expect(isSelectionPick(prev, { node: null })).toBe(false);
  });
});

describe('useObservatoryUrlState history', () => {
  function mount() {
    const router = createMemoryRouter([{ path: '/', element: <Probe /> }], { initialEntries: ['/start', '/'], initialIndex: 1 });
    // '/start' has no route; only '/' renders, which is all the hook needs.
    render(<RouterProvider router={router} />);
    return router;
  }

  it('browsing many nodes needs one Back: only the first pick pushes', () => {
    const router = mount();
    const len0 = router.state.historyAction;
    act(() => api!.update({ period: '30d' }));
    expect(router.state.historyAction).not.toBe('PUSH');
    act(() => api!.update({ node: '10.5,20.5' }));
    expect(router.state.historyAction).toBe('PUSH');
    for (const n of ['11.5,21.5', '12.5,22.5', '13.5,23.5']) {
      act(() => api!.update({ node: n }));
      expect(router.state.historyAction).toBe('REPLACE');
    }
    expect(router.state.location.search).toContain('node=13.5');
    act(() => { void router.navigate(-1); });
    expect(router.state.location.search).not.toContain('node=');
    expect(len0).toBeDefined();
  });

  it('{ replace: true } forces a replace even for none -> selection', () => {
    const router = mount();
    act(() => api!.update({ node: '10.5,20.5' }, { replace: true }));
    expect(router.state.historyAction).toBe('REPLACE');
  });
});

describe('closing a selection does not leave a dead Back press', () => {
  function mount(entries: string[] = ['/start', '/']) {
    const router = createMemoryRouter(
      [{ path: '/', element: <Probe /> }, { path: '/start', element: <div /> }],
      { initialEntries: entries, initialIndex: entries.length - 1 },
    );
    render(<RouterProvider router={router} />);
    return router;
  }
  const back = (r: ReturnType<typeof createMemoryRouter>) => act(() => { void r.navigate(-1); });

  it('the pick pushes a marked entry; a user close POPS it, so the next Back leaves the map', () => {
    const router = mount();
    act(() => api!.update({ node: '10.5,20.5' }));
    expect(router.state.historyAction).toBe('PUSH');
    expect(router.state.location.state).toMatchObject({ obsPushed: true });
    act(() => api!.clearSelection());
    expect(router.state.historyAction).toBe('POP');
    expect(router.state.location.search).toBe('');
    expect(router.state.location.pathname).toBe('/');
    back(router);
    expect(router.state.location.pathname).toBe('/start'); // not a duplicate "nothing selected" entry
  });

  it('the mark survives selection -> selection replaces, and still closes with one pop', () => {
    const router = mount();
    act(() => api!.update({ node: '10.5,20.5' }));
    act(() => api!.update({ node: '11.5,21.5' }));
    act(() => api!.update({ sel: 'country:NL' }));
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.state).toMatchObject({ obsPushed: true });
    act(() => api!.clearSelection());
    back(router);
    expect(router.state.location.pathname).toBe('/start');
  });

  it('closing twice quickly pops once', () => {
    const router = mount();
    act(() => api!.update({ node: '10.5,20.5' }));
    act(() => { api!.clearSelection(); api!.clearSelection(); });
    expect(router.state.location.pathname).toBe('/');
  });

  it('an unmarked (deep-linked) selection closes with a replace', () => {
    const router = mount(['/start', '/?node=10.50%2C20.50']);
    expect(api!.state.node).toBe('10.50,20.50');
    act(() => api!.clearSelection());
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.search).toBe('');
    back(router);
    expect(router.state.location.pathname).toBe('/start');
  });

  it('an effect-driven clear ({ replace: true }) replaces and never pops, even on a marked entry', () => {
    const router = mount();
    act(() => api!.update({ node: '10.5,20.5' }));
    act(() => api!.update({ node: null, arc: null, sel: null }, { replace: true }));
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.search).toBe('');
    expect(router.state.location.state ?? {}).not.toHaveProperty('obsPushed');
  });

  it('a view change made while selected (colorBy) means the close replaces: the change is kept', () => {
    const router = mount();
    act(() => api!.update({ node: '10.5,20.5' }));
    act(() => api!.update({ colorBy: 'type' }));
    expect(router.state.location.state).toMatchObject({ obsPushed: true });
    act(() => api!.clearSelection());
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.search).toContain('colorBy=type');
  });

  it('a period change clears the selection with a replace and drops the mark', () => {
    const router = mount();
    act(() => api!.update({ node: '10.5,20.5' }));
    act(() => api!.update({ period: '30d' }));
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.search).not.toContain('node=');
    expect(router.state.location.state ?? {}).not.toHaveProperty('obsPushed');
  });
});
