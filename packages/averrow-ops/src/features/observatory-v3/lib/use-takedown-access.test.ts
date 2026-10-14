import { describe, it, expect } from 'vitest';
import { canSeeTakedowns, takedownAccess } from './use-takedown-access';

describe('canSeeTakedowns (mirrors the server manage_takedowns gate)', () => {
  it.each(['super_admin', 'admin', 'analyst'])('%s can', role => expect(canSeeTakedowns(role)).toBe(true));
  it.each(['sales', 'support', 'billing', 'auditor', 'client', undefined, null])('%s cannot', role => expect(canSeeTakedowns(role as string | null | undefined)).toBe(false));
});

describe('takedownAccess: a link is only refused once the role is known', () => {
  it('allowed, denied, and unknown while there is no user', () => {
    expect(takedownAccess({ role: 'analyst' })).toBe('allowed');
    expect(takedownAccess({ role: 'sales' })).toBe('denied');
    expect(takedownAccess({ role: null })).toBe('denied');
    expect(takedownAccess(null)).toBe('unknown');
    expect(takedownAccess(undefined)).toBe('unknown');
  });
});
