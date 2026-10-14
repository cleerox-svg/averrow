/**
 * Keyboard shortcuts for the Observatory: the 1-9 layer keys.
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
