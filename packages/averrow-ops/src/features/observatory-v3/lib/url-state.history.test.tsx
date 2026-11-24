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
