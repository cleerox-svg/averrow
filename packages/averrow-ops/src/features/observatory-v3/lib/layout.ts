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

import { snapFraction } from './sheet';

export const RAIL_WIDTH = 44;
export const DOCK_WIDTH = 320;
export const TOOLBAR_H = 44;
export const MOBILE_BREAKPOINT = 900;
/** Map width at which a 320px dock still leaves the map room to breathe: a 1440px window with the 248px sidebar open leaves 1192px, so 1440 docks and anything narrower floats. */
export const DOCK_MIN_MAP = 1190;
/** Toolbar width needed to show tabs + a full search box + period + source + refresh (about a 1400px window with the sidebar open; the 7-lens strip needs ~565px of what is left, so any narrower and the search folds first). */
export const TOOLBAR_FULL = 1120;
/** Toolbar width below which period + source fold into one filters popover. */
export const TOOLBAR_INLINE_FILTERS = 970;
/** Side padding of the toolbar row. */
export const TOOLBAR_GUTTER = 12;

/** Viewport height below which the phone chrome compacts (landscape phones are ~375-430px tall). */
export const SHORT_VIEWPORT_H = 560;

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
  /** The viewport is short (landscape phone): one chrome row, no headline bar or replay bar. */
  short: boolean;
  /** Phone in a short viewport: lens strip, filters, search and refresh share ONE 48px row. */
  compact: boolean;
  /** Height reserved under the map element for the stats bar (+ headline bar), px. */
  bottomBand: number;
  /** Stats bar offset from the page bottom (= the headline-bar height under it), px. */
  statsBottom: number;
  /** What the top chrome covers, px (camera inset + the first free y for floating UI). */
  topInset: number;
}

export interface LayoutInput {
  /** Measured width of the Observatory box (px). 0 / unknown falls back to the viewport. */
  mapWidth: number;
  viewportWidth: number;
  /** Window height (px). Unknown / 0 counts as tall. */
  viewportHeight?: number;
}

export function computeLayout({ mapWidth, viewportWidth, viewportHeight = 0 }: LayoutInput): ObservatoryLayout {
  const phone = viewportWidth < MOBILE_BREAKPOINT;
  const width = mapWidth > 0 ? mapWidth : viewportWidth;
  const short = viewportHeight > 0 && viewportHeight < SHORT_VIEWPORT_H;
  if (phone) {
    const compact = short;
    return {
      tier: 'phone', phone: true, railWidth: 0, docked: false, dockWidth: 0,
      toolbarWidth: width, searchCollapsed: true, filtersInPopover: true, panelStartsOpen: false,
      short, compact,
      bottomBand: compact ? STATS_H : BOTTOM_BAND.phone,
      statsBottom: compact ? 0 : TICKER_H.phone,
      topInset: compact ? TOP_COMPACT : TOP_PHONE,
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
    short, compact: false,
    bottomBand: BOTTOM_BAND.desktop,
    statsBottom: TICKER_H.desktop,
    topInset: TOP_DESKTOP,
  };
}

// ─── Camera insets ──────────────────────────────────────────

/** Replay bar height (it floats above the stats bar). */
export const TIMELINE_H = 56;
/** Stats bar height. */
export const STATS_H = 36;
/** Headline-bar (intel feed) height under the stats bar. */
export const TICKER_H = { desktop: 40, phone: 72 } as const;
/** Height of the stats bar + headline-bar band below the map element: desktop 36 + 40, phone 36 + 72. */
export const BOTTOM_BAND = { desktop: STATS_H + TICKER_H.desktop, phone: STATS_H + TICKER_H.phone } as const;
const TOP_DESKTOP = 8 + TOOLBAR_H + 12;
/** Phone: summary row (48) + lens strip (48) + gaps. */
const TOP_PHONE = 8 + 48 + 8 + 48 + 12;
/** Short phone: ONE 48px row. */
const TOP_COMPACT = 8 + 48 + 8;

export interface InsetInput {
  layout: Pick<ObservatoryLayout, 'phone' | 'railWidth' | 'topInset' | 'bottomBand'>;
  /** A panel or drawer occupies the right slot (docked or floating: either way it covers the map). */
  rightSlotOpen: boolean;
  showTimeline: boolean;
  /** Height of the open peek sheet in px (0 = none), measured from the page bottom. */
  sheetPx: number;
  /** The active-filter chip row under the toolbar, px (0 = none): the camera must not frame a target beneath it. */
  chipRowHeight?: number;
}

/** Gap between the chip row and the toolbar above / the map content below it, px. */
export const CHIP_ROW_GAP = 8;

export interface Insets { top: number; right: number; bottom: number; left: number }

/**
 * What covers each edge of the MAP element, in px, so a camera move frames its
 * target in the area that is actually left free: the toolbar on top, the rail on
 * the left, the drawer / panel on the right, the replay bar or the phone sheet at
 * the bottom.
 */
export function cameraInsets(i: InsetInput): Insets {
  const { layout, rightSlotOpen, showTimeline, sheetPx, chipRowHeight = 0 } = i;
  const left = layout.railWidth > 0 ? 12 + layout.railWidth + 12 : 12;
  const right = rightSlotOpen && !layout.phone ? DOCK_WIDTH + 24 : 12;
  let bottom = showTimeline ? TIMELINE_H + 24 : 12;
  if (layout.phone && sheetPx > 0) bottom = Math.max(bottom, sheetPx - layout.bottomBand + 12);
  return { top: layout.topInset + (chipRowHeight > 0 ? chipRowHeight + CHIP_ROW_GAP : 0), right, bottom, left };
}

// ─── Floating UI that rides the bottom edge ─────────────────

/** Closed legend chip height (touch). */
export const CHIP_H = 44;

export interface ChipPlacement {
  /** `bottom` offset of the legend chip / Intel FAB from the page bottom. */
  bottom: number;
  /** Max height of the expanded legend panel above the chip. */
  maxPanel: number;
}

/**
 * Where the legend chip sits and how tall its panel may grow. The chip rides above the replay bar /
 * stats band, but never higher than the top chrome allows: on a short viewport the wanted offset
 * would put it under the lens strip, so it is clamped, and the expanded panel is limited to the room
 * between the chip and the top chrome.
 */
export function chipPlacement(i: { rootHeight: number; wantBottom: number; topInset: number }): ChipPlacement {
  const { rootHeight, wantBottom, topInset } = i;
  if (rootHeight <= 0) return { bottom: wantBottom, maxPanel: 440 };
  const bottom = Math.max(0, Math.min(wantBottom, rootHeight - topInset - CHIP_H));
  const maxPanel = Math.max(96, Math.min(440, rootHeight - bottom - CHIP_H - 8 - topInset));
  return { bottom, maxPanel };
}

/** Top of the control rail (under the one-row toolbar). */
export const RAIL_TOP = 60;

/**
 * Tallest the control rail may be. The legend chip (and the replay timeline above it) shares the rail's left edge, so on
 * a short canvas the rail would run into them: it stops a gap above the chip and scrolls instead. Never less than two
 * buttons' worth. `undefined` while the root has no height yet.
 */
export function railMaxHeight(i: { rootHeight: number; chipBottom: number }): number | undefined {
  if (!(i.rootHeight > 0)) return undefined;
  return Math.max(96, Math.floor(i.rootHeight - RAIL_TOP - (i.chipBottom + CHIP_H + 8)));
}

/** Initial height (px) of a phone peek sheet in an area of `areaPx`: lets the camera plan for it before it has mounted. */
export function initialSheetPx(areaPx: number, snap = 0): number {
  return Math.round(snapFraction(snap) * Math.max(0, areaPx));
}
