/**
 * Unified alerts pipeline — creation, retrieval, and status management.
 *
 * Alert type whitelist + severity enum live in @averrow/shared so the
 * worker, the UI, and the migration 0121 CHECK constraint all match.
 * Adding a new alert type = adding it to alert-types.ts (and a new
 * migration to extend the CHECK).
 */

import type { AlertTypeKey, AlertSeverity } from '@averrow/shared';

/** @deprecated Use AlertTypeKey from @averrow/shared. */
export type AlertType = AlertTypeKey;
/** @deprecated Use AlertSeverity from @averrow/shared. Lowercase. */
export type Severity = AlertSeverity;

export type AlertStatus = 'new' | 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';

// Accept either casing for severity at the boundary — many existing
// callers still pass 'CRITICAL'/'HIGH'/etc. strings inherited from
// the pre-PR-1 enum. createAlert lowercases before insert, so the
// CHECK constraint stays satisfied. PR 3 follow-up will sweep the
// remaining UPPERCASE literals.
type SeverityInput = AlertSeverity | Uppercase<AlertSeverity>;

export interface CreateAlertParams {
  brandId: string;
  userId: string;
  alertType: AlertType;
  severity: SeverityInput;
  title: string;
  summary: string;
  details?: Record<string, any>;
  /**
   * Owning org for ORG-PRIVATE alerts. When set, the brand-scoped tenant
   * read/write paths restrict this alert to the owning org (via the
   * `a.org_id IS NULL OR a.org_id = ?` predicate). MUST be left undefined
   * for brand-wide alert types (phishing / threat-feed / campaign / …) so
   * they stay visible to every co-monitoring org — undefined → NULL column.
   * Currently only `executive_impersonation` sets it (the alert embeds a
   * named executive's PII belonging to one org). See migration 0247.
   */
  orgId?: number;
  sourceType?: string;
  sourceId?: string;
  aiAssessment?: string;
  aiRecommendations?: string[];
  /**
   * NX2: bypass the brands.tier gate. Default false. The gate skips
   * insert when the brand is tier='tracked' (unclaimed) so the alerts
   * table doesn't accumulate rows for the 76K passively-watched brands.
   * Backfill (lib/alert-backfill.ts) sets this true when an org claims
   * a brand and we want to retro-populate alerts from the source tables.
   * Never set this true outside backfill paths.
   */
  bypassTierGate?: boolean;
}

/**
 * Create a new alert and return its ID, or null if the brand is
 * tier='tracked' (the NX2 tier gate — unclaimed brands don't get alert
 * rows so the table doesn't grow proportional to the 76K tracked-brand
 * universe). Callers that pipe the returned ID into other tables must
 * guard on null.
 *
 * Defensive: severity is lower-cased before insert so legacy callers
 * passing 'CRITICAL'/'HIGH'/etc. don't fail the lowercase CHECK
 * constraint added in migration 0121. Eventually all callers should
 * be passing lowercase directly; this normalization can be removed
 * once we've verified zero callers send uppercase (probably PR 3
 * follow-up).
 */
export async function createAlert(db: D1Database, params: CreateAlertParams): Promise<string | null> {
  // NX2 tier gate. brands.tier values: 'tracked' (passive — no alerts),
  // 'monitored' (active, alerts fire), 'customer' (claimed, alerts fire).
  // Backfill explicitly bypasses via params.bypassTierGate when an org
  // claims a previously-tracked brand and we want the history retro-populated.
  if (!params.bypassTierGate) {
    const brand = await db.prepare(
      "SELECT tier FROM brands WHERE id = ?"
    ).bind(params.brandId).first<{ tier: string | null }>();
    if (brand?.tier === 'tracked') {
      return null;
    }
  }

  const id = crypto.randomUUID();
  const detailsJson = params.details ? JSON.stringify(params.details) : null;
  const recommendationsJson = params.aiRecommendations ? JSON.stringify(params.aiRecommendations) : null;
  const lowerSeverity = (params.severity as string).toLowerCase() as AlertSeverity;

  await db.prepare(
    `INSERT INTO alerts (id, brand_id, user_id, alert_type, severity, title, summary, details, source_type, source_id, ai_assessment, ai_recommendations, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    params.brandId,
    params.userId,
    params.alertType,
    lowerSeverity,
    params.title,
    params.summary,
    detailsJson,
    params.sourceType ?? null,
    params.sourceId ?? null,
    params.aiAssessment ?? null,
    recommendationsJson,
    // Org-private ownership: only set for exec-impersonation today; every
    // other alert type leaves this NULL so co-monitoring visibility is
    // unchanged (migration 0247).
    params.orgId ?? null,
  ).run();

  // Tier 1 + Tier 1.5 auto-triage: dispatch by alert source/type and
  // immediately mark as `false_positive` when the new alert meets
  // its family's auto-dismiss criteria. Best-effort — any failure
  // here leaves the alert in 'new' status (the conservative
  // outcome). See lib/alert-triage.ts for the rule definitions.
  try {
    const triage = await import('./alert-triage');

    let decision: { action: 'dismiss' | 'keep'; reason: string } | null = null;

    if (params.sourceType === 'threat' && params.sourceId) {
      const snapshot = await triage.loadThreatSnapshotForAlert(db, params.sourceId);
      if (snapshot) decision = triage.decideThreatAutoTriage(snapshot);
    } else if (
      params.alertType === 'social_impersonation' ||
      params.alertType === 'app_store_impersonation'
    ) {
      const allowlists = await triage.loadBrandAllowlists(db, [params.brandId]);
      const allow = allowlists.get(params.brandId) ?? { name: null, official_handles: null, official_apps: null };
      if (params.alertType === 'social_impersonation') {
        decision = triage.decideSocialImpersonationTriage(params.details ?? null, allow);
      } else {
        decision = triage.decideAppStoreImpersonationTriage(params.details ?? null, allow);
      }
    } else if (params.alertType === 'executive_impersonation') {
      // Exec-impersonation triage keys off the EXECUTIVE's own official
      // handles (from org_executives), not the brand's — loaded by
      // details.executive_id which the executive_monitor batch always sets.
      const executiveId =
        typeof params.details?.executive_id === 'string' ? params.details.executive_id : null;
      const allow = executiveId
        ? await triage.loadExecutiveAllowlist(db, executiveId)
        : { full_name: null, official_handles: null };
      decision = triage.decideExecutiveImpersonationTriage(params.details ?? null, allow);
    }

    if (decision && decision.action === 'dismiss') {
      await db.prepare(`
        UPDATE alerts
        SET status = 'false_positive',
            resolved_at = datetime('now'),
            resolution_notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(decision.reason, id).run();
    }
  } catch {
    // Auto-triage is non-fatal. Worst case the alert stays 'new'
    // for the operator to handle manually.
  }

  return id;
}

// Alert reads + status updates live in the route handlers: ops/staff in
// handlers/alerts.ts (staff writes go to staff_assigned_to / staff_notes,
// never the customer-visible assigned_to / resolution_notes — migration
// 0275), tenant in handlers/tenantData.ts. The former getAlerts (user_id-
// pinned, no callers) and updateAlertStatus (wrote staff notes into the
// customer-visible resolution_notes) were removed in the PR-C review.
