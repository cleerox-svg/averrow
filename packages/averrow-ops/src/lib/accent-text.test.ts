import { describe, it, expect } from 'vitest';
import { accentText } from './accent-text';

describe('accentText', () => {
  it('maps raw accents to theme-aware text tokens', () => {
    expect(accentText('#E5A832')).toBe('var(--amber-text)');
    expect(accentText('var(--green)')).toBe('var(--green-text)');
    expect(accentText('#C83C3C')).toBe('var(--red-text)');
    expect(accentText('#9B59B6')).toBe('var(--violet-text)');
  });
  it('passes unknown values through', () => {
    expect(accentText('#123456')).toBe('#123456');
  });
});
