// Pure-function tests for the security helpers exported by
// @averrow/shared/auth. Lives in averrow-ops because shared
// doesn't carry its own vitest config; both products consume the
// same helpers so co-locating tests with one host is fine.

import { describe, it, expect } from 'vitest';
import { isSafeReturnTo, isValidCachedUser } from '@averrow/shared/auth';

describe('isSafeReturnTo (returnToPrefix boundary)', () => {
  it('exact prefix match is safe', () => {
    expect(isSafeReturnTo('/v2', '/v2')).toBe(true);
  });

  it('child path is safe', () => {
    expect(isSafeReturnTo('/v2/', '/v2')).toBe(true);
    expect(isSafeReturnTo('/v2/profile', '/v2')).toBe(true);
    expect(isSafeReturnTo('/v2/admin/customers', '/v2')).toBe(true);
  });

  it('query string + fragment are safe', () => {
    expect(isSafeReturnTo('/v2?next=foo', '/v2')).toBe(true);
    expect(isSafeReturnTo('/v2#token=x', '/v2')).toBe(true);
  });

  it('rejects prefix-boundary attacks (the H1 fix)', () => {
    // These all `startsWith('/v2')` but are NOT safe child paths.
    expect(isSafeReturnTo('/v2evil/path',  '/v2')).toBe(false);
    expect(isSafeReturnTo('/v2attacker',   '/v2')).toBe(false);
    expect(isSafeReturnTo('/v2.evil.com',  '/v2')).toBe(false);
    expect(isSafeReturnTo('/v23',          '/v2')).toBe(false);
    expect(isSafeReturnTo('/v2-evil',      '/v2')).toBe(false);
  });

  it('rejects entirely-different paths', () => {
    expect(isSafeReturnTo('/admin',     '/v2')).toBe(false);
    expect(isSafeReturnTo('/tenant/',   '/v2')).toBe(false);
    expect(isSafeReturnTo('https://evil.com/v2/', '/v2')).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(isSafeReturnTo('',     '/v2')).toBe(false);
    expect(isSafeReturnTo('/v2',  '')).toBe(false);
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
