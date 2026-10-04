import { describe, it, expect } from 'vitest';
import { canManageCrossover } from './staffCrossover';

describe('canManageCrossover — staff crossover surfaces mirror the worker org gates', () => {
  it('super_admin always passes (incl. no org seat)', () => {
    expect(canManageCrossover('super_admin', undefined, 'admin')).toBe(true);
    expect(canManageCrossover('super_admin', 'owner', 'analyst')).toBe(true);
  });

  it('the read-only auditor seat never passes', () => {
    expect(canManageCrossover('auditor', 'owner', 'analyst')).toBe(false);
  });

  it('everyone else needs the required org role', () => {
    expect(canManageCrossover('client', 'analyst', 'analyst')).toBe(true);
    expect(canManageCrossover('client', 'viewer', 'analyst')).toBe(false);
    expect(canManageCrossover('client', 'analyst', 'admin')).toBe(false);
    expect(canManageCrossover('client', 'owner', 'admin')).toBe(true);
    expect(canManageCrossover('admin', 'owner', 'admin')).toBe(true);
    expect(canManageCrossover('analyst', undefined, 'analyst')).toBe(false);
  });
});
