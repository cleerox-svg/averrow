import { describe, it, expect } from 'vitest';
import { safeJsonParse, parseStringArray } from './safe-json';

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', null)).toEqual({ a: 1 });
  });
  it('returns the fallback for null, empty and malformed input', () => {
    expect(safeJsonParse(null, 'x')).toBe('x');
    expect(safeJsonParse(undefined, 'x')).toBe('x');
    expect(safeJsonParse('', 'x')).toBe('x');
    expect(safeJsonParse('{oops', 'x')).toBe('x');
  });
});

describe('parseStringArray', () => {
  it('returns string members only', () => {
    expect(parseStringArray('["US","DE",3,null]')).toEqual(['US', 'DE']);
  });
  it('returns [] for non-arrays and malformed JSON', () => {
    expect(parseStringArray('{"a":1}')).toEqual([]);
    expect(parseStringArray('US,DE')).toEqual([]);
    expect(parseStringArray(null)).toEqual([]);
  });
});
