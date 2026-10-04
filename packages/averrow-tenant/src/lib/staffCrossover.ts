// Staff crossover allowance (owner decision 2026-10-04).
//
// Averrow staff are refused on tenant writes — EXCEPT four surfaces they may
// manage on the customer's behalf: executives, monitoring rules, trademark
// assets, and billing (worker: lib/tenant-staff-guard.ts). On those four the
// controls mirror the worker's own org gates instead of hiding for staff:
//   - super_admin (global tenant scope, incl. the lead-conversion placeholder
//     owner) always passes;
//   - the read-only `auditor` seat never does;
//   - anyone else (customers, and staff holding a legacy org seat) needs the
//     org role the endpoint requires.
// Every other tenant write keeps hiding its controls for staff.

const ORG_RANK: Record<string, number> = { viewer: 1, analyst: 2, admin: 3, owner: 4 };

export function canManageCrossover(
  globalRole: string | null | undefined,
  orgRole:    string | null | undefined,
  minOrgRole: 'analyst' | 'admin',
): boolean {
  if (globalRole === 'auditor') return false;
  if (globalRole === 'super_admin') return true;
  return (ORG_RANK[orgRole ?? ''] ?? 0) >= ORG_RANK[minOrgRole]!;
}
