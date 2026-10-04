import { describe, it, expect } from 'vitest';
import { canTriageFor, isStaffRole, alertAssigneeLabel } from './alerts';

describe('canTriageFor', () => {
  it.each(['super_admin', 'admin', 'analyst', 'sales', 'support', 'billing', 'auditor'])(
    'is false for staff role %s even with an owner org role',
    (role) => {
      expect(canTriageFor(role, 'owner')).toBe(false);
      expect(canTriageFor(role, null)).toBe(false);
    },
  );

  it.each(['analyst', 'admin', 'owner'])('is true for a client with org role %s', (orgRole) => {
    expect(canTriageFor('client', orgRole)).toBe(true);
  });

  it('is false for a client viewer or no org role', () => {
    expect(canTriageFor('client', 'viewer')).toBe(false);
    expect(canTriageFor('client', null)).toBe(false);
    expect(canTriageFor(undefined, undefined)).toBe(false);
  });
});

describe('isStaffRole', () => {
  it('treats every non-client role as staff', () => {
    expect(isStaffRole('super_admin')).toBe(true);
    expect(isStaffRole('auditor')).toBe(true);
    expect(isStaffRole('client')).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });
});

describe('alertAssigneeLabel', () => {
  it('prefers assigned_to_name', () => {
    expect(alertAssigneeLabel({ assigned_to_name: 'Jane', handled_by_averrow: false })).toBe('Jane');
    expect(alertAssigneeLabel({ assigned_to_name: 'Averrow SOC', handled_by_averrow: true })).toBe('Averrow SOC');
  });
  it('falls back to Averrow SOC when staff hold it without a name', () => {
    expect(alertAssigneeLabel({ assigned_to_name: null, handled_by_averrow: true })).toBe('Averrow SOC');
  });
  it('is null when truly unassigned', () => {
    expect(alertAssigneeLabel({ assigned_to_name: null })).toBeNull();
  });
});
