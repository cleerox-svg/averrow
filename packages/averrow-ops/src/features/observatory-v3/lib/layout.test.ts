import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { computeLayout, cameraInsets, DOCK_MIN_MAP, DOCK_WIDTH, RAIL_WIDTH } from './layout';
import { useElementWidth } from './use-element-width';

describe('computeLayout: tiers follow the free map width, not the viewport', () => {
  it('phone below 900px viewport: no rail, no dock, everything folded', () => {
    expect(computeLayout({ mapWidth: 400, viewportWidth: 400 })).toMatchObject({
      tier: 'phone', phone: true, railWidth: 0, docked: false, searchCollapsed: true, filtersInPopover: true, panelStartsOpen: false,
    });
  });
  it('tablet: 44px rail, overlay drawer, no docked intel panel', () => {
    const l = computeLayout({ mapWidth: 760, viewportWidth: 1000 });
    expect(l).toMatchObject({ tier: 'tablet', railWidth: RAIL_WIDTH, docked: false, dockWidth: 0, panelStartsOpen: false });
  });
  it('a wide window with a wide sidebar can still be tablet: the map width decides', () => {
    // 1280px window, 240px sidebar open => 1040px map: overlay, even though the window is "desktop".
    expect(computeLayout({ mapWidth: 1040, viewportWidth: 1280 }).tier).toBe('tablet');
    // the same window with the sidebar collapsed leaves 1208px: dock.
    expect(computeLayout({ mapWidth: 1208, viewportWidth: 1280 }).tier).toBe('desktop');
  });
  it('docks from DOCK_MIN_MAP up and reserves the dock in the toolbar budget', () => {
    const below = computeLayout({ mapWidth: DOCK_MIN_MAP - 1, viewportWidth: 1500 });
    const at = computeLayout({ mapWidth: DOCK_MIN_MAP, viewportWidth: 1500 });
    expect(below.docked).toBe(false);
    expect(at).toMatchObject({ docked: true, dockWidth: DOCK_WIDTH, panelStartsOpen: true, tier: 'desktop' });
    // the toolbar spans the whole map: the dock starts below it
    expect(at.toolbarWidth).toBe(DOCK_MIN_MAP - 24);
  });
  it('the search folds to an icon as the toolbar narrows, then the filters fold into a popover', () => {
    expect(computeLayout({ mapWidth: 1800, viewportWidth: 1920 })).toMatchObject({ searchCollapsed: false, filtersInPopover: false });
    // 1440px window, sidebar open => 1200px map: full toolbar, docked panel
    expect(computeLayout({ mapWidth: 1200, viewportWidth: 1440 })).toMatchObject({ docked: true, searchCollapsed: false, filtersInPopover: false });
    // ~1360px window => the search folds to an icon
    expect(computeLayout({ mapWidth: 1100, viewportWidth: 1340 })).toMatchObject({ docked: false, searchCollapsed: true, filtersInPopover: false });
    expect(computeLayout({ mapWidth: 980, viewportWidth: 1220 })).toMatchObject({ searchCollapsed: true, filtersInPopover: false });
    expect(computeLayout({ mapWidth: 700, viewportWidth: 940 })).toMatchObject({ tier: 'tablet', searchCollapsed: true, filtersInPopover: true });
  });
  it('falls back to the viewport until the box is measured', () => {
    expect(computeLayout({ mapWidth: 0, viewportWidth: 1500 }).tier).toBe('desktop');
  });
});

describe('useElementWidth: reacts to resize', () => {
  it('reports the observed width and updates when the box resizes', () => {
    let cb: ResizeObserverCallback = () => {};
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(c: ResizeObserverCallback) { cb = c; } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    try {
      const el = document.createElement('div');
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 1000 });
      const ref = { current: el };
      const { result } = renderHook(() => useElementWidth(ref));
      expect(result.current).toBe(1000);
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 1210 });
      act(() => cb([{ contentRect: { width: 1210 } } as unknown as ResizeObserverEntry], {} as ResizeObserver));
      expect(result.current).toBe(1210);
      // and the layout decision follows it
      expect(computeLayout({ mapWidth: result.current, viewportWidth: 1440 }).docked).toBe(true);
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });
});

describe('cameraInsets: what overlays each edge of the map', () => {
  const desktop = computeLayout({ mapWidth: 1300, viewportWidth: 1540 });
  const phone = computeLayout({ mapWidth: 400, viewportWidth: 400 });
  it('desktop: toolbar on top, rail on the left, docked slot on the right, replay bar below', () => {
    expect(cameraInsets({ layout: desktop, rightSlotOpen: true, showTimeline: true, sheetPx: 0 })).toEqual({
      top: 64, left: 68, right: 344, bottom: 80,
    });
  });
  it('nothing open: just the gutters', () => {
    expect(cameraInsets({ layout: desktop, rightSlotOpen: false, showTimeline: false, sheetPx: 0 })).toEqual({ top: 64, left: 68, right: 12, bottom: 12 });
  });
  it('a floating (tablet) panel covers the map just like a docked one', () => {
    const tablet = computeLayout({ mapWidth: 900, viewportWidth: 1100 });
    expect(tablet.docked).toBe(false);
    expect(cameraInsets({ layout: tablet, rightSlotOpen: true, showTimeline: false, sheetPx: 0 }).right).toBe(344);
  });
  it('phone: two chrome rows on top, no rail, and the peek sheet becomes the bottom inset', () => {
    const closed = cameraInsets({ layout: phone, rightSlotOpen: false, showTimeline: false, sheetPx: 0 });
    expect(closed).toMatchObject({ left: 12, right: 12, bottom: 12 });
    expect(closed.top).toBeGreaterThan(110);
    // sheet 300px from the page bottom, the 108px band sits under the map already => 204px of map covered (+12)
    expect(cameraInsets({ layout: phone, rightSlotOpen: true, showTimeline: false, sheetPx: 300 })).toMatchObject({ right: 12, bottom: 204 });
  });
});
