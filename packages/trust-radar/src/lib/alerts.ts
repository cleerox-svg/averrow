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
  sourceType?: string;
  sourceId?: string;
  aiAssessment?: string;
  aiRecommendations?: string[];
}

export interface Alert {
  id: string;
  brand_id: string;
  user_id: string;
  alert_type: AlertType;
  severity: Severity;
  title: string;
  summary: string;
  details: string | null;
  source_type: string | null;
  source_id: string | null;
  ai_assessment: string | null;
  ai_recommendations: string | null;
  status: AlertStatus;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  email_sent: number;
  webhook_sent: number;
  created_at: string;
  updated_at: string;
}

/**
 * Create a new alert and return its ID.
 *
 * Defensive: severity is lower-cased before insert so legacy callers
 * passing 'CRITICAL'/'HIGH'/etc. don't fail the lowercase CHECK
 * constraint added in migration 0121. Eventually all callers should
 * be passing lowercase directly; this normalization can be removed
 * once we've verified zero callers send uppercase (probably PR 3
 * follow-up).
 */
export async function createAlert(db: D1Database, params: CreateAlertParams): Promise<string> {
  const id = crypto.randomUUID();
  const detailsJson = params.details ? JSON.stringify(params.details) : null;
  const recommendationsJson = params.aiRecommendations ? JSON.stringify(params.aiRecommendations) : null;
  const lowerSeverity = (params.severity as string).toLowerCase() as AlertSeverity;

  await db.prepare(
    `INSERT INTO alerts (id, brand_id, user_id, alert_type, severity, title, summary, details, source_type, source_id, ai_assessment, ai_recommendations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  ).run();

  // Tier 1 auto-triage: if the alert is sourced from a threat row
  // whose enrichment is fully clean across VT, GSB, GreyNoise, and
  // SecLookup, immediately stamp it as `false_positive` so it
  // doesn't enter the operator queue. Best-effort — any failure
  // here leaves the alert in 'new' status (the conservative
  // outcome). See lib/alert-triage.ts for the rule definition.
  if (params.sourceType === 'threat' && params.sourceId) {
    try {
      const { loadThreatSnapshotForAlert, decideAutoTriage } = await import('./alert-triage');
      const snapshot = await loadThreatSnapshotForAlert(db, params.sourceId);
      if (snapshot) {
        const decision = decideAutoTriage(snapshot);
        if (decision.action === 'dismiss') {
          await db.prepare(`
            UPDATE alerts
            SET status = 'false_positive',
                resolved_at = datetime('now'),
                resolution_notes = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind(decision.reason, id).run();
        }
      }
    } catch {
      // Auto-triage is non-fatal. Worst case the alert stays 'new'
      // for the operator to handle manually — same as before this
      // pass existed.
    }
  }

  return id;
}

/**
 * Query alerts with optional filters and pagination.
 */
export async function getAlerts(db: D1Database, userId: string, opts?: {
  status?: AlertStatus;
  severity?: Severity;
  brandId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ alerts: Alert[]; total: number }> {
  const limit = Math.min(100, opts?.limit ?? 50);
  const offset = opts?.offset ?? 0;

  let where = `WHERE user_id = ?`;
  const params: unknown[] = [userId];

  if (opts?.status) {
    where += ` AND status = ?`;
    params.push(opts.status);
  }
  if (opts?.severity) {
    where += ` AND severity = ?`;
    params.push(opts.severity);
  }
  if (opts?.brandId) {
    where += ` AND brand_id = ?`;
    params.push(opts.brandId);
  }

  // Get total count
  const countRow = await db.prepare(
    `SELECT COUNT(*) as c FROM alerts ${where}`
  ).bind(...params).first<{ c: number }>();
  const total = countRow?.c ?? 0;

  // Get paginated results
  const rows = await db.prepare(
    `SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all<Alert>();

  return { alerts: rows.results, total };
}

/**
 * Update alert status with appropriate timestamp tracking.
 */
export async function updateAlertStatus(
  db: D1Database,
  alertId: string,
  status: AlertStatus,
  notes?: string,
): Promise<boolean> {
  let extra = ``;
  const params: unknown[] = [status];

  if (status === 'acknowledged') {
    extra = `, acknowledged_at = datetime('now')`;
  } else if (status === 'resolved' || status === 'false_positive') {
    extra = `, resolved_at = datetime('now')`;
    if (notes) {
      extra += `, resolution_notes = ?`;
      params.push(notes);
    }
  }

  params.push(alertId);

  const result = await db.prepare(
    `UPDATE alerts SET status = ?${extra}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...params).run();

  return (result.meta.changes ?? 0) > 0;
}
