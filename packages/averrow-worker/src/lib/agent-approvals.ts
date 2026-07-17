/**
 * Agent deployment approval helpers (AGENT_STANDARD §12.1).
 *
 * Phase 5.4a — data-layer plumbing only. Phase 5.4b adds the runner
 * integration (new agents auto-create pending rows + run in shadow
 * mode until approved); 5.4c adds per-run approval (`requiresApproval`).
 *
 * Read paths (admin-facing diagnostics + future review screen):
 *   - listPending(db)          → all rows in 'pending' or
 *                                 'changes_requested' state
 *   - getApprovalState(db, id) → single row or null
 *   - getReviewBundle(db, id)  → approval state + recent
 *                                 agent_runs + recent agent_outputs
 *
 * Write paths (super_admin actions):
 *   - createPending(db, ...)   → first observation of a new agent
 *   - approve(db, id, ...)     → reviewer green-lights deployment
 *   - reject(db, id, ...)      → reviewer rejects (notes required)
 *   - requestChanges(db, id, …) → reviewer wants iteration
 *
 * The grandfather entries inserted by migration 0126 already satisfy
 * the runner's gate for the 35 pre-5.4 agents.
 */

export type ApprovalState = "pending" | "approved" | "rejected" | "changes_requested";

export interface AgentApprovalRow {
  agent_id: string;
  state: ApprovalState;
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewer_notes: string | null;
  source_pr: string | null;
  created_at: string;
  updated_at: string;
}

/** Bundle returned to the review screen — combines the approval row
 *  with recent agent_runs + agent_outputs so the reviewer doesn't
 *  need a second round-trip. */
export interface AgentReviewBundle {
  approval: AgentApprovalRow | null;
  recent_runs: Array<{
    id: string;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    status: string;
    error_message: string | null;
    records_processed: number;
    outputs_generated: number;
  }>;
  recent_outputs: Array<{
    id: string;
    type: string;
    summary: string;
    severity: string | null;
    created_at: string;
  }>;
}

const REVIEWER_NOTES_MAX = 4000;

// ─── Reads ──────────────────────────────────────────────────────

export async function listPending(db: D1Database): Promise<AgentApprovalRow[]> {
  const result = await db.prepare(`
    SELECT agent_id, state, requested_at, reviewed_at, reviewed_by,
           reviewer_notes, source_pr, created_at, updated_at
    FROM agent_approvals
    WHERE state IN ('pending', 'changes_requested')
    ORDER BY requested_at DESC
  `).all<AgentApprovalRow>();
  return result.results;
}

export async function getApprovalState(db: D1Database, agentId: string): Promise<AgentApprovalRow | null> {
  return db.prepare(`
    SELECT agent_id, state, requested_at, reviewed_at, reviewed_by,
           reviewer_notes, source_pr, created_at, updated_at
    FROM agent_approvals WHERE agent_id = ?
  `).bind(agentId).first<AgentApprovalRow>();
}

export async function getReviewBundle(db: D1Database, agentId: string): Promise<AgentReviewBundle> {
  const [approval, runs, outputs] = await Promise.all([
    getApprovalState(db, agentId),
    db.prepare(`
      SELECT id, started_at, completed_at, duration_ms, status,
             error_message, records_processed, outputs_generated
      FROM agent_runs
      WHERE agent_id = ?
      ORDER BY started_at DESC
      LIMIT 10
    `).bind(agentId).all<AgentReviewBundle["recent_runs"][number]>(),
    db.prepare(`
      SELECT id, type, summary, severity, created_at
      FROM agent_outputs
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).bind(agentId).all<AgentReviewBundle["recent_outputs"][number]>(),
  ]);
  return {
    approval,
    recent_runs: runs.results,
    recent_outputs: outputs.results,
  };
}

// ─── Writes ─────────────────────────────────────────────────────

/** Create a 'pending' row for a newly-observed agent. Idempotent —
 *  if a row already exists for this agent_id, this no-ops. Used
 *  by Phase 5.4b's runner gate to register first-time agents. */
export async function createPending(
  db: D1Database,
  agentId: string,
  sourcePr: string | null = null,
): Promise<AgentApprovalRow> {
  await db.prepare(`
    INSERT OR IGNORE INTO agent_approvals (agent_id, state, requested_at, source_pr)
    VALUES (?, 'pending', datetime('now'), ?)
  `).bind(agentId, sourcePr).run();
  const row = await getApprovalState(db, agentId);
  if (!row) throw new Error(`createPending: failed to insert/read row for ${agentId}`);
  return row;
}

/** Approve the agent — flips the state to 'approved' and records
 *  the reviewer. Throws if the row is missing or already approved
 *  (the caller should check getApprovalState first to surface a
 *  meaningful error to the reviewer). */
export async function approve(
  db: D1Database,
  agentId: string,
  reviewerId: string,
  notes: string | null = null,
): Promise<AgentApprovalRow> {
  const truncated = (notes ?? "").slice(0, REVIEWER_NOTES_MAX);
  const result = await db.prepare(`
    UPDATE agent_approvals
    SET state = 'approved',
        reviewed_at = datetime('now'),
        reviewed_by = ?,
        reviewer_notes = ?,
        updated_at = datetime('now')
    WHERE agent_id = ?
      AND state IN ('pending', 'changes_requested')
  `).bind(reviewerId, truncated || null, agentId).run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new Error(`approve: no pending approval row for ${agentId}`);
  }
  const row = await getApprovalState(db, agentId);
  if (!row) throw new Error(`approve: row vanished after update for ${agentId}`);
  return row;
}

export async function reject(
  db: D1Database,
  agentId: string,
  reviewerId: string,
  notes: string,
): Promise<AgentApprovalRow> {
  if (!notes || notes.trim().length < 5) {
    throw new Error("reject: reviewer_notes is required (min 5 chars)");
  }
  const truncated = notes.slice(0, REVIEWER_NOTES_MAX);
  const result = await db.prepare(`
    UPDATE agent_approvals
    SET state = 'rejected',
        reviewed_at = datetime('now'),
        reviewed_by = ?,
        reviewer_notes = ?,
        updated_at = datetime('now')
    WHERE agent_id = ?
      AND state IN ('pending', 'changes_requested', 'approved')
  `).bind(reviewerId, truncated, agentId).run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new Error(`reject: no row found for ${agentId}`);
  }
  const row = await getApprovalState(db, agentId);
  if (!row) throw new Error(`reject: row vanished after update for ${agentId}`);
  return row;
}

export async function requestChanges(
  db: D1Database,
  agentId: string,
  reviewerId: string,
  notes: string,
): Promise<AgentApprovalRow> {
  if (!notes || notes.trim().length < 5) {
    throw new Error("requestChanges: reviewer_notes is required (min 5 chars)");
  }
  const truncated = notes.slice(0, REVIEWER_NOTES_MAX);
  const result = await db.prepare(`
    UPDATE agent_approvals
    SET state = 'changes_requested',
        reviewed_at = datetime('now'),
        reviewed_by = ?,
        reviewer_notes = ?,
        updated_at = datetime('now')
    WHERE agent_id = ?
      AND state IN ('pending', 'changes_requested')
  `).bind(reviewerId, truncated, agentId).run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new Error(`requestChanges: no pending row for ${agentId}`);
  }
  const row = await getApprovalState(db, agentId);
  if (!row) throw new Error(`requestChanges: row vanished after update for ${agentId}`);
  return row;
}
