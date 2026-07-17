// Averrow — Incidents library
//
// Auto-creation + dedup hook called from emitPlatformNotification when
// a critical platform_* notification fires. Per the planning thread:
//
//   - Only severity = 'critical' triggers auto-creation. Lower
//     severities still create notifications, but they don't promote
//     to incidents.
//   - Dedup: if an OPEN incident already exists with the same
//     source_group_key, append a system update instead of creating
//     a new one.
//   - Default visibility = 'internal'. Operator must promote to
//     'public' AND fill out public_title + public_details before
//     anything appears on /status.
//
// All operations are best-effort — they must never break the calling
// notification path. Wrapped + swallowed at the call site.

import type { Env } from "../types";

// ─── Public types ────────────────────────────────────────────────

export type IncidentStatus =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved"
  | "postmortem"
  // Confirmed not a real outage — fires when a noisy notification or
  // flapping signal triggered an incident that operators have since
  // verified didn't impact customers. Behaves like 'resolved' for
  // lifecycle (sets resolved_at) but is excluded from the public
  // status page so it doesn't show up alongside genuine outages.
  | "false_positive";

export type IncidentSeverity = "critical" | "high" | "medium" | "low" | "info";

export type IncidentVisibility = "internal" | "public";

export type IncidentUpdateKind = "operator" | "system";

export interface IncidentRow {
  id: string;
  title: string;
  description: string | null;
  public_title: string | null;
  public_details: string | null;
  status: IncidentStatus;
  severity: IncidentSeverity;
  visibility: IncidentVisibility;
  affected_components: string | null; // JSON array
  detected_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_by: string | null;
  lead_user_id: string | null;
  source: string;
  source_notification_id: string | null;
  source_group_key: string | null;
  root_cause: string | null;
  mitigation: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentUpdateRow {
  id: string;
  incident_id: string;
  kind: IncidentUpdateKind;
  status: IncidentStatus | null;
  /** Internal narration. Operators can write whatever detail they
   *  want here — never exposed publicly. */
  message: string;
  /** Sanitized customer-safe copy for /status. NULL means this
   *  update never appears publicly even if visibility='public'.
   *  See toPublicShape for the gate. (Migration 0133.) */
  public_message: string | null;
  visibility: IncidentVisibility;
  event_ref: string | null;
  event_type: string | null;
  created_at: string;
  created_by: string | null;
}

// ─── Affected-components inference ───────────────────────────────

/**
 * Derive a set of `affected_components` slugs from a notification's
 * type + metadata. We don't try to be exhaustive — the operator can
 * edit the list when they triage. Catches the common cases.
 */
export function inferAffectedComponents(
  type: string,
  metadata?: Record<string, unknown> | null,
): string[] {
  const out: string[] = [];

  // Feed-related notifications
  if (type.startsWith("platform_feed_")) {
    out.push("category:feeds");
    const feedName = metadata?.feed_name;
    if (typeof feedName === "string" && feedName.length > 0) {
      out.push(`feed:${feedName}`);
    }
  }

  // Agent-related notifications
  if (type === "platform_agent_stalled" || type === "platform_briefing_silent") {
    out.push("category:agents");
    const agentId = metadata?.agent_id;
    if (typeof agentId === "string" && agentId.length > 0) {
      out.push(`agent:${agentId}`);
    }
  }

  // Cron-missed → agents bucket
  if (type.startsWith("platform_cron_")) {
    out.push("category:agents");
  }

  // D1 / KV / CPU / enrichment / AI spend → processing bucket
  if (
    type === "platform_d1_budget_warn" ||
    type === "platform_d1_budget_breach" ||
    type === "platform_kv_budget_warn" ||
    type === "platform_worker_cpu_burst" ||
    type === "platform_enrichment_stuck_pile" ||
    type === "platform_dns_queue_drift" ||
    type === "platform_dns_queue_stalled" ||
    type === "platform_dns_queue_reaper_stalled" ||
    type === "platform_abuse_classifier_silent" ||
    type === "platform_ai_spend_burst"
  ) {
    out.push("category:processing");
  }

  // Resend bounces — communication, not infra. Tag the system but
  // don't dirty a category bucket.
  if (type === "platform_resend_bounces") {
    out.push("system:resend");
  }

  // PR-BB: scheduled DMARC ramp reminder. Email-deliverability
  // hygiene rather than infra alerting — tag the system without a
  // category bucket so it doesn't dilute the processing/agents views.
  if (type === "platform_dmarc_ramp_reminder") {
    out.push("system:email_deliverability");
  }

  // PR-BK: scheduled Phase 2 D1-write-budget review reminder.
  // Cost/budget hygiene rather than infra alerting — tag the system
  // without a category bucket for the same reason as DMARC above.
  if (type === "platform_d1_writes_phase2_review") {
    out.push("system:d1_budget");
  }

  return out;
}

// ─── Auto-creation entry point ───────────────────────────────────

export interface AutoCreateInput {
  /** Notification id from the FIRST recipient row (FK back-ref). */
  notificationId: string;
  /** Shared dedup key across all recipients. Required. */
  groupKey: string;
  type: string;
  severity: IncidentSeverity;
  title: string;
  message: string;
  metadata?: Record<string, unknown> | null;
}

export interface AutoCreateResult {
  /** Existing or newly-created incident id. Null if the notification
   *  isn't critical (we skipped) or the auto-create flow errored. */
  incidentId: string | null;
  /** True if this call created a new row; false on dedup-attach. */
  created: boolean;
}

/**
 * Called from emitPlatformNotification (best-effort, wrapped). Spec:
 *   - severity != 'critical' → return early, no incident.
 *   - existing OPEN incident with same source_group_key → append
 *     system update, return that incident's id.
 *   - otherwise → create a new incident with visibility='internal',
 *     status='investigating', source='auto:<type>'.
 */
export async function autoCreateIncidentFromNotification(
  env: Env,
  input: AutoCreateInput,
): Promise<AutoCreateResult> {
  if (input.severity !== "critical") {
    return { incidentId: null, created: false };
  }

  // Dedup against open incidents by group_key. Status check uses the
  // partial index added in migration 0132 (idx_incidents_source_group_open).
  const existing = await env.DB.prepare(
    `SELECT id FROM incidents
      WHERE source_group_key = ?
        AND status != 'resolved'
      ORDER BY created_at DESC
      LIMIT 1`,
  ).bind(input.groupKey).first<{ id: string }>();

  if (existing) {
    // Re-fire of an open incident's underlying alert. Append a system
    // update so the timeline shows the alert kept firing — useful for
    // postmortem cadence analysis.
    await appendSystemUpdate(env, {
      incidentId: existing.id,
      message: `Notification re-fired: ${input.title}`,
      eventRef: input.notificationId,
      eventType: "platform_notification",
    });
    return { incidentId: existing.id, created: false };
  }

  // Fresh incident.
  const incidentId = crypto.randomUUID();
  const components = inferAffectedComponents(input.type, input.metadata ?? null);

  await env.DB.prepare(
    `INSERT INTO incidents
       (id, title, description, status, severity, visibility,
        affected_components, detected_at, source, source_notification_id,
        source_group_key)
     VALUES (?, ?, ?, 'investigating', 'critical', 'internal',
             ?, datetime('now'), ?, ?, ?)`,
  ).bind(
    incidentId,
    input.title.slice(0, 500),
    input.message.slice(0, 2000),
    components.length > 0 ? JSON.stringify(components) : null,
    `auto:${input.type}`,
    input.notificationId,
    input.groupKey,
  ).run();

  // Seed the timeline with a system update marking the trigger.
  await appendSystemUpdate(env, {
    incidentId,
    message: `Auto-created from ${input.type}: ${input.title}`,
    eventRef: input.notificationId,
    eventType: "platform_notification",
  });

  return { incidentId, created: true };
}

// ─── Timeline helpers ────────────────────────────────────────────

interface AppendSystemUpdateInput {
  incidentId: string;
  message: string;
  eventRef?: string;
  eventType?: "platform_notification" | "agent_run" | "feed_pull" | "status_transition";
  /** Defaults to 'internal' — system updates are noisy + safe to show
   *  internally but can leak detail; operator promotes per-update. */
  visibility?: IncidentVisibility;
  /** Sanitized customer-safe copy. Required to surface publicly even
   *  if visibility='public'. (Migration 0133.) */
  publicMessage?: string | null;
}

export async function appendSystemUpdate(
  env: Env,
  input: AppendSystemUpdateInput,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO incident_updates
       (id, incident_id, kind, status, message, public_message, visibility, event_ref, event_type)
     VALUES (?, ?, 'system', NULL, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.incidentId,
    input.message.slice(0, 2000),
    input.publicMessage ? input.publicMessage.slice(0, 1000) : null,
    input.visibility ?? "internal",
    input.eventRef ?? null,
    input.eventType ?? null,
  ).run();
}

interface AppendOperatorUpdateInput {
  incidentId: string;
  userId: string;
  message: string;
  /** Sanitized customer-safe copy. Required to surface publicly even
   *  if visibility='public'. (Migration 0133.) */
  publicMessage?: string | null;
  /** If non-null, transitions the incident's status. */
  newStatus?: IncidentStatus;
  visibility?: IncidentVisibility;
}

export async function appendOperatorUpdate(
  env: Env,
  input: AppendOperatorUpdateInput,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO incident_updates
       (id, incident_id, kind, status, message, public_message, visibility, created_by)
     VALUES (?, ?, 'operator', ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.incidentId,
    input.newStatus ?? null,
    input.message.slice(0, 4000),
    input.publicMessage ? input.publicMessage.slice(0, 1000) : null,
    input.visibility ?? "internal",
    input.userId,
  ).run();

  if (input.newStatus) {
    await transitionStatus(env, input.incidentId, input.newStatus);
  }
}

/** Move an incident to a new status. Sets resolved_at when crossing
 *  into 'resolved'. Idempotent — calling with the current status is
 *  a no-op. */
export async function transitionStatus(
  env: Env,
  incidentId: string,
  newStatus: IncidentStatus,
): Promise<void> {
  if (newStatus === "resolved" || newStatus === "false_positive") {
    // false_positive shares the resolved lifecycle — closes the
    // timeline + stamps resolved_at — but is filtered from the
    // public status page (see toPublicShape).
    await env.DB.prepare(
      `UPDATE incidents
          SET status = ?, resolved_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(newStatus, incidentId).run();
  } else if (newStatus === "monitoring" || newStatus === "identified") {
    // First non-investigating transition acks the incident.
    await env.DB.prepare(
      `UPDATE incidents
          SET status = ?,
              acknowledged_at = COALESCE(acknowledged_at, datetime('now')),
              resolved_at = NULL,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(newStatus, incidentId).run();
  } else {
    await env.DB.prepare(
      `UPDATE incidents
          SET status = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(newStatus, incidentId).run();
  }
}

// ─── Read helpers ────────────────────────────────────────────────

export async function getIncident(env: Env, id: string): Promise<IncidentRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM incidents WHERE id = ? LIMIT 1`,
  ).bind(id).first<IncidentRow>();
  return row ?? null;
}

// ─── Telemetry merge (read-time) ─────────────────────────────────
//
// Pulls failed agent_runs and feed_pull_history rows scoped to an
// incident's affected_components and time window. These are NOT
// written to incident_updates — we synthesise virtual rows on every
// detail load instead, so:
//   - the historical record stays clean (no row explosion during a
//     long incident)
//   - the timeline always reflects the current truth (e.g. a post-
//     resolution failure pull becomes visible if the operator
//     reopens the incident)
//   - dedup against existing real updates is trivial (skip any
//     event_ref already present)
//
// Cap at TELEMETRY_LIMIT total events per incident so a multi-day
// incident with many failed pulls doesn't drown the editorial
// timeline. Operators see the most recent N; the underlying tables
// are still queryable directly.

const TELEMETRY_LIMIT = 50;

export interface SyntheticTelemetryRow extends IncidentUpdateRow {
  /** Marker so the UI can render telemetry events distinctly from
   *  stored system updates if it wants to. */
  synthetic: true;
}

interface FeedPullEvent {
  id: string;
  feed_name: string;
  status: string;
  records_ingested: number | null;
  error_message: string | null;
  started_at: string;
}

interface AgentRunEvent {
  id: string;
  agent_id: string;
  status: string;
  records_processed: number | null;
  error_message: string | null;
  started_at: string;
}

function parseAffectedComponentsLocal(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Truncate noisy stack traces / curly-brace blobs so the timeline
 *  stays one-line-per-event scannable. */
function truncateMessage(s: string | null, max: number): string {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export async function loadTelemetryEvents(
  env: Env,
  incident: IncidentRow,
  existingEventRefs: Set<string>,
): Promise<SyntheticTelemetryRow[]> {
  const components = parseAffectedComponentsLocal(incident.affected_components);
  if (components.length === 0) return [];

  const feedNames = components
    .filter((c) => c.startsWith("feed:"))
    .map((c) => c.slice(5))
    .filter((n) => n.length > 0);
  const agentIds = components
    .filter((c) => c.startsWith("agent:"))
    .map((c) => c.slice(6))
    .filter((n) => n.length > 0);

  // Window: incident's lifecycle. detected_at falls back to created_at;
  // resolved_at falls back to "now". Keeps live incidents updating as
  // the symptom continues.
  const windowStart = incident.detected_at ?? incident.created_at;
  const windowEnd = incident.resolved_at ?? new Date().toISOString().replace("T", " ").slice(0, 19);

  const events: SyntheticTelemetryRow[] = [];

  // Per-feed failed/partial pulls
  for (const feedName of feedNames) {
    if (events.length >= TELEMETRY_LIMIT) break;
    const rows = await env.DB.prepare(
      `SELECT id, feed_name, status, records_ingested, error_message, started_at
         FROM feed_pull_history
        WHERE feed_name = ?
          AND status IN ('failed', 'partial')
          AND started_at BETWEEN ? AND ?
        ORDER BY started_at DESC
        LIMIT ?`,
    ).bind(feedName, windowStart, windowEnd, TELEMETRY_LIMIT - events.length)
      .all<FeedPullEvent>();
    for (const r of rows.results) {
      const eventRef = `feed_pull:${r.id}`;
      if (existingEventRefs.has(eventRef)) continue;
      const errSnippet = truncateMessage(r.error_message, 140);
      events.push({
        id: `telemetry:${eventRef}`,
        incident_id: incident.id,
        kind: "system",
        status: null,
        message: `feed_pull · ${r.feed_name} · ${r.status}${errSnippet ? `: ${errSnippet}` : ""}`,
        // Telemetry events are internal only — never auto-publicly visible.
        public_message: null,
        visibility: "internal",
        event_ref: eventRef,
        event_type: "feed_pull",
        created_at: r.started_at,
        created_by: null,
        synthetic: true,
      });
    }
  }

  // Per-agent failed/partial runs
  for (const agentId of agentIds) {
    if (events.length >= TELEMETRY_LIMIT) break;
    const rows = await env.DB.prepare(
      `SELECT id, agent_id, status, records_processed, error_message, started_at
         FROM agent_runs
        WHERE agent_id = ?
          AND status IN ('failed', 'partial', 'killed')
          AND started_at BETWEEN ? AND ?
        ORDER BY started_at DESC
        LIMIT ?`,
    ).bind(agentId, windowStart, windowEnd, TELEMETRY_LIMIT - events.length)
      .all<AgentRunEvent>();
    for (const r of rows.results) {
      const eventRef = `agent_run:${r.id}`;
      if (existingEventRefs.has(eventRef)) continue;
      const errSnippet = truncateMessage(r.error_message, 140);
      events.push({
        id: `telemetry:${eventRef}`,
        incident_id: incident.id,
        kind: "system",
        status: null,
        message: `agent_run · ${r.agent_id} · ${r.status}${errSnippet ? `: ${errSnippet}` : ""}`,
        public_message: null,
        visibility: "internal",
        event_ref: eventRef,
        event_type: "agent_run",
        created_at: r.started_at,
        created_by: null,
        synthetic: true,
      });
    }
  }

  return events;
}



export async function listIncidentUpdates(
  env: Env,
  incidentId: string,
): Promise<IncidentUpdateRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM incident_updates
      WHERE incident_id = ?
      ORDER BY created_at ASC`,
  ).bind(incidentId).all<IncidentUpdateRow>();
  return res.results;
}

export async function listIncidents(
  env: Env,
  opts: { onlyOpen?: boolean; visibility?: IncidentVisibility; limit?: number } = {},
): Promise<IncidentRow[]> {
  const limit = opts.limit ?? 100;
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (opts.onlyOpen) {
    filters.push(`status != 'resolved'`);
  }
  if (opts.visibility) {
    filters.push(`visibility = ?`);
    binds.push(opts.visibility);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const res = await env.DB.prepare(
    `SELECT * FROM incidents ${where}
      ORDER BY
        CASE status WHEN 'resolved' THEN 1 ELSE 0 END,
        CASE severity
          WHEN 'critical' THEN 0 WHEN 'high' THEN 1
          WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        created_at DESC
      LIMIT ?`,
  ).bind(...binds, limit).all<IncidentRow>();
  return res.results;
}

// ─── Public-safe row shape ───────────────────────────────────────
// Strips internal fields and renames public_title/public_details to
// the names the public status page consumes. Never expose the raw
// `title` or `description` — those may leak system internals.

export interface PublicIncident {
  id: string;
  title: string;
  details: string | null;
  status: IncidentStatus;
  severity: IncidentSeverity;
  affected_components: string[];
  started_at: string;
  resolved_at: string | null;
  updates: Array<{
    id: string;
    status: IncidentStatus | null;
    message: string;
    created_at: string;
  }>;
}

export function toPublicShape(
  incident: IncidentRow,
  publicUpdates: IncidentUpdateRow[],
): PublicIncident | null {
  // Hard requirement: visibility=public AND public_title set. If
  // either is missing the operator hasn't promoted it; drop on the
  // floor.
  if (incident.visibility !== "public" || !incident.public_title) return null;
  // false_positive is the "confirmed not a real outage" status. It uses
  // resolved's lifecycle for cleanup but is intentionally hidden from
  // the public list — operators close noisy/flapping incidents without
  // them appearing alongside genuine outages on the status site.
  if (incident.status === "false_positive") return null;
  // Per-update gate (migration 0133): an update only appears publicly
  // if BOTH visibility='public' AND public_message is non-null. The
  // sanitized public_message is what we render — never the internal
  // `message`, which may leak commit hashes / feed names / code paths.
  const safeUpdates = publicUpdates
    .filter((u) => u.public_message !== null && u.public_message.trim().length > 0)
    .map((u) => ({
      id: u.id,
      status: u.status,
      message: u.public_message ?? "",
      created_at: u.created_at,
    }));
  return {
    id: incident.id,
    title: incident.public_title,
    details: incident.public_details,
    status: incident.status,
    severity: incident.severity,
    affected_components: parseComponents(incident.affected_components),
    started_at: incident.detected_at ?? incident.created_at,
    resolved_at: incident.resolved_at,
    updates: safeUpdates,
  };
}

function parseComponents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
