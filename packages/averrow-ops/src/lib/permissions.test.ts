import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { roleHasPermission, type StaffPermission } from './permissions';

// The worker's matrix is the source of truth and the server enforces it; this client copy only decides what to SHOW.
// A drift is silent (a button for something the server refuses, or worse, a missing one) so the two are pinned together.
// The worker file is read as text (importing it would drag the worker's type graph into this package's compile).
const WORKER = readFileSync(resolve(__dirname, '../../../averrow-worker/src/lib/role-permissions.ts'), 'utf8');

const quoted = (s: string): string[] => [...s.matchAll(/["']([a-z_]+)["']/g)].map(m => m[1]!);

/** role -> permissions, parsed from the worker's `ROLE_PERMISSIONS` table. */
function workerMatrix(): Map<string, string[]> {
  const table = WORKER.slice(WORKER.indexOf('const ROLE_PERMISSIONS'), WORKER.indexOf('export function roleHasPermission'));
  const out = new Map<string, string[]>();
  for (const m of table.matchAll(/^\s*(\w+):\s*new Set<StaffPermission>\(\s*(?:\[([^\]]*)\])?\s*\)/gm)) {
    out.set(m[1]!, quoted(m[2] ?? ''));
  }
  return out;
}

/** The worker's `StaffPermission` union. */
function workerPermissions(): string[] {
  const decl = WORKER.slice(WORKER.indexOf('export type StaffPermission'), WORKER.indexOf('const ROLE_PERMISSIONS'));
  return quoted(decl);
}

describe('src/lib/permissions.ts mirrors the worker role-permissions matrix', () => {
  const matrix = workerMatrix();
  const permissions = workerPermissions();

  it('the parser found the worker table (guards the guard)', () => {
    expect([...matrix.keys()].sort()).toEqual(['admin', 'analyst', 'auditor', 'billing', 'client', 'sales', 'super_admin', 'support']);
    expect(permissions.length).toBeGreaterThanOrEqual(7);
    expect(matrix.get('analyst')).toContain('manage_takedowns');
    expect(matrix.get('client')).toEqual([]);
  });

  it('the permission flags are the same set', () => {
    const mine: StaffPermission[] = ['read_customers', 'edit_pricing', 'edit_alerts', 'manage_takedowns', 'manage_invites', 'view_billing', 'view_audit'];
    expect([...mine].sort()).toEqual([...permissions].sort());
  });

  it('every role grants exactly the same permissions here as on the server', () => {
    for (const [role, granted] of matrix) {
      for (const permission of permissions) {
        expect(roleHasPermission(role, permission as StaffPermission), `${role} / ${permission}`).toBe(granted.includes(permission));
      }
    }
  });

  it('an unknown or missing role grants nothing', () => {
    for (const permission of permissions) {
      expect(roleHasPermission('not_a_role', permission as StaffPermission)).toBe(false);
      expect(roleHasPermission(null, permission as StaffPermission)).toBe(false);
      expect(roleHasPermission(undefined, permission as StaffPermission)).toBe(false);
    }
  });
});
