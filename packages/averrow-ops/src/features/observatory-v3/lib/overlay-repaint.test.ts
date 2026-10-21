import { describe, it, expect, vi } from 'vitest';
import { repaintDeckNow, repaintOnResizeProps } from './overlay-repaint';

describe('repaintDeckNow: the resized deck canvas is redrawn in the same frame', () => {
  it('refreshes deck\'s canvas size, THEN draws (a draw at the old size would be mis-scaled for a frame)', () => {
    const calls: string[] = [];
    const overlay = { _deck: { _updateCanvasSize: () => { calls.push('size'); }, redraw: (r?: string) => { calls.push(`redraw:${r}`); } } };
    expect(repaintDeckNow(overlay)).toBe(true);
    expect(calls).toEqual(['size', 'redraw:Canvas resized']);
  });

  it('degrades to deck\'s own next-frame redraw when the internals are missing or throw', () => {
    expect(repaintDeckNow(null)).toBe(false);
    expect(repaintDeckNow({})).toBe(false);
    expect(repaintDeckNow({ _deck: {} })).toBe(false);
    expect(repaintDeckNow({ _deck: { redraw: () => { throw new Error('gl lost'); } } })).toBe(false);
  });

  it('does not draw without _updateCanvasSize (a stale-size draw would be mis-scaled; deck redraws next frame)', () => {
    const redraw = vi.fn();
    expect(repaintDeckNow({ _deck: { redraw } })).toBe(false);
    expect(redraw).not.toHaveBeenCalled();
  });
});

describe('repaintOnResizeProps', () => {
  it('reads the overlay lazily: the callback is built before the overlay exists', () => {
    let overlay: unknown = null;
    const props = repaintOnResizeProps(() => overlay);
    expect(() => props.onResize()).not.toThrow(); // resize before the overlay is assigned
    const redraw = vi.fn();
    overlay = { _deck: { _updateCanvasSize: () => {}, redraw } };
    props.onResize();
    expect(redraw).toHaveBeenCalledWith('Canvas resized');
  });
});
