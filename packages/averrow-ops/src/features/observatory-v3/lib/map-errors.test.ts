import { describe, it, expect } from 'vitest';
import { classifyMapError } from './map-errors';

describe('classifyMapError', () => {
  it('treats tile / source failures as transient', () => {
    expect(classifyMapError({ tile: {}, error: { message: 'x' } }, { styleLoaded: false })).toBe('transient');
    expect(classifyMapError({ sourceId: 'carto', error: { message: 'Failed to fetch' } }, { styleLoaded: false })).toBe('transient');
  });
  it('treats everything after the style has loaded as transient', () => {
    expect(classifyMapError({ error: { message: 'style is not done loading' } }, { styleLoaded: true })).toBe('transient');
  });
  it('treats a base-style load failure as fatal', () => {
    expect(classifyMapError({ error: { message: 'Failed to fetch', url: 'https://x/dark-matter-gl-style/style.json' } }, { styleLoaded: false })).toBe('fatal');
    expect(classifyMapError({ error: { message: 'Style could not be loaded' } }, { styleLoaded: false })).toBe('fatal');
  });
  it('treats unknown pre-load errors as transient (glyph / sprite hiccups)', () => {
    expect(classifyMapError({ error: { message: 'glyph 404' } }, { styleLoaded: false })).toBe('transient');
    expect(classifyMapError({}, { styleLoaded: false })).toBe('transient');
  });
});
