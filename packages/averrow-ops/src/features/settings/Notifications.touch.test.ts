import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Row actions must not be hover-only: touch devices have no hover.
describe('Notifications row actions', () => {
  const src = readFileSync(resolve(__dirname, 'Notifications.tsx'), 'utf8');
  it('is revealed on touch (hover:none) and on keyboard focus', () => {
    const line = src.split('\n').find((l) => l.includes('group-hover:opacity-100'));
    expect(line).toBeDefined();
    expect(line).toContain('[@media(hover:none)]:opacity-100');
    expect(line).toContain('focus-within:opacity-100');
  });
});
