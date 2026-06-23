// Averrow — takedown authorization helpers
//
// Reader/writer for `takedown_authorizations`. Sparrow + the future
// per-provider submitters call `requireAuthorizationForModule()`
// before any automated takedown submission; the entitlement check
// (per `lib/entitlements.ts`) gates whether the module is licensed,
// the authorization check gates whether the customer has consented
// to act on their behalf.
//
// Two layers of consent must both be true to auto-submit:
//   1. org_modules.status = 'active' for the module        (entitlements)
//   2. takedown_authorizations covers the module + has not
//      breached its scope_json constraints                (this file)
//
// See `migrations/0148_takedown_authorizations.sql`,
// `eager-moseying-papert.md` Phase A item 5.

import type { Env } from "../types";
import type { ModuleKey } from "./entitlements";
import { cachedValue } from "./cached-value";
import { DEFAULT_SEMI_AUTO_RULES, type SemiAutoRules } from "./takedown-policy";

export type AuthorizationStatus = "active" | "revoked" | "expired";

export type EscalationMode = "auto_resubmit_on_pivot" | "manual_only";

/**
 * Canonical automation posture (the "level" the customer asked for):
 *   off       — Averrow drafts takedowns, submits nothing automatically.
 *   semi_auto — auto-submit only takedowns matching scope.semi_auto_rules;
 *               everything else holds in 'draft' for human approval.
 *   auto      — every in-scope takedown auto-submits.
 *
 * Replaces the old derive-from-boolean model where
 * `high_risk_requires_per_takedown_approval` implied the posture. That
 * boolean is retained for backward compatibility and kept in sync:
 * mode==='semi_auto' ⇔ high_risk_requires_per_takedown_approval===true.
 */
export type AutomationMode = "off" | "semi_auto" | "auto";

export interface AuthorizationScope {
  /** Modules covered. Empty array → no modules covered (effectively manual_only). */
  modules: ModuleKey[];
  /** Cap per calendar month. null = unlimited. */
  max_takedowns_per_month: number | null;
  escalation: EscalationMode;
  /** Auto re-submit if a provider hasn't acted within this window. null = no auto-followup. */
  auto_followup_breached_sla_hours: number | null;
  /** When true, takedowns flagged high-risk require a per-takedown approval click in averrow-tenant before submission. */
  high_risk_requires_per_takedown_approval: boolean;
  /** Canonical automation posture. */
  mode: AutomationMode;
  /** Per-characteristic auto-submit criteria, applied only when mode==='semi_auto'. */
  semi_auto_rules: SemiAutoRules;
}

/**
 * Fill a partial / legacy scope object with the full canonical shape.
 *
 * Backward compatibility: authorizations signed before the mode/rules
 * fields existed carry only the five legacy fields. We derive `mode` from
 * `high_risk_requires_per_takedown_approval` (true → semi_auto, false →
 * auto) so the stored intent is honored, and seed `semi_auto_rules` with
 * the conservative default. New signings always write explicit fields.
 *
 * This is also the validation-time normalizer the handlers call after
 * loose-validating an inbound body, so persisted scope_json always has the
 * complete shape.
 */
export function normalizeScope(raw: unknown): AuthorizationScope {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const modules = Array.isArray(s.modules) ? (s.modules as ModuleKey[]) : [];
  const max_takedowns_per_month =
    typeof s.max_takedowns_per_month === "number" ? s.max_takedowns_per_month : null;
  const escalation: EscalationMode =
    s.escalation === "manual_only" ? "manual_only" : "auto_resubmit_on_pivot";
  const auto_followup_breached_sla_hours =
    typeof s.auto_followup_breached_sla_hours === "number"
      ? s.auto_followup_breached_sla_hours
      : null;
  const high_risk =
    typeof s.high_risk_requires_per_takedown_approval === "boolean"
      ? s.high_risk_requires_per_takedown_approval
      : true;

  // mode: explicit when present, else derived from the legacy boolean.
  let mode: AutomationMode;
  if (s.mode === "off" || s.mode === "semi_auto" || s.mode === "auto") {
    mode = s.mode;
  } else {
    mode = high_risk ? "semi_auto" : "auto";
  }

  const rawRules = (s.semi_auto_rules && typeof s.semi_auto_rules === "object"
    ? s.semi_auto_rules
    : {}) as Record<string, unknown>;
  const semi_auto_rules: SemiAutoRules = {
    auto_severities: Array.isArray(rawRules.auto_severities)
      ? (rawRules.auto_severities as unknown[]).filter((v): v is string => typeof v === "string")
      : DEFAULT_SEMI_AUTO_RULES.auto_severities,
    auto_target_types: Array.isArray(rawRules.auto_target_types)
      ? (rawRules.auto_target_types as unknown[]).filter((v): v is string => typeof v === "string")
      : DEFAULT_SEMI_AUTO_RULES.auto_target_types,
    auto_provider_types: Array.isArray(rawRules.auto_provider_types)
      ? (rawRules.auto_provider_types as unknown[]).filter((v): v is string => typeof v === "string")
      : DEFAULT_SEMI_AUTO_RULES.auto_provider_types,
  };

  return {
    modules,
    max_takedowns_per_month,
    escalation,
    auto_followup_breached_sla_hours,
    // Keep the legacy boolean coherent with the canonical mode: only
    // semi_auto has a per-takedown approval gate.
    high_risk_requires_per_takedown_approval: mode === "semi_auto",
    mode,
    semi_auto_rules,
  };
}

export interface TakedownAuthorization {
  id:                 string;
  org_id:             number;
  agreement_version:  string;
  status:             AuthorizationStatus;
  signed_at:          string;
  signed_by_user_id:  string;
  signed_ip:          string | null;
  signed_user_agent:  string | null;
  scope:              AuthorizationScope;
  revoked_at:         string | null;
  revoked_by_user_id: string | null;
  revoked_reason:     string | null;
  created_at:         string;
  updated_at:         string;
}

const AUTH_CACHE_TTL_SECONDS = 120; // re-signs are rare; cache locally

interface RawRow {
  id:                 string;
  org_id:             number;
  agreement_version:  string;
  status:             string;
  signed_at:          string;
  signed_by_user_id:  string;
  signed_ip:          string | null;
  signed_user_agent:  string | null;
  scope_json:         string;
  revoked_at:         string | null;
  revoked_by_user_id: string | null;
  revoked_reason:     string | null;
  created_at:         string;
  updated_at:         string;
}

function cacheKey(orgId: number): string {
  return `takedown_auth.org.${orgId}.active`;
}

function rowToAuthorization(row: RawRow): TakedownAuthorization {
  let scope: AuthorizationScope;
  try {
    // normalizeScope backfills mode + semi_auto_rules for legacy rows and
    // keeps the legacy high_risk boolean coherent with the canonical mode.
    scope = normalizeScope(JSON.parse(row.scope_json));
  } catch {
    // Unparseable scope_json — treat as the most-restrictive shape.
    // Sparrow will refuse all auto-submits in this case.
    scope = normalizeScope({
      modules: [],
      max_takedowns_per_month: 0,
      escalation: "manual_only",
      auto_followup_breached_sla_hours: null,
      high_risk_requires_per_takedown_approval: true,
      mode: "off",
    });
  }
  return {
    id:                 row.id,
    org_id:             row.org_id,
    agreement_version:  row.agreement_version,
    status:             row.status as AuthorizationStatus,
    signed_at:          row.signed_at,
    signed_by_user_id:  row.signed_by_user_id,
    signed_ip:          row.signed_ip,
    signed_user_agent:  row.signed_user_agent,
    scope,
    revoked_at:         row.revoked_at,
    revoked_by_user_id: row.revoked_by_user_id,
    revoked_reason:     row.revoked_reason,
    created_at:         row.created_at,
    updated_at:         row.updated_at,
  };
}

/** The current active authorization for an org, or null if not signed / revoked / expired. */
export async function getActiveAuthorization(
  env:   Env,
  orgId: number,
): Promise<TakedownAuthorization | null> {
  return cachedValue<TakedownAuthorization | null>(env, cacheKey(orgId), AUTH_CACHE_TTL_SECONDS, async () => {
    const row = await env.DB.prepare(
      `SELECT id, org_id, agreement_version, status, signed_at, signed_by_user_id,
              signed_ip, signed_user_agent, scope_json,
              revoked_at, revoked_by_user_id, revoked_reason,
              created_at, updated_at
       FROM takedown_authorizations
       WHERE org_id = ? AND status = 'active'
       LIMIT 1`,
    ).bind(orgId).first<RawRow>();
    return row ? rowToAuthorization(row) : null;
  });
}

/**
 * Monthly-cap check (S1, IMPROVEMENT_PLAN_2026-06). Counts this
 * calendar month's outbound submissions (outcome='submitted') across
 * the org's takedowns and compares against the signed
 * scope_json.max_takedowns_per_month. null cap = unlimited.
 *
 * Counts only primary submissions — follow-ups (submitter_kind LIKE
 * 'followup_%') reference an already-counted takedown and don't
 * consume cap. Drafts (outcome='queued') don't count either: the cap
 * governs outbound automation, and the same takedown's later live
 * send is the single counted event.
 *
 * Not cached: Sparrow Phase G is the only caller and runs 6-hourly
 * on small batches; correctness at the consent boundary beats a KV
 * round-trip saved.
 */
export async function isUnderMonthlyTakedownCap(
  env:   Env,
  orgId: number,
): Promise<{ under: boolean; used: number; cap: number | null }> {
  const auth = await getActiveAuthorization(env, orgId);
  const cap = auth?.scope.max_takedowns_per_month ?? null;
  if (cap === null) return { under: true, used: 0, cap: null };

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM takedown_submissions ts
     JOIN takedown_requests tr ON tr.id = ts.takedown_id
     WHERE tr.org_id = ?
       AND ts.outcome = 'submitted'
       AND ts.submitter_kind NOT LIKE 'followup_%'
       AND ts.attempted_at >= datetime('now', 'start of month')`,
  ).bind(orgId).first<{ n: number }>();
  const used = row?.n ?? 0;
  return { under: used < cap, used, cap };
}

/** True iff the org has signed an active authorization that covers `moduleKey`. */
export async function isModuleAuthorized(
  env:       Env,
  orgId:     number,
  moduleKey: ModuleKey,
): Promise<boolean> {
  const auth = await getActiveAuthorization(env, orgId);
  if (!auth) return false;
  return auth.scope.modules.includes(moduleKey);
}

/**
 * Throws when there's no active authorization or it doesn't cover the
 * module. Caller catches and surfaces a customer-facing 403 with copy
 * pointing at the signing flow.
 */
export class TakedownNotAuthorizedError extends Error {
  constructor(
    public readonly orgId:     number,
    public readonly moduleKey: ModuleKey,
    public readonly reason:    "no_authorization" | "module_not_in_scope",
  ) {
    super(
      reason === "no_authorization"
        ? `Org ${orgId} has not signed a takedown authorization`
        : `Org ${orgId}'s takedown authorization does not cover module '${moduleKey}'`,
    );
    this.name = "TakedownNotAuthorizedError";
  }
}

export async function requireAuthorizationForModule(
  env:       Env,
  orgId:     number,
  moduleKey: ModuleKey,
): Promise<TakedownAuthorization> {
  const auth = await getActiveAuthorization(env, orgId);
  if (!auth) throw new TakedownNotAuthorizedError(orgId, moduleKey, "no_authorization");
  if (!auth.scope.modules.includes(moduleKey)) {
    throw new TakedownNotAuthorizedError(orgId, moduleKey, "module_not_in_scope");
  }
  return auth;
}

/**
 * Record a fresh signed authorization.
 *
 * Atomically marks any prior active authorization as 'expired'
 * (preserving the audit row) and inserts the new one as 'active'.
 *
 * Caller is responsible for verifying the customer actually saw +
 * agreed to the agreement_version copy. This function is the
 * persistence step.
 */
export interface RecordAuthorizationInput {
  orgId:            number;
  agreementVersion: string;
  signedByUserId:   string;
  scope:            AuthorizationScope;
  signedIp?:        string | null;
  signedUserAgent?: string | null;
}

export async function recordSignedAuthorization(
  env:   Env,
  input: RecordAuthorizationInput,
): Promise<TakedownAuthorization> {
  const id = crypto.randomUUID();
  // Normalize so persisted scope_json always carries the full canonical
  // shape (mode + semi_auto_rules), regardless of caller completeness.
  const scopeJson = JSON.stringify(normalizeScope(input.scope));
  // Two-statement batch: expire the prior active, insert the new one.
  // Cloudflare D1 supports batch — keeps it transactional.
  const stmts = [
    env.DB.prepare(
      `UPDATE takedown_authorizations
       SET status = 'expired', updated_at = datetime('now')
       WHERE org_id = ? AND status = 'active'`,
    ).bind(input.orgId),
    env.DB.prepare(
      `INSERT INTO takedown_authorizations
         (id, org_id, agreement_version, status, signed_at, signed_by_user_id,
          signed_ip, signed_user_agent, scope_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', datetime('now'), ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).bind(
      id,
      input.orgId,
      input.agreementVersion,
      input.signedByUserId,
      input.signedIp ?? null,
      input.signedUserAgent ?? null,
      scopeJson,
    ),
  ];
  await env.DB.batch(stmts);
  await invalidateCache(env, input.orgId);

  const fetched = await getActiveAuthorization(env, input.orgId);
  if (!fetched) {
    // Should be impossible — we just wrote the row above. Defend anyway.
    throw new Error(`Authorization insert succeeded but readback returned null for org ${input.orgId}`);
  }
  return fetched;
}

/** Mark the active authorization as revoked. Idempotent — no-op if none active. */
export async function revokeAuthorization(
  env:    Env,
  orgId:  number,
  options: { revokedByUserId: string; reason?: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE takedown_authorizations
     SET status = 'revoked',
         revoked_at = datetime('now'),
         revoked_by_user_id = ?,
         revoked_reason = ?,
         updated_at = datetime('now')
     WHERE org_id = ? AND status = 'active'`,
  )
    .bind(options.revokedByUserId, options.reason ?? null, orgId)
    .run();
  await invalidateCache(env, orgId);
}

async function invalidateCache(env: Env, orgId: number): Promise<void> {
  await env.CACHE.delete(`cv:${cacheKey(orgId)}`);
}
