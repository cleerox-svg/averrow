// Pure-function tests for the security helpers exported by
// @averrow/shared/auth. Lives in averrow-ops because shared
// doesn't carry its own vitest config; both products consume the
// same helpers so co-locating tests with one host is fine.

import { describe, it, expect } from 'vitest';
import { isSafeReturnTo, isValidCachedUser } from '@averrow/shared/auth';

describe('isSafeReturnTo (returnToPrefix boundary)', () => {
  it('exact prefix match is safe', () => {
    expect(isSafeReturnTo('/ops', '/ops')).toBe(true);
  });

  it('child path is safe', () => {
    expect(isSafeReturnTo('/ops/', '/ops')).toBe(true);
    expect(isSafeReturnTo('/ops/profile', '/ops')).toBe(true);
    expect(isSafeReturnTo('/ops/admin/customers', '/ops')).toBe(true);
  });

  it('query string + fragment are safe', () => {
    expect(isSafeReturnTo('/ops?next=foo', '/ops')).toBe(true);
    expect(isSafeReturnTo('/ops#token=x', '/ops')).toBe(true);
  });

  it('rejects prefix-boundary attacks (the H1 fix)', () => {
    // These all `startsWith('/ops')` but are NOT safe child paths.
    expect(isSafeReturnTo('/opsevil/path',  '/ops')).toBe(false);
    expect(isSafeReturnTo('/opsattacker',   '/ops')).toBe(false);
    expect(isSafeReturnTo('/ops.evil.com',  '/ops')).toBe(false);
    expect(isSafeReturnTo('/ops3',          '/ops')).toBe(false);
    expect(isSafeReturnTo('/ops-evil',      '/ops')).toBe(false);
  });

  it('rejects entirely-different paths', () => {
    expect(isSafeReturnTo('/admin',     '/ops')).toBe(false);
    expect(isSafeReturnTo('/tenant/',   '/ops')).toBe(false);
    expect(isSafeReturnTo('https://evil.com/ops/', '/ops')).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(isSafeReturnTo('',     '/ops')).toBe(false);
    expect(isSafeReturnTo('/ops',  '')).toBe(false);
  });

  it('works for tenant prefix too', () => {
    expect(isSafeReturnTo('/tenant/profile', '/tenant')).toBe(true);
    expect(isSafeReturnTo('/tenantattacker', '/tenant')).toBe(false);
  });
});

describe('isValidCachedUser (M2 shape validation)', () => {
  it('accepts a minimal valid user', () => {
    expect(isValidCachedUser({
      id:    'u_1',
      email: 'a@b.com',
      name:  'Alice',
      role:  'admin',
    })).toBe(true);
  });

  it('accepts a user with a valid organization block', () => {
    expect(isValidCachedUser({
      id:    'u_1',
      email: 'a@b.com',
      name:  'Alice',
      role:  'client',
      organization: {
        id: 1, name: 'Acme', slug: 'acme', plan: 'enterprise', role: 'admin',
      },
    })).toBe(true);
  });

  it('rejects null and primitives', () => {
    expect(isValidCachedUser(null)).toBe(false);
    expect(isValidCachedUser(undefined)).toBe(false);
    expect(isValidCachedUser('not an object')).toBe(false);
    expect(isValidCachedUser(42)).toBe(false);
  });

  it('rejects when required string fields are missing', () => {
    expect(isValidCachedUser({ email: 'a@b.com', name: 'A', role: 'admin' })).toBe(false);
    expect(isValidCachedUser({ id: 'u_1', name: 'A', role: 'admin' })).toBe(false);
    expect(isValidCachedUser({ id: 'u_1', email: 'a@b.com', role: 'admin' })).toBe(false);
    expect(isValidCachedUser({ id: 'u_1', email: 'a@b.com', name: 'A' })).toBe(false);
  });

  it('rejects wrong types on required fields', () => {
    expect(isValidCachedUser({ id: 1, email: 'a@b.com', name: 'A', role: 'admin' })).toBe(false);
    expect(isValidCachedUser({ id: 'u_1', email: 1, name: 'A', role: 'admin' })).toBe(false);
  });

  it('rejects malformed organization', () => {
    expect(isValidCachedUser({
      id: 'u_1', email: 'a@b.com', name: 'A', role: 'admin',
      organization: { id: '1', name: 'Acme', slug: 'acme', plan: 'pro', role: 'owner' },
      // ^ id should be number, not string
    })).toBe(false);
    expect(isValidCachedUser({
      id: 'u_1', email: 'a@b.com', name: 'A', role: 'admin',
      organization: 'not an object',
    })).toBe(false);
  });

  it('accepts null organization explicitly', () => {
    expect(isValidCachedUser({
      id: 'u_1', email: 'a@b.com', name: 'A', role: 'admin',
      organization: null,
    })).toBe(true);
  });
});
