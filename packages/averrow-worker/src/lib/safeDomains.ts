// Safe domain lookup helper for threat pipeline integration

import type { D1Database } from "@cloudflare/workers-types";

/** Load all safe domains into a Set for O(1) lookup during a cron cycle */
export async function loadSafeDomainSet(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT domain FROM brand_safe_domains").all<{ domain: string }>();
  const set = new Set<string>();
  for (const r of rows.results) {
    set.add(r.domain.toLowerCase());
    // Also add www. variant for matching (but not for wildcards)
    if (!r.domain.startsWith("www.") && !r.domain.startsWith("*.")) {
      set.add("www." + r.domain.toLowerCase());
    }
  }
  return set;
}

/** Check if a domain is in the safe set, supporting wildcards.
 *  - Exact match: "lowes.com" matches "lowes.com"
 *  - Wildcard match: "*.lowes.com" matches "sub.lowes.com", "a.b.lowes.com"
 */
export function isSafeDomain(domain: string, safeSet: Set<string>): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");

  // Exact match
  if (safeSet.has(d)) return true;

  // Check without www
  const noWww = d.replace(/^www\./, "");
  if (noWww !== d && safeSet.has(noWww)) return true;

  // Wildcard match: for "sub.lowes.com", check "*.lowes.com"
  // For "a.b.lowes.com", check "*.b.lowes.com" then "*.lowes.com"
  const parts = d.split(".");
  for (let i = 1; i < parts.length; i++) {
    const wildcard = "*." + parts.slice(i).join(".");
    if (safeSet.has(wildcard)) return true;
  }

  return false;
}
