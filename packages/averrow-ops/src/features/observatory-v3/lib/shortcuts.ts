/**
 * Keyboard shortcuts for the Observatory: the 1-9 layer keys and `G` (Flat | Globe).
 *
 * Digits are also how people operate sliders, listboxes, tab lists and dialogs
 * (type-ahead, value entry), so a layer key must never fire while focus is in
 * one of those. The handler is attached to the console wrapper, so events from
 * the drawer, the search list and the replay slider all bubble through it.
 */

import { LAYER_DEFS, type LayerId } from './lenses';

/** Elements / roles that own their own keyboard handling. */
const OWNS_KEYS = [
  'input', 'textarea', 'select',
  '[contenteditable=""]', '[contenteditable="true"]',
  '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]', '[role="spinbutton"]',
  '[role="slider"]', '[role="listbox"]', '[role="option"]', '[role="menu"]', '[role="menuitem"]',
  '[role="dialog"]', '[role="alertdialog"]', '[role="tab"]', '[role="tablist"]', '[role="radiogroup"]',
].join(',');

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  /** A held key repeating: the projection must not flip back and forth while G is down. */
  repeat?: boolean;
}

/** True when a digit pressed here belongs to the focused control, not to the map. */
export function targetOwnsKeys(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(OWNS_KEYS);
}

/** The layer a keypress toggles, or null (modified keys, fields, sliders, listboxes, dialogs, tabs …). */
export function layerForKey(e: KeyLike): LayerId | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (targetOwnsKeys(e.target)) return null;
  return LAYER_DEFS.find(d => d.key === e.key)?.id ?? null;
}

/** The Flat | Globe shortcut key (case-insensitive). */
export const PROJECTION_KEY = 'g';

/** True when this keypress is the Flat | Globe shortcut: plain `G`, not in a field / list / dialog, not a held repeat. */
export function isProjectionKey(e: KeyLike): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false;
  if (e.key.toLowerCase() !== PROJECTION_KEY) return false;
  return !targetOwnsKeys(e.target);
}

/**
 * Every shortcut the console has, in one list: the single source for the keys shown in tooltips and the toggle's own hint.
 * (There is no separate help overlay: the keys are shown where the control is.)
 */
export const SHORTCUT_HELP: ReadonlyArray<{ keys: string; label: string }> = [
  ...LAYER_DEFS.map(d => ({ keys: d.key, label: `Toggle ${d.id}` })),
  { keys: PROJECTION_KEY.toUpperCase(), label: 'Switch between the flat map and the globe' },
];
