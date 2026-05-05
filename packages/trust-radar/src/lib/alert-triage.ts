// Averrow — Alert auto-triage (Tier 1)
//
// Conservative rule-based pass that auto-dismisses alerts whose
// underlying threat has been thoroughly enriched and shows zero
// adverse signal across multiple independent reputation sources.
// Reduces operator queue size without using AI tokens — every
// decision is deterministic and replayable from the threat row.
//
// Why this exists: at 2,631 unacknowledged alerts (mostly auto-fired
// from threat ingest), a human can't realistically work the queue.
// Most of those are dismissable on data we already have. This module
// surfaces the specific rule shape that says "all enrichment paths
// agree this is benign" and stamps the alert as `false_positive`
// with a stable, auditable reason. The operator can override at any
// time — the action is reversible by changing status back to 'new'.
//
// Conservative-by-design rules (ALL must hold to auto-dismiss):
//   1. The alert is sourced from a threat row (source_type='threat')
//      with a resolvable source_id.
//   2. VirusTotal was consulted (vt_checked = 1) AND returned zero
//      malicious detections (vt_malicious = 0).
//   3. Google Safe Browsing was consulted (gsb_checked = 1) AND
//      did not flag the URL/domain (gsb_flagged = 0).
//   4. Either GreyNoise classified the IP as 'benign', OR GreyNoise
//      did not flag the IP at all (NULL classification means no
//      malicious classification was returned). Required if the
//      threat has an IP — domain-only threats are exempt from this
//      check.
//   5. SecLookup risk score is either NULL (not consulted) OR < 30
//      (low risk band). 30/100 is the platform's pre-existing
//      "low confidence threat" cutoff.
//
// NOT used as auto-dismiss criteria (intentional):
//   - confidence_score: too easy for the upstream classifier to
//     mis-set on a feed regression.
//   - severity: alerts only fire at 'high'/'critical', so this
//     adds no signal.
//   - source feed: feed-quality scoring is a separate concern.
//
// The rule errs heavily toward keeping ambiguous alerts open. False-
// dismiss is the bigger risk; false-keep is just operator noise.

import type { D1Database } from '@cloudflare/workers-types';

export type AutoTriageDecision =
  | { action: 'dismiss'; reason: string }
  | { action: 'keep'; reason: string };

export interface ThreatTriageSnapshot {
  vt_checked: number | null;
  vt_malicious: number | null;
  gsb_checked: number | null;
  gsb_flagged: number | null;
  greynoise_classification: string | null;
  seclookup_risk_score: number | null;
  ip_address: string | null;
}

/**
 * Pure decision function — no I/O. Given the enrichment snapshot of
 * the underlying threat, decides whether the alert is safe enough to
 * auto-dismiss. Returns a `keep` decision (with reason) when any
 * single criterion fails.
 *
 * Exposed standalone so the same decision can be replayed in tests
 * and verified against synthetic snapshots without DB access.
 */
export function decideAutoTriage(snapshot: ThreatTriageSnapshot): AutoTriageDecision {
  if (snapshot.vt_checked !== 1) {
    return { action: 'keep', reason: 'vt_not_checked' };
  }
  if ((snapshot.vt_malicious ?? 0) > 0) {
    return { action: 'keep', reason: 'vt_flagged' };
  }
  if (snapshot.gsb_checked !== 1) {
    return { action: 'keep', reason: 'gsb_not_checked' };
  }
  if ((snapshot.gsb_flagged ?? 0) > 0) {
    return { action: 'keep', reason: 'gsb_flagged' };
  }

  // GreyNoise check only applies when the threat has an IP. Domain-
  // only threats can't be GreyNoise-checked at all, so we don't gate
  // on it.
  if (snapshot.ip_address) {
    const gn = snapshot.greynoise_classification;
    if (gn !== null && gn !== 'benign') {
      // GN consulted and returned malicious/unknown — keep open.
      return { action: 'keep', reason: 'greynoise_not_benign' };
    }
  }

  if (snapshot.seclookup_risk_score !== null && snapshot.seclookup_risk_score >= 30) {
    return { action: 'keep', reason: 'seclookup_risk_score_high' };
  }

  return { action: 'dismiss', reason: 'auto: clean enrichment (vt+gsb+greynoise+seclookup)' };
}

/**
 * Look up the enrichment snapshot for an alert's underlying threat.
 * Returns null when the alert doesn't have a resolvable threat
 * source (in which case auto-triage doesn't apply and the alert
 * stays in its current status).
 */
export async function loadThreatSnapshotForAlert(
  db: D1Database,
  sourceId: string,
): Promise<ThreatTriageSnapshot | null> {
  const row = await db.prepare(`
    SELECT vt_checked, vt_malicious,
           gsb_checked, gsb_flagged,
           greynoise_classification,
           seclookup_risk_score,
           ip_address
    FROM threats
    WHERE id = ?
  `).bind(sourceId).first<ThreatTriageSnapshot>();
  return row ?? null;
}

export interface BackfillResult {
  scanned: number;
  dismissed: number;
  kept: number;
  no_threat: number;
}

/**
 * Backfill pass over existing 'new' alerts. Processes a bounded
 * batch (default 500) per call so the worker can run this from an
 * admin endpoint without busting CPU/wall budgets. Operators can
 * call repeatedly until `scanned < limit` (queue drained).
 *
 * Conservative: only touches alerts in `status = 'new'`. Already-
 * triaged alerts (acknowledged, investigating, resolved,
 * false_positive) are never modified.
 */
export async function runAlertTriageBackfill(
  db: D1Database,
  opts?: { limit?: number },
): Promise<BackfillResult> {
  const limit = Math.min(1000, opts?.limit ?? 500);

  const rows = await db.prepare(`
    SELECT id, source_id
    FROM alerts
    WHERE status = 'new'
      AND source_type = 'threat'
      AND source_id IS NOT NULL
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(limit).all<{ id: string; source_id: string }>();

  let dismissed = 0;
  let kept = 0;
  let noThreat = 0;

  for (const alert of rows.results) {
    const snapshot = await loadThreatSnapshotForAlert(db, alert.source_id);
    if (!snapshot) {
      noThreat += 1;
      continue;
    }
    const decision = decideAutoTriage(snapshot);
    if (decision.action === 'dismiss') {
      // Stamp resolution_notes with the reason so the dismissal
      // trail is auditable. Keep status update cheap (single row).
      await db.prepare(`
        UPDATE alerts
        SET status = 'false_positive',
            resolved_at = datetime('now'),
            resolution_notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'new'
      `).bind(decision.reason, alert.id).run();
      dismissed += 1;
    } else {
      kept += 1;
    }
  }

  return {
    scanned: rows.results.length,
    dismissed,
    kept,
    no_threat: noThreat,
  };
}
