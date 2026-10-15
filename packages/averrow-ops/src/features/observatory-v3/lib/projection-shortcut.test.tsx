import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { isProjectionKey, SHORTCUT_HELP, PROJECTION_KEY, type KeyLike } from './shortcuts';
import { useProjectionShortcut } from './use-projection-shortcut';

const key = (over: Partial<KeyLike> = {}): KeyLike => ({
  key: 'g', ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: document.body, ...over,
});

describe('isProjectionKey: G flips Flat | Globe', () => {
  it('plain g / G, from the page', () => {
    expect(isProjectionKey(key())).toBe(true);
    expect(isProjectionKey(key({ key: 'G' }))).toBe(true);
    expect(PROJECTION_KEY).toBe('g');
  });
  it('not with a modifier, not when already handled, not a held repeat, not another key', () => {
    expect(isProjectionKey(key({ ctrlKey: true }))).toBe(false);
    expect(isProjectionKey(key({ metaKey: true }))).toBe(false);
    expect(isProjectionKey(key({ altKey: true }))).toBe(false);
    expect(isProjectionKey(key({ defaultPrevented: true }))).toBe(false);
    expect(isProjectionKey(key({ repeat: true }))).toBe(false);
    expect(isProjectionKey(key({ key: 'h' }))).toBe(false);
  });
  it('not while typing in a field, a listbox or a dialog', () => {
    const input = document.createElement('input');
    const dlg = document.createElement('div');
    dlg.setAttribute('role', 'dialog');
    const inner = document.createElement('button');
    dlg.appendChild(inner);
    expect(isProjectionKey(key({ target: input }))).toBe(false);
    expect(isProjectionKey(key({ target: inner }))).toBe(false);
  });
  it('is listed with the other shortcuts', () => {
    expect(SHORTCUT_HELP.find(s => s.keys === 'G')?.label).toMatch(/globe/i);
    expect(SHORTCUT_HELP.find(s => s.keys === '1')).toBeDefined();
  });
});

describe('useProjectionShortcut', () => {
  const press = (init: KeyboardEventInit, target: EventTarget = window) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  };

  it('calls back on G from anywhere on the page', () => {
    const cb = vi.fn();
    renderHook(() => useProjectionShortcut(cb, true));
    press({ key: 'g' });
    press({ key: 'G' });
    expect(cb).toHaveBeenCalledTimes(2);
  });
  it('ignores G in a field and with a modifier', () => {
    const cb = vi.fn();
    renderHook(() => useProjectionShortcut(cb, true));
    const input = document.createElement('input');
    document.body.appendChild(input);
    press({ key: 'g' }, input);
    press({ key: 'g', ctrlKey: true });
    expect(cb).not.toHaveBeenCalled();
    input.remove();
  });
  it('does nothing when disabled and stops listening on unmount', () => {
    const cb = vi.fn();
    const off = renderHook(() => useProjectionShortcut(cb, false));
    press({ key: 'g' });
    expect(cb).not.toHaveBeenCalled();
    off.unmount();
    const on = renderHook(() => useProjectionShortcut(cb, true));
    on.unmount();
    press({ key: 'g' });
    expect(cb).not.toHaveBeenCalled();
  });
});
