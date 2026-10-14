/**
 * Console layout tiers, decided from the width the MAP actually has (the
 * Observatory's own box, measured), not the viewport: the app shell's sidebar,
 * a docked panel and the browser window all change what is left for the map.
 *
 *   phone    viewport < 900: mobile chrome (summary row + lens strip, peek sheet)
 *   tablet   map < DOCK_MIN_MAP: 44px rail, intel panel and drawer OVERLAY the map
 *   desktop  map >= DOCK_MIN_MAP: 44px rail, intel panel / drawer DOCK on the right
 *
 * The toolbar is one row across the whole map (the dock and the rail start below
 * it). It degrades by its own width: the search box folds to an icon, then period
 * + source fold into one popover.
 */

export const RAIL_WIDTH = 44;
export const DOCK_WIDTH = 320;
export const TOOLBAR_H = 44;
export const MOBILE_BREAKPOINT = 900;
/** Map width at which a 320px dock still leaves the map room to breathe (about a 1440px window with the sidebar open). */
export const DOCK_MIN_MAP = 1160;
/** Toolbar width needed to show tabs + a full search box + period + source + refresh (about a 1360px window with the sidebar open). */
export const TOOLBAR_FULL = 1090;
/** Toolbar width below which period + source fold into one filters popover. */
export const TOOLBAR_INLINE_FILTERS = 860;
/** Side padding of the toolbar row. */
export const TOOLBAR_GUTTER = 12;

export type LayoutTier = 'phone' | 'tablet' | 'desktop';

export interface ObservatoryLayout {
  tier: LayoutTier;
  /** Mobile chrome (no rail, peek sheet). */
  phone: boolean;
  railWidth: number;
  /** The intelligence panel / drawer take their own column; otherwise they float over the map. */
  docked: boolean;
  dockWidth: number;
  /** Width of the toolbar row (the whole map minus its gutters). */
  toolbarWidth: number;
  /** Search shows as an icon button that opens the field. */
  searchCollapsed: boolean;
  /** Period + source live in a popover instead of inline. */
  filtersInPopover: boolean;
  /** The intel panel starts open (only worth it when it docks). */
  panelStartsOpen: boolean;
}

export interface LayoutInput {
  /** Measured width of the Observatory box (px). 0 / unknown falls back to the viewport. */
  mapWidth: number;
  viewportWidth: number;
}

export function computeLayout({ mapWidth, viewportWidth }: LayoutInput): ObservatoryLayout {
  const phone = viewportWidth < MOBILE_BREAKPOINT;
  const width = mapWidth > 0 ? mapWidth : viewportWidth;
  if (phone) {
    return {
      tier: 'phone', phone: true, railWidth: 0, docked: false, dockWidth: 0,
      toolbarWidth: width, searchCollapsed: true, filtersInPopover: true, panelStartsOpen: false,
    };
  }
  const docked = width >= DOCK_MIN_MAP;
  const toolbarWidth = Math.max(0, width - TOOLBAR_GUTTER * 2);
  return {
    tier: docked ? 'desktop' : 'tablet',
    phone: false,
    railWidth: RAIL_WIDTH,
    docked,
    dockWidth: docked ? DOCK_WIDTH : 0,
    toolbarWidth,
    searchCollapsed: toolbarWidth < TOOLBAR_FULL,
    filtersInPopover: toolbarWidth < TOOLBAR_INLINE_FILTERS,
    panelStartsOpen: docked,
  };
}
