// Averrow — Incidents API handlers
//
// Three flavors:
//   /api/admin/incidents/*         — full CRUD for super_admin operators.
//   /api/internal/incidents/*      — same surface for AVERROW_INTERNAL_SECRET
//                                    callers (averrow-mcp).
//   /api/v1/public/incidents       — sanitized list of public-promoted
//                                    incidents for the /status page.
//
// Public-shape conversion is owned by lib/incidents.toPublicShape so
// the visibility gate is enforced in one place.

import { json } from "../lib/cors";
import {
  getIncident,
  listIncidentUpdates,
  listIncidents,
  appendOperatorUpdate,
  appendSystemUpdate,
  transitionStatus,
  toPublicShape,
  loadTelemetryEvents,
  type IncidentRow,
  type IncidentStatus,
  type IncidentSeverity,
  type IncidentVisibility,
} from "../lib/incidents";
import type { Env } from "../types";

const VALID_STATUS = new Set<IncidentStatus>([
  "investigating", "identified", "monitoring", "resolved", "postmortem",
]);
const VALID_SEVERITY = new Set<IncidentSeverity>([
  "critical", "high", "medium", "low", "info",
]);
const VALID_VISIBILITY = new Set<IncidentVisibility>(["internal", "public"]);

function parseAffectedComponents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function rowToAdminShape(row: IncidentRow) {
  return {
    ...row,
    affected_components: parseAffectedComponents(row.affected_components),
  };
}

// ─── List (admin) ────────────────────────────────────────────────

export async function handleListIncidents(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const onlyOpen = url.searchParams.get("status") === "open";
  const visibility = url.searchParams.get("visibility");

  const rows = await listIncidents(env, {
    onlyOpen,
    visibility: visibility === "public" || visibility === "internal" ? visibility : undefined,
    limit: 100,
  });

  return json({
    success: true,
    data: rows.map(rowToAdminShape),
    total: rows.length,
  }, 200, origin);
}

// ─── Detail (admin) ──────────────────────────────────────────────

export async function handleGetIncident(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!id) return json({ success: false, error: "missing id" }, 400, origin);

  const incident = await getIncident(env, id);
  if (!incident) return json({ success: false, error: "not found" }, 404, origin);

  const updates = await listIncidentUpdates(env, id);

  // Read-time merge: pull failed feed_pull_history + agent_runs rows
  // scoped to the incident's components and time window. Telemetry
  // events are NOT written to incident_updates — they're synthesised
  // every load so the historical record stays clean and a long
  // incident doesn't explode the update count. Dedup against any
  // event_refs already on existing updates so the auto-create
  // notification entry doesn't double-render.
  const existingRefs = new Set(
    updates.map((u) => u.event_ref).filter((r): r is string => !!r),
  );
  const telemetry = await loadTelemetryEvents(env, incident, existingRefs).catch(() => []);

  // Merge the two streams chronologically. Stored updates have a real
  // id; synthetic rows carry the `synthetic: true` marker so the UI
  // can render them distinctly.
  const merged = [...updates, ...telemetry].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );

  return json({
    success: true,
    data: {
      incident: rowToAdminShape(incident),
      updates: merged,
      telemetry_count: telemetry.length,
    },
  }, 200, origin);
}

// ─── Create (manual) ─────────────────────────────────────────────

interface CreateBody {
  title?: string;
  description?: string;
  severity?: IncidentSeverity;
  affected_components?: string[];
  status?: IncidentStatus;
}

export async function handleCreateIncident(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  let body: CreateBody;
  try {
    body = await request.json() as CreateBody;
  } catch {
    return json({ success: false, error: "invalid JSON" }, 400, origin);
  }

  const title = (body.title ?? "").trim();
  if (!title) return json({ success: false, error: "title required" }, 400, origin);
  if (title.length > 500) return json({ success: false, error: "title too long" }, 400, origin);

  const severity: IncidentSeverity =
    body.severity && VALID_SEVERITY.has(body.severity) ? body.severity : "high";
  const status: IncidentStatus =
    body.status && VALID_STATUS.has(body.status) ? body.status : "investigating";

  // Normalize affected_components — strip non-strings, length-cap.
  const components = (body.affected_components ?? [])
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .slice(0, 20);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO incidents
       (id, title, description, status, severity, visibility,
        affected_components, detected_at, created_by, source)
     VALUES (?, ?, ?, ?, ?, 'internal', ?, datetime('now'), ?, 'manual')`,
  ).bind(
    id,
    title,
    body.description?.slice(0, 4000) ?? null,
    status,
    severity,
    components.length > 0 ? JSON.stringify(components) : null,
    userId,
  ).run();

  await appendSystemUpdate(env, {
    incidentId: id,
    message: `Incident created manually`,
    eventType: "status_transition",
  });

  const incident = await getIncident(env, id);
  return json({ success: true, data: incident ? rowToAdminShape(incident) : null }, 201, origin);
}

// ─── Append operator update / transition status ──────────────────

interface UpdateBody {
  message?: string;
  status?: IncidentStatus;
  visibility?: IncidentVisibility;
}

export async function handleAppendIncidentUpdate(
  request: Request,
  env: Env,
  id: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!id) return json({ success: false, error: "missing id" }, 400, origin);

  let body: UpdateBody;
  try {
    body = await request.json() as UpdateBody;
  } catch {
    return json({ success: false, error: "invalid JSON" }, 400, origin);
  }

  const message = (body.message ?? "").trim();
  if (!message) return json({ success: false, error: "message required" }, 400, origin);

  const incident = await getIncident(env, id);
  if (!incident) return json({ success: false, error: "not found" }, 404, origin);

  const newStatus = body.status && VALID_STATUS.has(body.status) ? body.status : undefined;
  const visibility = body.visibility && VALID_VISIBILITY.has(body.visibility) ? body.visibility : "internal";

  await appendOperatorUpdate(env, {
    incidentId: id,
    userId,
    message,
    newStatus,
    visibility,
  });

  const updates = await listIncidentUpdates(env, id);
  const refreshed = await getIncident(env, id);
  return json({
    success: true,
    data: {
      incident: refreshed ? rowToAdminShape(refreshed) : null,
      updates,
    },
  }, 200, origin);
}

// ─── Promote / demote visibility + edit public copy ──────────────

interface PromoteBody {
  visibility?: IncidentVisibility;
  public_title?: string | null;
  public_details?: string | null;
}

export async function handlePromoteIncident(
  request: Request,
  env: Env,
  id: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!id) return json({ success: false, error: "missing id" }, 400, origin);

  let body: PromoteBody;
  try {
    body = await request.json() as PromoteBody;
  } catch {
    return json({ success: false, error: "invalid JSON" }, 400, origin);
  }

  const incident = await getIncident(env, id);
  if (!incident) return json({ success: false, error: "not found" }, 404, origin);

  const visibility = body.visibility && VALID_VISIBILITY.has(body.visibility)
    ? body.visibility
    : incident.visibility;

  // Public promotion requires a public_title — defense in depth on
  // top of the schema CHECK. Operator must write customer-safe copy
  // before anything appears on /status.
  const publicTitle = typeof body.public_title === "string" ? body.public_title.trim() : incident.public_title;
  const publicDetails = typeof body.public_details === "string" ? body.public_details.trim() : incident.public_details;

  if (visibility === "public" && (!publicTitle || publicTitle.length === 0)) {
    return json({
      success: false,
      error: "public_title required to promote to public visibility",
    }, 400, origin);
  }
  if (publicTitle && publicTitle.length > 200) {
    return json({ success: false, error: "public_title too long (200 max)" }, 400, origin);
  }
  if (publicDetails && publicDetails.length > 2000) {
    return json({ success: false, error: "public_details too long (2000 max)" }, 400, origin);
  }

  await env.DB.prepare(
    `UPDATE incidents
        SET visibility = ?,
            public_title = ?,
            public_details = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).bind(
    visibility,
    publicTitle ?? null,
    publicDetails ?? null,
    id,
  ).run();

  // Log the visibility change as a system update so the timeline
  // shows when the incident went public + who did it.
  if (visibility !== incident.visibility) {
    await appendSystemUpdate(env, {
      incidentId: id,
      message: `Visibility changed to ${visibility} by ${userId}`,
      eventType: "status_transition",
    });
  }

  const refreshed = await getIncident(env, id);
  return json({
    success: true,
    data: refreshed ? rowToAdminShape(refreshed) : null,
  }, 200, origin);
}

// ─── Status shortcut (transition without a message) ──────────────

interface TransitionBody {
  status?: IncidentStatus;
}

export async function handleTransitionIncidentStatus(
  request: Request,
  env: Env,
  id: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!id) return json({ success: false, error: "missing id" }, 400, origin);

  let body: TransitionBody;
  try {
    body = await request.json() as TransitionBody;
  } catch {
    return json({ success: false, error: "invalid JSON" }, 400, origin);
  }

  if (!body.status || !VALID_STATUS.has(body.status)) {
    return json({ success: false, error: "valid status required" }, 400, origin);
  }

  const incident = await getIncident(env, id);
  if (!incident) return json({ success: false, error: "not found" }, 404, origin);

  if (incident.status === body.status) {
    return json({ success: true, data: rowToAdminShape(incident), unchanged: true }, 200, origin);
  }

  await transitionStatus(env, id, body.status);
  await appendSystemUpdate(env, {
    incidentId: id,
    message: `Status: ${incident.status} → ${body.status} (by ${userId})`,
    eventType: "status_transition",
  });

  const refreshed = await getIncident(env, id);
  return json({
    success: true,
    data: refreshed ? rowToAdminShape(refreshed) : null,
  }, 200, origin);
}

// ─── Public list (no auth) — feeds /status ───────────────────────

export async function handlePublicIncidents(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  const rows = await listIncidents(env, { visibility: "public", limit: 20 });
  const out = await Promise.all(rows.map(async (row) => {
    const updates = await listIncidentUpdates(env, row.id);
    const publicUpdates = updates.filter((u) => u.visibility === "public");
    return toPublicShape(row, publicUpdates);
  }));

  return json({
    success: true,
    data: out.filter((x): x is NonNullable<typeof x> => x !== null),
    generated_at: new Date().toISOString(),
  }, 200, origin);
}
