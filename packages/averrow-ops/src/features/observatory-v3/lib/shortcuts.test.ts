import { describe, it, expect } from 'vitest';
import { layerForKey, targetOwnsKeys } from './shortcuts';

const base = { ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false };
const el = (html: string): Element => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild!;
};

describe('layerForKey', () => {
  it('maps 1-9 to layers anywhere on the map', () => {
    expect(layerForKey({ ...base, key: '1', target: document.body })).toBe('nodes');
    expect(layerForKey({ ...base, key: '3', target: document.body })).toBe('beams');
    expect(layerForKey({ ...base, key: '6', target: document.body })).toBe('hosting');
    expect(layerForKey({ ...base, key: 'x', target: document.body })).toBeNull();
    expect(layerForKey({ ...base, key: '0', target: document.body })).toBeNull();
  });
  it('ignores modified and already-handled keys', () => {
    expect(layerForKey({ ...base, key: '3', ctrlKey: true, target: document.body })).toBeNull();
    expect(layerForKey({ ...base, key: '3', metaKey: true, target: document.body })).toBeNull();
    expect(layerForKey({ ...base, key: '3', altKey: true, target: document.body })).toBeNull();
    expect(layerForKey({ ...base, key: '3', defaultPrevented: true, target: document.body })).toBeNull();
  });
  it.each([
    ['text field', '<input />'],
    ['textarea', '<textarea></textarea>'],
    ['select', '<select><option>a</option></select>'],
    ['slider (the replay bar)', '<div role="slider" tabindex="0"></div>'],
    ['listbox', '<ul role="listbox"><li role="option">a</li></ul>'],
    ['dialog (the drawer)', '<aside role="dialog"><button>go</button></aside>'],
    ['tab (the lens strip)', '<div role="tablist"><button role="tab">Threats</button></div>'],
    ['combobox (search)', '<input role="combobox" />'],
    ['radio group', '<div role="radiogroup"><button role="radio">7D</button></div>'],
    ['menu', '<div role="menu"><button role="menuitem">x</button></div>'],
  ])('does not fire inside a %s', (_n, html) => {
    const root = el(html);
    const inner = root.querySelector('button, li, input, select, textarea') ?? root;
    expect(layerForKey({ ...base, key: '3', target: inner })).toBeNull();
    expect(layerForKey({ ...base, key: '3', target: root })).toBeNull();
  });
  it('still fires from a plain button on the map chrome', () => {
    const b = el('<div><button>Refresh</button></div>').querySelector('button')!;
    expect(layerForKey({ ...base, key: '2', target: b })).toBe('particles');
    expect(targetOwnsKeys(b)).toBe(false);
  });
});
