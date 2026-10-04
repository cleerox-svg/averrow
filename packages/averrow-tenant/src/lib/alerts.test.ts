import { describe, it, expect } from 'vitest';
import {
  canTriageFor, isStaffRole, alertAssigneeLabel,
  chunkIds, runChunkedBulk, TENANT_BULK_MAX_ALERTS,
} from './alerts';

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

describe('chunkIds', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `a_${i}`);
  it('splits 200 ids into 90/90/20', () => {
    expect(chunkIds(ids(200)).map((c) => c.length)).toEqual([90, 90, 20]);
    expect(TENANT_BULK_MAX_ALERTS).toBe(90);
  });
  it('keeps 90 ids in one chunk and returns [] for none', () => {
    expect(chunkIds(ids(90))).toHaveLength(1);
    expect(chunkIds([])).toEqual([]);
  });
  it('preserves order across chunks', () => {
    expect(chunkIds(ids(200)).flat()).toEqual(ids(200));
  });
});

describe('runChunkedBulk', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `a_${i}`);

  it('sends 200 selected ids as 3 requests of 90/90/20 and sums updated', async () => {
    const sizes: number[] = [];
    const res = await runChunkedBulk(ids(200), async (chunk) => {
      sizes.push(chunk.length);
      return { updated: chunk.length - 1 };
    });
    expect(sizes).toEqual([90, 90, 20]);
    expect(res).toEqual({ updated: 197 });
  });

  it('sends a single request for <= 90 ids and dedupes', async () => {
    const sizes: number[] = [];
    await runChunkedBulk([...ids(90), 'a_0'], async (chunk) => {
      sizes.push(chunk.length);
      return { updated: chunk.length };
    });
    expect(sizes).toEqual([90]);
  });

  it('stops on a failing chunk and reports progress', async () => {
    let calls = 0;
    await expect(runChunkedBulk(ids(200), async (chunk) => {
      calls++;
      if (calls === 2) throw new Error('Too many alerts');
      return { updated: chunk.length };
    })).rejects.toThrow('Bulk action failed after 90 of 200 alerts: Too many alerts');
    expect(calls).toBe(2);
  });

  it('passes a first-chunk error through unchanged', async () => {
    await expect(runChunkedBulk(ids(5), async () => { throw new Error('nope'); })).rejects.toThrow(/^nope$/);
  });
});
