import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { DEFAULT_STATE, isSelectionPick, useObservatoryUrlState, type ObservatoryUrlState } from './url-state';

let api: ReturnType<typeof useObservatoryUrlState> | null = null;
function Probe() { api = useObservatoryUrlState(); return null; }

describe('isSelectionPick', () => {
  const prev: ObservatoryUrlState = { ...DEFAULT_STATE, sel: 'a' };
  it('is true only when a different non-null node / arc / sel is set', () => {
    expect(isSelectionPick(prev, { sel: 'b' })).toBe(true);
    expect(isSelectionPick(prev, { node: 'n1' })).toBe(true);
    expect(isSelectionPick(prev, { arc: 'x' })).toBe(true);
    expect(isSelectionPick(prev, { sel: 'a' })).toBe(false);
    expect(isSelectionPick(prev, { sel: null })).toBe(false);
    expect(isSelectionPick(prev, { period: '30d' })).toBe(false);
  });
});

describe('useObservatoryUrlState history', () => {
  it('a period change replaces; picking a node pushes', () => {
    const router = createMemoryRouter([{ path: '/', element: <Probe /> }], { initialEntries: ['/'] });
    render(<RouterProvider router={router} />);
    act(() => api!.update({ period: '30d' }));
    expect(router.state.historyAction).not.toBe('PUSH');
    act(() => api!.update({ node: '10.5,20.5' }));
    expect(router.state.historyAction).toBe('PUSH');
    expect(router.state.location.search).toContain('node=10.5');
    act(() => { void router.navigate(-1); });
    expect(router.state.location.search).not.toContain('node=');
  });
});
