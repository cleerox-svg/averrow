/**
 * Start Sparrow's lookalike takedown drafting the moment a brand becomes
 * org-owned (owner decision 2026-10-22: "as soon as a brand is owned the
 * lookalike drafts immediately begin"), instead of waiting up to 6h for the
 * 6-hourly Sparrow cron (:11).
 *
 * Called right after a committed `INSERT INTO org_brands` on every path that
 * creates ownership: handleCreateOrg + handleAssignOrgBrand
 * (handlers/organizations.ts) and handleConvertLeadToTenant
 * (handlers/leadConversion.ts). Ownership is the org_brands row itself — the
 * same definition Sparrow's cron selection uses (owningOrgIdSql) — so a
 * lead-converted org's brand is owned here exactly as it is to the cron; the
 * lead-conversion staff placeholder is an org_members seat, not a brand
 * ownership signal, and plays no part.
 *
 * Contract:
 *  - Best-effort and deferred: the work runs under `waitUntil` and every
 *    failure (including a failed module import) is caught, so the brand-add
 *    request can never fail or slow down because of it.
 *  - Bounded: one brand, at most Sparrow's per-call draft limit (10).
 *  - Idempotent with the cron: drafted rows carry `lookalike_domains.
 *    takedown_id`, and the draft batch is conditional on it being NULL, so a
 *    repeat call or a concurrent cron run never double-drafts.
 *  - Drafting only: submission stays with Sparrow Phase G (authorization,
 *    policy mode, PHASE_G cap, org monthly cap) — nothing here changes it.
 */

import type { Env } from "../types";

export function scheduleOwnedLookalikeDrafts(
  env: Env,
  workerCtx: ExecutionContext | undefined,
  brandId: string,
  logTag: string,
): void {
  if (!workerCtx) return;
  try {
    workerCtx.waitUntil(runOwnedLookalikeDrafts(env, brandId, logTag));
  } catch (err) {
    console.error(`[${logTag}] lookalike draft scheduling failed:`, err);
  }
}

/** Never rejects — exported for tests. */
export async function runOwnedLookalikeDrafts(env: Env, brandId: string, logTag: string): Promise<void> {
  try {
    const { createTakedownsFromLookalikesForBrand } = await import("../agents/sparrow");
    const tally = await createTakedownsFromLookalikesForBrand(env, brandId);
    if (tally.failed > 0) {
      console.error(`[${logTag}] lookalike drafting for ${brandId}: ${tally.failed} failed (first: ${tally.firstError})`);
    }
  } catch (err) {
    console.error(`[${logTag}] lookalike drafting for ${brandId} failed:`, err);
  }
}
