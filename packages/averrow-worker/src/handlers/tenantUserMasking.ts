// Averrow — customer-facing masking of user references on tenant READ paths.
//
// Owner decision 2026-10-04: a staff member is never named or identified
// (id / name / email) to a customer. Builds on resolveTenantUserLabels
// (handlers/tenantData.ts), which labels platform staff — by their STORED
// users.role, so the lead-conversion placeholder super_admin is covered —
// as "Averrow SOC".

import {
  resolveTenantUserLabels,
  AVERROW_SOC_LABEL,
  FORMER_USER_LABEL,
  type TenantUserLabel,
} from "./tenantData";
import type { Env } from "../types";

export { resolveTenantUserLabels, AVERROW_SOC_LABEL, FORMER_USER_LABEL };
export type { TenantUserLabel };

/** Map of user-id column → the display-name key written next to it. */
export type UserRefFields = Readonly<Record<string, string>>;

/** Every user id referenced by `fields` across `rows`. */
export function collectUserRefIds(
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: UserRefFields,
): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    for (const idKey of Object.keys(fields)) {
      const v = row[idKey];
      if (typeof v === "string" && v.length > 0) ids.push(v);
    }
  }
  return ids;
}

/**
 * Customer-facing copy of `row` with every user reference in `fields` masked:
 *   - a customer user → id kept, name = their display name
 *   - platform staff  → id null, name = "Averrow SOC"
 *   - no users row    → id null, name = "Former user" (never the raw id)
 *   - null / empty    → id as-is, name null
 */
export function maskTenantUserRefs<T extends Record<string, unknown>>(
  row: T,
  labels: Record<string, TenantUserLabel>,
  fields: UserRefFields,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const [idKey, nameKey] of Object.entries(fields)) {
    const v = row[idKey];
    if (typeof v !== "string" || v.length === 0) {
      out[nameKey] = null;
      continue;
    }
    const label = labels[v];
    if (!label) {
      out[idKey] = null;
      out[nameKey] = FORMER_USER_LABEL;
    } else if (label.isStaff) {
      out[idKey] = null;
      out[nameKey] = AVERROW_SOC_LABEL;
    } else {
      out[nameKey] = label.name;
    }
  }
  return out;
}

/** Resolve labels for `rows` and mask them in one call. */
export async function maskTenantUserRefsForRows<T extends Record<string, unknown>>(
  env: Env,
  rows: ReadonlyArray<T>,
  fields: UserRefFields,
): Promise<Array<Record<string, unknown>>> {
  const labels = await resolveTenantUserLabels(env, collectUserRefIds(rows, fields));
  return rows.map((r) => maskTenantUserRefs(r, labels, fields));
}
