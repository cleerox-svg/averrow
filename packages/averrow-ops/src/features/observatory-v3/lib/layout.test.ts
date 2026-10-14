import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { computeLayout, cameraInsets, chipPlacement, railMaxHeight, RAIL_TOP, initialSheetPx, CHIP_H, SHORT_VIEWPORT_H, TOOLBAR_FULL, DOCK_MIN_MAP, DOCK_WIDTH, RAIL_WIDTH } from './layout';
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
    expect(computeLayout({ mapWidth: 1000, viewportWidth: 1240 })).toMatchObject({ searchCollapsed: true, filtersInPopover: false });
    // below ~970px of toolbar the strip + inline period/source would squeeze the strip into scrolling: fold them
    expect(computeLayout({ mapWidth: 952, viewportWidth: 1200 })).toMatchObject({ searchCollapsed: true, filtersInPopover: true });
    expect(computeLayout({ mapWidth: 700, viewportWidth: 940 })).toMatchObject({ tier: 'tablet', searchCollapsed: true, filtersInPopover: true });
  });
  it('falls back to the viewport until the box is measured', () => {
    expect(computeLayout({ mapWidth: 0, viewportWidth: 1500 }).tier).toBe('desktop');
  });
});

describe('short viewports (landscape phones)', () => {
  const tall = computeLayout({ mapWidth: 400, viewportWidth: 400, viewportHeight: 844 });
  const land = computeLayout({ mapWidth: 844, viewportWidth: 844, viewportHeight: 390 });
  it('only a phone below SHORT_VIEWPORT_H compacts; unknown height counts as tall', () => {
    expect(tall).toMatchObject({ short: false, compact: false });
    expect(computeLayout({ mapWidth: 400, viewportWidth: 400 }).compact).toBe(false);
    expect(computeLayout({ mapWidth: 844, viewportWidth: 844, viewportHeight: SHORT_VIEWPORT_H })).toMatchObject({ short: false, compact: false });
    expect(land).toMatchObject({ tier: 'phone', short: true, compact: true });
    // a short desktop window keeps the desktop chrome
    expect(computeLayout({ mapWidth: 1300, viewportWidth: 1400, viewportHeight: 500 })).toMatchObject({ short: true, compact: false, tier: 'desktop' });
  });
  it('compact: one chrome row, no ticker, so the map keeps most of the height', () => {
    expect(tall.topInset).toBeGreaterThan(110);
    expect(land.topInset).toBeLessThan(70);
    expect(tall.bottomBand).toBe(108);
    expect(land.bottomBand).toBe(36);
    expect(land.statsBottom).toBe(0);
    // 390px viewport minus ~56px shell bar: the free map band is most of it
    const root = 334;
    expect(root - land.topInset - land.bottomBand).toBeGreaterThan(200);
    expect(root - tall.topInset - tall.bottomBand).toBeLessThan(110);
  });
  it('the camera insets follow the layout (top chrome, bottom band under the sheet)', () => {
    expect(cameraInsets({ layout: land, rightSlotOpen: false, showTimeline: false, sheetPx: 0 }).top).toBe(land.topInset);
    // sheet 120px from the bottom, a 36px band under the map => 84 covered (+12)
    expect(cameraInsets({ layout: land, rightSlotOpen: true, showTimeline: false, sheetPx: 120 }).bottom).toBe(96);
  });
});

describe('railMaxHeight: the control rail stops above the legend chip', () => {
  it('leaves the chip (and a gap) below the rail on a tall canvas', () => {
    expect(railMaxHeight({ rootHeight: 900, chipBottom: 116 })).toBe(900 - RAIL_TOP - (116 + CHIP_H + 8));
  });
  it('shrinks with the canvas (the rail would otherwise run into the legend / timeline)', () => {
    const tall = railMaxHeight({ rootHeight: 900, chipBottom: 116 })!;
    const short = railMaxHeight({ rootHeight: 560, chipBottom: 116 })!;
    expect(short).toBeLessThan(tall);
    expect(short + RAIL_TOP + 116 + CHIP_H + 8).toBeLessThanOrEqual(560);
  });
  it('a taller bottom stack (timeline shown) takes more room', () => {
    expect(railMaxHeight({ rootHeight: 700, chipBottom: 180 })!).toBeLessThan(railMaxHeight({ rootHeight: 700, chipBottom: 116 })!);
  });
  it('never below two buttons, and unset until the root has a height', () => {
    expect(railMaxHeight({ rootHeight: 200, chipBottom: 150 })).toBe(96);
    expect(railMaxHeight({ rootHeight: 0, chipBottom: 116 })).toBeUndefined();
  });
});

describe('chipPlacement: the legend chip stays below the top chrome', () => {
  it('leaves a roomy viewport alone', () => {
    expect(chipPlacement({ rootHeight: 900, wantBottom: 116, topInset: 124 })).toEqual({ bottom: 116, maxPanel: 440 });
  });
  it('clamps the chip under the lens strip on a short viewport and limits the open panel to the room above it', () => {
    // 334px root, old phone chrome (124 top), replay bar pushing the chip to 180
    const p = chipPlacement({ rootHeight: 334, wantBottom: 180, topInset: 124 });
    expect(p.bottom).toBe(334 - 124 - CHIP_H); // chip top sits exactly on the top chrome's edge
    expect(334 - p.bottom - CHIP_H).toBeGreaterThanOrEqual(124);
    expect(p.maxPanel).toBeGreaterThanOrEqual(96);
    // compact chrome: the chip sits where it wants and the panel gets real room
    const c = chipPlacement({ rootHeight: 334, wantBottom: 44, topInset: 64 });
    expect(c.bottom).toBe(44);
    expect(c.maxPanel).toBe(334 - 44 - CHIP_H - 8 - 64);
    // the expanded panel never reaches the top chrome
    expect(334 - c.bottom - CHIP_H - 8 - c.maxPanel).toBeGreaterThanOrEqual(64);
  });
  it('an unmeasured root changes nothing', () => {
    expect(chipPlacement({ rootHeight: 0, wantBottom: 116, topInset: 124 }).bottom).toBe(116);
  });
});

describe('initialSheetPx: what the first camera plan reserves for the sheet it is about to open', () => {
  it('is the peek fraction of the area', () => {
    expect(initialSheetPx(800)).toBe(240);
    expect(initialSheetPx(800, 1)).toBe(480);
    expect(initialSheetPx(0)).toBe(0);
  });
  it('feeds the first camera inset before the sheet has mounted or reported', () => {
    const phone = computeLayout({ mapWidth: 400, viewportWidth: 400, viewportHeight: 800 });
    // root 800 high, band 108 under the map: a 240px peek covers 132 of the map (+12)
    const first = cameraInsets({ layout: phone, rightSlotOpen: false, showTimeline: false, sheetPx: initialSheetPx(800) });
    expect(first.bottom).toBe(240 - 108 + 12);
    expect(first.bottom).toBeGreaterThan(cameraInsets({ layout: phone, rightSlotOpen: false, showTimeline: false, sheetPx: 0 }).bottom);
  });
});

describe('toolbar budget', () => {
  it('the full search only shows when the 7-lens strip (~565px) still fits beside it', () => {
    // inline: search 190 + period/source/refresh ~330 + gaps; the strip needs 565
    expect(TOOLBAR_FULL).toBeGreaterThanOrEqual(190 + 330 + 32 + 565 - 40);
    // a 1366px window with the sidebar open (1118px map => 1094px toolbar) folds the search
    expect(computeLayout({ mapWidth: 1118, viewportWidth: 1366 }).searchCollapsed).toBe(true);
    expect(computeLayout({ mapWidth: 1192, viewportWidth: 1440 }).searchCollapsed).toBe(false);
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
