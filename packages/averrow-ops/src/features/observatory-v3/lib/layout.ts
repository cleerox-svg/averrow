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

// ─── Camera insets ──────────────────────────────────────────

/** Replay bar height (it floats above the stats bar). */
export const TIMELINE_H = 56;
/** Height of the stats bar + ticker band below the map element: desktop 36 + 40, phone 36 + 72. */
export const BOTTOM_BAND = { desktop: 76, phone: 108 } as const;
const TOP_DESKTOP = 8 + TOOLBAR_H + 12;
/** Phone: summary row (48) + lens strip (48) + gaps. */
const TOP_PHONE = 8 + 48 + 8 + 48 + 12;

export interface InsetInput {
  layout: Pick<ObservatoryLayout, 'phone' | 'railWidth'>;
  /** A panel or drawer occupies the right slot (docked or floating: either way it covers the map). */
  rightSlotOpen: boolean;
  showTimeline: boolean;
  /** Height of the open peek sheet in px (0 = none), measured from the page bottom. */
  sheetPx: number;
}

export interface Insets { top: number; right: number; bottom: number; left: number }

/**
 * What covers each edge of the MAP element, in px, so a camera move frames its
 * target in the area that is actually left free: the toolbar on top, the rail on
 * the left, the drawer / panel on the right, the replay bar or the phone sheet at
 * the bottom.
 */
export function cameraInsets(i: InsetInput): Insets {
  const { layout, rightSlotOpen, showTimeline, sheetPx } = i;
  const left = layout.railWidth > 0 ? 12 + layout.railWidth + 12 : 12;
  const right = rightSlotOpen && !layout.phone ? DOCK_WIDTH + 24 : 12;
  let bottom = showTimeline ? TIMELINE_H + 24 : 12;
  if (layout.phone && sheetPx > 0) bottom = Math.max(bottom, sheetPx - BOTTOM_BAND.phone + 12);
  return { top: layout.phone ? TOP_PHONE : TOP_DESKTOP, right, bottom, left };
}
