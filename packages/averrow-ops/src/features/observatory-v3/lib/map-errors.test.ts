import { describe, it, expect } from 'vitest';
import { classifyMapError } from './map-errors';

const STYLE = 'https://x/dark-matter-gl-style/style.json';

describe('classifyMapError', () => {
  it('treats tile / source failures as transient', () => {
    expect(classifyMapError({ tile: {}, error: { message: 'x' } }, { styleLoaded: false, styleUrl: STYLE })).toBe('transient');
    expect(classifyMapError({ sourceId: 'carto', error: { message: 'Failed to fetch' } }, { styleLoaded: false, styleUrl: STYLE })).toBe('transient');
  });
  it('treats everything after the style has loaded as transient', () => {
    expect(classifyMapError({ error: { message: 'style is not done loading' } }, { styleLoaded: true, styleUrl: STYLE })).toBe('transient');
  });
  it('treats a base-style load failure as fatal', () => {
    expect(classifyMapError({ error: { message: 'Failed to fetch', url: STYLE } }, { styleLoaded: false, styleUrl: STYLE })).toBe('fatal');
    expect(classifyMapError({ error: { message: 'Style could not be loaded' } }, { styleLoaded: false, styleUrl: STYLE })).toBe('fatal');
  });
  it('treats unknown pre-load errors as transient (glyph / sprite hiccups)', () => {
    expect(classifyMapError({ error: { message: 'glyph 404' } }, { styleLoaded: false, styleUrl: STYLE })).toBe('transient');
    expect(classifyMapError({}, { styleLoaded: false, styleUrl: STYLE })).toBe('transient');
  });
  it('treats a sprite / glyph failure under the style directory as transient (the word "style" is in its URL)', () => {
    expect(classifyMapError({ error: { message: 'Failed to fetch', status: 404, url: 'https://x/dark-matter-gl-style/sprite.json' } }, { styleLoaded: false, styleUrl: STYLE })).toBe('transient');
    expect(classifyMapError({ error: { message: 'Not Found', url: 'https://x/dark-matter-gl-style/sprite@2x.png' } }, { styleLoaded: false, styleUrl: STYLE })).toBe('transient');
  });
  it('is fatal only for the style document itself (ignoring query string)', () => {
    expect(classifyMapError({ error: { message: 'Not Found', status: 404, url: STYLE + '?v=2' } }, { styleLoaded: false, styleUrl: STYLE })).toBe('fatal');
    expect(classifyMapError({ error: { message: 'x', url: 'https://other/style.json' } }, { styleLoaded: false, styleUrl: STYLE })).toBe('transient');
  });
});
