// Averrow — Takedown Request Handlers (org-scoped + admin queue)

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { emitOrgEvent } from "../lib/org-events";
import { computePriorityScore } from "../lib/scoring-utils";
import {
  orgHandler, handler, checkOrgAccess,
  parsePagination, parseFilters, buildWhereClause,
  parseBody, success, error, paginatedResponse, requireFields,
} from "../lib/handler-utils";
import { requireAuthorizationForModule, TakedownNotAuthorizedError, isUnderMonthlyTakedownCap } from "../lib/takedown-authorizations";
import type { Env, CreateTakedownBody, UpdateTakedownBody } from "../types";
import type { AuthContext } from "../middleware/auth";
import type { ModuleKey } from "../lib/entitlements";
import type { ProviderRecord } from "../lib/takedown-submitters";

// ─── Platform Abuse Contacts ─────────────────────────────────

const PLATFORM_ABUSE_CONTACTS: Record<string, { name: string; url: string; method: string }> = {
  twitter: { name: "Twitter/X", url: "https://help.x.com/forms/impersonation", method: "form" },
  instagram: { name: "Instagram", url: "https://help.instagram.com/contact/636276399721841", method: "form" },
  linkedin: { name: "LinkedIn", url: "https://www.linkedin.com/help/linkedin/ask/TS-NFPI", method: "form" },
  tiktok: { name: "TikTok", url: "https://www.tiktok.com/legal/report/feedback", method: "form" },
  github: { name: "GitHub", url: "https://support.github.com/contact/dmca-takedown", method: "form" },
  youtube: { name: "YouTube", url: "https://www.youtube.com/reportabuse", method: "form" },
  // App-store marketplaces — reported via each store's IP/abuse channel.
  iosappstore: { name: "Apple App Store", url: "https://www.apple.com/legal/internet-services/itunes/appstorenotices/", method: "form" },
  googleplaystore: { name: "Google Play Store", url: "https://support.google.com/legal/troubleshooter/1114905", method: "form" },
};

// ─── Constants ───────────────────────────────────────────────

const VALID_STATUSES = ["draft", "requested", "submitted", "pending_response", "taken_down", "failed", "expired", "withdrawn"];
const TENANT_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["requested", "withdrawn"],
  requested: ["withdrawn"],
};
const ADMIN_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["requested", "submitted", "withdrawn"],
  requested: ["submitted", "withdrawn", "draft"],
  submitted: ["pending_response", "taken_down", "failed", "requested"],
  pending_response: ["taken_down", "failed", "expired"],
};

// ─── POST /api/orgs/:orgId/takedowns ─────────────────────────

export const handleCreateTakedown = orgHandler(async (request, env, orgId, ctx) => {
  const body = await parseBody<CreateTakedownBody>(request);

  const fieldErr = requireFields(
    body as unknown as Record<string, unknown>,
    ["brand_id", "target_type", "target_value", "evidence_summary"],
    ctx.origin,
  );
  if (fieldErr) return fieldErr;

  const { brand_id: brandId, target_type: targetType, target_value: targetValue, evidence_summary: evidenceSummary } = body;

  const validTargetTypes = ["domain", "social_profile", "url", "email", "mobile_app"];
  if (!validTargetTypes.includes(targetType)) {
    return error(`Invalid target_type. Must be one of: ${validTargetTypes.join(", ")}`, 400, ctx.origin);
  }

  // Verify brand is assigned to org
  const orgBrand = await env.DB.prepare(
    "SELECT 1 FROM org_brands WHERE org_id = ? AND brand_id = ?"
  ).bind(orgId, brandId).first();
  if (!orgBrand) {
    return error("Brand not assigned to your organization", 404, ctx.origin);
  }

  // Auto-fill evidence from source
  let evidenceDetail = body.evidence_detail || null;
  let severity = "MEDIUM";

  if (body.source_type === "social_profile" && body.source_id) {
    const profile = await env.DB.prepare(
      "SELECT ai_evidence_draft, ai_assessment FROM social_profiles WHERE id = ? AND brand_id = ?"
    ).bind(body.source_id, brandId).first<{ ai_evidence_draft: string | null; ai_assessment: string | null }>();
    if (profile) {
      if (!evidenceDetail && profile.ai_evidence_draft) evidenceDetail = profile.ai_evidence_draft;
      if (!evidenceDetail && profile.ai_assessment) evidenceDetail = profile.ai_assessment;
    }
  }

  if (body.source_type === "alert" && body.source_id) {
    const alert = await env.DB.prepare(
      "SELECT severity, summary, ai_assessment FROM alerts WHERE id = ? AND brand_id = ?"
    ).bind(body.source_id, brandId).first<{ severity: string; summary: string; ai_assessment: string | null }>();
    if (alert) {
      severity = alert.severity || severity;
      if (!evidenceDetail) evidenceDetail = [alert.summary, alert.ai_assessment].filter(Boolean).join("\n\n");
    }
  }

  if (body.source_type === "app_store_listing" && body.source_id) {
    const listing = await env.DB.prepare(
      "SELECT severity, ai_assessment, classification_reason, impersonation_signals FROM app_store_listings WHERE id = ? AND brand_id = ?"
    ).bind(body.source_id, brandId).first<{
      severity: string;
      ai_assessment: string | null;
      classification_reason: string | null;
      impersonation_signals: string | null;
    }>();
    if (listing) {
      severity = listing.severity || severity;
      if (!evidenceDetail) {
        evidenceDetail = [listing.ai_assessment, listing.classification_reason, listing.impersonation_signals]
          .filter(Boolean).join("\n\n");
      }
    }
  }

  // Typosquat takedown — source_type='threat' resolves the row from
  // the threats table. Pulls severity + a sensible evidence draft
  // built from the row's intel (source feed, hosting provider, first
  // seen). The provider auto-detect block below the source switch
  // already pulls hosting_provider + abuse contact when targetType is
  // 'domain', so we don't need to duplicate that here.
  if (body.source_type === "threat" && body.source_id) {
    const threat = await env.DB.prepare(
      `SELECT t.severity, t.source_feed, t.threat_type, t.malicious_domain,
              hp.name AS hosting_provider, t.country_code, t.first_seen
       FROM threats t
       LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
       WHERE t.id = ? AND t.target_brand_id = ?`
    ).bind(body.source_id, brandId).first<{
      severity: string | null;
      source_feed: string;
      threat_type: string;
      malicious_domain: string | null;
      hosting_provider: string | null;
      country_code: string | null;
      first_seen: string | null;
    }>();
    if (threat) {
      severity = (threat.severity ?? severity).toUpperCase();
      if (!evidenceDetail) {
        const parts = [
          `Threat type: ${threat.threat_type}`,
          `Detected by: ${threat.source_feed}`,
          threat.malicious_domain ? `Malicious domain: ${threat.malicious_domain}` : null,
          threat.hosting_provider ? `Hosting provider: ${threat.hosting_provider}` : null,
          threat.country_code ? `Country: ${threat.country_code}` : null,
          threat.first_seen ? `First seen: ${threat.first_seen}` : null,
        ].filter(Boolean);
        evidenceDetail = parts.join("\n");
      }
    }
  }

  // Auto-detect provider abuse contact
  let providerName: string | null = null;
  let providerAbuseContact: string | null = null;
  let providerMethod = "email";
  const targetPlatform = body.target_platform || null;

  if ((targetType === "social_profile" || targetType === "mobile_app") && targetPlatform) {
    const platformKey = targetPlatform.toLowerCase().replace(/[^a-z]/g, "");
    const contact = PLATFORM_ABUSE_CONTACTS[platformKey];
    if (contact) {
      providerName = contact.name;
      providerAbuseContact = contact.url;
      providerMethod = contact.method;
    }
  } else if (targetType === "domain") {
    const threat = await env.DB.prepare(
      `SELECT hp.name AS hosting_provider, pac.abuse_email AS hosting_provider_abuse_email
       FROM threats t
       LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
       LEFT JOIN provider_abuse_contacts pac ON pac.id = hp.abuse_contact_id
       WHERE t.malicious_domain = ? LIMIT 1`
    ).bind(targetValue).first<{ hosting_provider: string | null; hosting_provider_abuse_email: string | null }>();
    if (threat) {
      providerName = threat.hosting_provider;
      providerAbuseContact = threat.hosting_provider_abuse_email;
    }
  }

  const id = crypto.randomUUID();
  const priorityScore = computePriorityScore(severity);

  await env.DB.prepare(`
    INSERT INTO takedown_requests (
      id, org_id, brand_id, target_type, target_value, target_platform, target_url,
      source_type, source_id, evidence_summary, evidence_detail, evidence_urls,
      provider_name, provider_abuse_contact, provider_method,
      status, severity, priority_score, notes, requested_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
  `).bind(
    id, orgId, brandId, targetType, targetValue, targetPlatform,
    body.target_url || null,
    body.source_type || null, body.source_id || null,
    evidenceSummary, evidenceDetail, body.evidence_urls || null,
    providerName, providerAbuseContact, providerMethod,
    severity, priorityScore, body.notes || null, ctx.userId,
  ).run();

  await audit(env, {
    action: "takedown_create",
    userId: ctx.userId,
    resourceType: "takedown_request",
    resourceId: id,
    details: { org_id: orgId, brand_id: brandId, target_type: targetType, target_value: targetValue },
    outcome: "success",
    request,
  });

  return success({ id }, ctx.origin, 201);
}, { minRole: "analyst" });

// ─── GET /api/orgs/:orgId/takedowns ──────────────────────────

export const handleListTakedowns = orgHandler(async (request, env, orgId, ctx) => {
  const { limit, offset } = parsePagination(request);
  const filters = parseFilters(request, ["status", "brand_id", "target_type"]);
  const { clause: filterClause, bindings: filterBindings } = buildWhereClause(filters, {
    status: "tr.status",
    brand_id: "tr.brand_id",
    target_type: "tr.target_type",
  });

  const bindings = [orgId, ...filterBindings];
  const whereClause = `1=1 AND ${filterClause}`;

  const result = await env.DB.prepare(`
    SELECT tr.*, b.name AS brand_name
    FROM takedown_requests tr
    JOIN org_brands ob ON ob.brand_id = tr.brand_id AND ob.org_id = ?
    JOIN brands b ON b.id = tr.brand_id
    WHERE ${whereClause}
    ORDER BY
      CASE tr.status
        WHEN 'draft' THEN 1
        WHEN 'requested' THEN 2
        WHEN 'submitted' THEN 3
        WHEN 'pending_response' THEN 4
        ELSE 5
      END,
      tr.priority_score DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, limit, offset).all();

  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM takedown_requests tr
    JOIN org_brands ob ON ob.brand_id = tr.brand_id AND ob.org_id = ?
    WHERE ${whereClause}
  `).bind(...bindings).first<{ total: number }>();

  const statusCounts = await env.DB.prepare(`
    SELECT tr.status, COUNT(*) AS count
    FROM takedown_requests tr
    JOIN org_brands ob ON ob.brand_id = tr.brand_id AND ob.org_id = ?
    GROUP BY tr.status
  `).bind(orgId).all();

  return paginatedResponse(result.results || [], countResult?.total ?? 0, ctx.origin, {
    status_counts: statusCounts.results || [],
  });
});

// ─── GET /api/orgs/:orgId/takedowns/:id ──────────────────────

export async function handleGetTakedown(
  request: Request, env: Env, orgId: string, takedownId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = checkOrgAccess(ctx, orgId, origin);
  if (accessErr) return accessErr;

  try {
    const takedown = await env.DB.prepare(`
      SELECT tr.*, b.name AS brand_name
      FROM takedown_requests tr
      JOIN org_brands ob ON ob.brand_id = tr.brand_id AND ob.org_id = ?
      JOIN brands b ON b.id = tr.brand_id
      WHERE tr.id = ?
    `).bind(orgId, takedownId).first();

    if (!takedown) return error("Takedown request not found", 404, origin);

    return success(takedown, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ─── PATCH /api/orgs/:orgId/takedowns/:id ────────────────────

export async function handleUpdateTakedown(
  request: Request, env: Env, orgId: string, takedownId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = checkOrgAccess(ctx, orgId, origin, { minRole: "analyst" });
  if (accessErr) return accessErr;

  try {
    const body = await parseBody<UpdateTakedownBody>(request);

    const takedown = await env.DB.prepare(`
      SELECT tr.id, tr.status
      FROM takedown_requests tr
      JOIN org_brands ob ON ob.brand_id = tr.brand_id AND ob.org_id = ?
      WHERE tr.id = ?
    `).bind(orgId, takedownId).first<{ id: string; status: string }>();

    if (!takedown) return error("Takedown request not found", 404, origin);

    const updates: string[] = [];
    const values: unknown[] = [];

    if (typeof body.status === "string") {
      if (!VALID_STATUSES.includes(body.status)) {
        return error(`Invalid status: ${body.status}`, 400, origin);
      }

      const allowed = TENANT_ALLOWED_TRANSITIONS[takedown.status];
      if (!allowed || !allowed.includes(body.status)) {
        return error(`Cannot transition from '${takedown.status}' to '${body.status}'`, 400, origin);
      }

      updates.push("status = ?");
      values.push(body.status);

      if (body.status === "requested") {
        updates.push("requested_at = datetime('now')");
        updates.push("requested_by = ?");
        values.push(ctx.userId);
      }
      if (body.status === "withdrawn") {
        updates.push("resolved_at = datetime('now')");
        updates.push("resolution = 'withdrawn'");
      }
    }

    if (typeof body.notes === "string") { updates.push("notes = ?"); values.push(body.notes); }
    if (typeof body.evidence_summary === "string") { updates.push("evidence_summary = ?"); values.push(body.evidence_summary); }
    if (typeof body.evidence_detail === "string") { updates.push("evidence_detail = ?"); values.push(body.evidence_detail); }

    if (updates.length === 0) return error("No valid fields to update", 400, origin);

    updates.push("updated_at = datetime('now')");
    values.push(takedownId);

    await env.DB.prepare(
      `UPDATE takedown_requests SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...values).run();

    await audit(env, {
      action: "takedown_update",
      userId: ctx.userId,
      resourceType: "takedown_request",
      resourceId: takedownId,
      details: { org_id: orgId, previous_status: takedown.status, new_status: body.status ?? takedown.status },
      outcome: "success",
      request,
    });

    if (typeof body.status === "string" && body.status !== takedown.status) {
      emitOrgEvent(env, Number(orgId), "takedown.status_changed", {
        takedown_id: takedownId,
        previous_status: takedown.status,
        new_status: body.status,
        updated_by: ctx.userId,
      }).catch(() => {});
    }

    return json({ success: true, message: "Takedown request updated" }, 200, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ─── GET /api/admin/takedowns (SOC queue — `manage_takedowns`) ─

export const handleAdminListTakedowns = handler(async (request, env, ctx) => {
  const url = new URL(request.url);
  const { limit, offset } = parsePagination(request);
  const filters = parseFilters(request, ["status", "org_id", "severity", "target_type"]);
  const { clause: filterClause, bindings: filterBindings } = buildWhereClause(filters, {
    status: "tr.status",
    org_id: "tr.org_id",
    severity: "tr.severity",
    target_type: "tr.target_type",
  });

  // Search support
  const search = url.searchParams.get("search")?.trim() || "";
  let searchClause = "";
  const searchBindings: unknown[] = [];
  if (search) {
    searchClause = " AND (b.name LIKE ? OR tr.target_value LIKE ? OR tr.target_url LIKE ?)";
    const like = `%${search}%`;
    searchBindings.push(like, like, like);
  }

  // Sort support
  const sort = url.searchParams.get("sort") || "priority";
  let orderClause: string;
  switch (sort) {
    case "newest":
      orderClause = "tr.created_at DESC";
      break;
    case "brand":
      orderClause = "b.name ASC, tr.priority_score DESC";
      break;
    default: // "priority"
      orderClause = `CASE tr.status
        WHEN 'requested' THEN 1
        WHEN 'submitted' THEN 2
        WHEN 'pending_response' THEN 3
        WHEN 'draft' THEN 4
        ELSE 5
      END, tr.priority_score DESC, tr.created_at DESC`;
      break;
  }

  const allBindings = [...filterBindings, ...searchBindings];

  const result = await env.DB.prepare(`
    SELECT tr.*, b.name AS brand_name, b.canonical_domain AS brand_domain,
           o.name AS org_name,
           (SELECT COUNT(*) FROM takedown_evidence te WHERE te.takedown_id = tr.id) AS evidence_count
    FROM takedown_requests tr
    JOIN brands b ON b.id = tr.brand_id
    LEFT JOIN organizations o ON o.id = tr.org_id
    WHERE ${filterClause}${searchClause}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?
  `).bind(...allBindings, limit, offset).all();

  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM takedown_requests tr
    JOIN brands b ON b.id = tr.brand_id
    WHERE ${filterClause}${searchClause}
  `).bind(...allBindings).first<{ total: number }>();

  const statusCounts = await env.DB.prepare(`
    SELECT status, COUNT(*) AS count FROM takedown_requests GROUP BY status
  `).all();

  return paginatedResponse(result.results || [], countResult?.total ?? 0, ctx.origin, {
    status_counts: statusCounts.results || [],
  });
});

// ─── GET /api/admin/takedowns/integrations ───────────────────
// Per-integration health rollup (NetBeacon / GoDaddy / Web Risk / email):
// configured? live? submissions / success rate / last submission / last
// error over a window. Powers the Ops "Integrations" view.

export const handleAdminTakedownIntegrations = handler(async (request, env, ctx) => {
  const url = new URL(request.url);
  const hoursParam = parseInt(url.searchParams.get("hours") ?? "168", 10);
  const windowHours = Number.isFinite(hoursParam) ? Math.min(Math.max(hoursParam, 1), 720) : 168;

  const { getTakedownIntegrations } = await import("../lib/takedown-integrations");
  const report = await getTakedownIntegrations(env, windowHours);
  return success(report, ctx.origin);
});

// ─── GET /api/admin/takedowns/metrics ────────────────────────
// S2.1 — real takedown-effectiveness metrics (submission→resolution
// time p50/p90/avg, monthly submitted-vs-resolved volume, and the
// resolved-only success rate with auditable raw counts) for the Ops
// takedown console. Route gate: requirePermission("manage_takedowns")
// (analyst + admin/super_admin), matching the rest of the admin
// takedown surface.
//
// OPS-ONLY: these figures are deliberately NOT wired to the public /
// marketing site. Surfacing any of them as a customer-facing claim is
// gated behind owner sign-off (improvement-plan S1.5).
//
// Reads via a read-replica session; the aggregate result is wrapped in
// cachedValue (300s) to keep the ~6 GROUP-BY reads off D1 on repeat loads.

export const handleAdminTakedownMetrics = handler(async (request, env, ctx) => {
  const { getDbContext, getReadSession, attachBookmark } = await import("../lib/db");
  const { cachedValue } = await import("../lib/cached-value");
  const { getTakedownMetrics } = await import("../lib/takedown-metrics");

  const dbCtx = getDbContext(request);
  const session = getReadSession(env, dbCtx);

  const metrics = await cachedValue(env, "takedowns.metrics.overall", 300, () =>
    getTakedownMetrics(session),
  );

  return attachBookmark(success(metrics, ctx.origin), session);
});

// ─── PATCH /api/admin/takedowns/:id ──────────────────────────
// Route gate: requirePermission("manage_takedowns") — held by
// super_admin, admin, AND analyst (see lib/role-permissions.ts), so
// this is analyst-reachable, NOT super_admin-only. The →submitted
// transition additionally enforces legal standing below (TK1).

export async function handleAdminUpdateTakedown(
  request: Request, env: Env, takedownId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const body = await parseBody<UpdateTakedownBody>(request);

    const takedown = await env.DB.prepare(
      "SELECT id, status, org_id, brand_id, module_key FROM takedown_requests WHERE id = ?"
    ).bind(takedownId).first<{
      id: string; status: string;
      org_id: number | null; brand_id: string | null; module_key: string | null;
    }>();

    if (!takedown) return error("Takedown request not found", 404, origin);

    const updates: string[] = [];
    const values: unknown[] = [];

    if (typeof body.status === "string") {
      if (!VALID_STATUSES.includes(body.status)) {
        return error(`Invalid status: ${body.status}`, 400, origin);
      }

      const allowed = ADMIN_ALLOWED_TRANSITIONS[takedown.status];
      if (allowed && !allowed.includes(body.status)) {
        return error(`Cannot transition from '${takedown.status}' to '${body.status}'`, 400, origin);
      }

      // TK1 (Phase 1 PR-B) — legal-standing gate on the →submitted edge.
      // Stamping status='submitted' asserts "Averrow sent this" in the
      // audit trail. The admin state machine only reaches the external-
      // action lifecycle (submitted → pending_response/taken_down/failed/
      // expired) THROUGH 'submitted', so gating this one edge transitively
      // protects the whole lifecycle. Enforce the SAME standing Sparrow
      // Phase G requires before any real dispatch (agents/sparrow.ts):
      // an owning org that owns the brand and holds an active takedown
      // authorization covering the module. This does NOT dispatch — it
      // only decides whether the status flip is permitted. Actual outbound
      // submission stays in Sparrow Phase G / the future hand-submit path.
      if (body.status === "submitted") {
        if (takedown.org_id === null || takedown.org_id === undefined) {
          return error(
            "Cannot mark this takedown 'submitted' without an owning org — no legal standing to assert an external submission on an orgless (prospect) draft.",
            422, origin,
          );
        }
        const ownsBrand = await env.DB.prepare(
          "SELECT 1 FROM org_brands WHERE org_id = ? AND brand_id = ?"
        ).bind(takedown.org_id, takedown.brand_id).first();
        if (!ownsBrand) {
          return error(
            "Owning org does not own the target brand — no legal standing to mark 'submitted'.",
            403, origin,
          );
        }
        if (!takedown.module_key) {
          return error(
            "Takedown has no module_key — cannot verify takedown authorization to mark 'submitted'.",
            422, origin,
          );
        }
        try {
          await requireAuthorizationForModule(env, takedown.org_id, takedown.module_key as ModuleKey);
        } catch (authErr) {
          if (authErr instanceof TakedownNotAuthorizedError) {
            return error(
              `Org lacks an active takedown authorization covering module '${takedown.module_key}' — cannot mark 'submitted'.`,
              403, origin,
            );
          }
          throw authErr;
        }
      }

      updates.push("status = ?");
      values.push(body.status);

      if (body.status === "submitted") {
        updates.push("submitted_at = datetime('now')");
        updates.push("submitted_by = ?");
        values.push(ctx.userId);
      }
      if (body.status === "taken_down") {
        updates.push("resolved_at = datetime('now')");
        updates.push("resolution = 'taken_down'");
      }
      if (body.status === "failed") {
        updates.push("resolved_at = datetime('now')");
        updates.push("resolution = 'refused'");
      }
      if (body.status === "expired") {
        updates.push("resolved_at = datetime('now')");
        updates.push("resolution = 'expired'");
      }
      if (body.status === "pending_response") {
        updates.push("response_received_at = datetime('now')");
      }
    }

    if (typeof body.response_notes === "string") { updates.push("response_notes = ?"); values.push(body.response_notes); }
    if (typeof body.notes === "string") { updates.push("notes = ?"); values.push(body.notes); }

    if (typeof body.severity === "string") {
      updates.push("severity = ?");
      values.push(body.severity);
      updates.push("priority_score = ?");
      values.push(computePriorityScore(body.severity));
    }

    if (updates.length === 0) return error("No valid fields to update", 400, origin);

    updates.push("updated_at = datetime('now')");
    values.push(takedownId);

    await env.DB.prepare(
      `UPDATE takedown_requests SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...values).run();

    await audit(env, {
      action: "admin_takedown_update",
      userId: ctx.userId,
      resourceType: "takedown_request",
      resourceId: takedownId,
      details: { previous_status: takedown.status, new_status: body.status ?? takedown.status },
      outcome: "success",
      request,
    });

    if (typeof body.status === "string" && body.status !== takedown.status) {
      // takedown.org_id is loaded in the primary SELECT above and no UPDATE
      // here mutates org_id, so reuse it instead of a redundant re-query.
      if (takedown.org_id) {
        emitOrgEvent(env, takedown.org_id, "takedown.status_changed", {
          takedown_id: takedownId,
          previous_status: takedown.status,
          new_status: body.status,
          updated_by: ctx.userId,
        }).catch(() => {});
      }
    }

    return json({ success: true, message: "Takedown request updated" }, 200, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ─── POST /api/admin/takedowns/:id/submit  (TK2 — analyst hand-submit) ─
// Route gate: requirePermission("manage_takedowns") — analyst + admin +
// super_admin (see lib/role-permissions.ts). This is the single-takedown,
// human-triggered sibling of Sparrow Phase G's auto-submit
// (agents/sparrow.ts:runPhaseGAutoSubmit) — for the "auto is on but THIS one
// needs a human to push it" case. It dispatches a REAL external action, so it
// re-runs the SAME standing/consent gates Phase G enforces and NEVER bypasses
// them. The ONLY thing it drops is the automation decision: it does NOT
// require takedown_providers.auto_submit_enabled=1 and does NOT consult the
// auto/semi_auto automation policy — the staff user holding manage_takedowns
// IS that decision (that is the entire point of TK2).
//
// Standing gates enforced here (all fail-closed), mirroring Phase G + TK1
// (handleAdminUpdateTakedown's →submitted gate):
//   1. org_id NOT NULL      — takedown authorization is org-scoped, so an
//      orgless (SOC/prospect) draft has no signing party and no legal
//      standing; reject 422. Same treatment as Phase G (candidate query
//      filters `org_id IS NOT NULL`) and TK1 (422 on the →submitted flip).
//      This is NOT a bypass — it is the absence of a party that could have
//      authorized the action.
//   2. org owns the target brand (org_brands) — 403 (TK1 parity; strictly
//      more conservative than Phase G, which omits this check).
//   3. module_key present   — 422 (can't resolve authorization without it).
//   4. requireAuthorizationForModule — active signed authorization covering
//      the module; 403 otherwise. Canonical gate; subsumes isModuleAuthorized.
//   5. isUnderMonthlyTakedownCap     — signed monthly cap not spent; 409
//      otherwise. Phase G's consent boundary.
//
// Dispatch inherits TAKEDOWN_SEND_MODE via dispatchSubmission → pickSubmitter
// exactly like Phase G — no new send surface: whatever mode the platform runs
// in, this path behaves identically to Phase G's auto-submit. PROD RUNS
// TAKEDOWN_SEND_MODE='live' (wrangler.toml), so this endpoint sends REAL abuse
// reports; it does NOT ship dark. That is why the atomic single-dispatch claim
// below (guard against a concurrent double-send) is load-bearing, not cosmetic.
//
// Reads here use env.DB directly (NOT a read replica) so the cap COUNT and the
// row state are the live primary. NOTE: getActiveAuthorization /
// requireAuthorizationForModule are KV-cached (cachedValue, 120s) — a revoked
// authorization is caught because revokeAuthorization() calls invalidateCache()
// on the same key; do NOT remove that invalidation assuming this path always
// re-reads D1, because it does not. The monthly-cap COUNT is an uncached live
// read.
//
// NOTE (DRY): the standing-check + dispatch sequence is REPLICATED from Phase
// G rather than factored into a shared helper. Phase G's loop is entangled
// with batch-local cap accounting, per-row automation-policy evaluation,
// entitlement checks, and de-duped customer notifications that do not apply to
// a single human-triggered submit; extracting a shared helper would have
// destabilized that hot path for little gain. The gate order + semantics are
// kept identical on purpose.

interface SubmitTakedownRow {
  id:                     string;
  status:                 string;
  org_id:                 number | null;
  brand_id:               string;
  module_key:             string | null;
  target_type:            string;
  target_value:           string;
  target_url:             string | null;
  evidence_summary:       string;
  evidence_detail:        string | null;
  provider_name:          string | null;
  provider_abuse_contact: string | null;
  provider_method:        string | null;
  severity:               string;
}

// Only draft/requested takedowns can be hand-submitted. Every other state
// (submitted, pending_response, taken_down, failed, expired, withdrawn) is
// already-submitted or terminal → idempotent 409.
const SUBMITTABLE_SOURCE_STATUSES = ["draft", "requested"];

// Load a provider row in the exact ProviderRecord shape dispatchSubmission
// needs (same SELECT Sparrow Phase G uses), MINUS the auto_submit_enabled gate.
async function loadSubmitProviderRecord(
  env: Env, providerName: string,
): Promise<ProviderRecord | null> {
  return env.DB.prepare(
    `SELECT id, provider_name, provider_type, abuse_email, abuse_url,
            abuse_api_url, abuse_api_type, auto_submit_enabled
     FROM takedown_providers
     WHERE provider_name = ?
     LIMIT 1`,
  ).bind(providerName).first<ProviderRecord>();
}

export async function handleAdminSubmitTakedown(
  request: Request, env: Env, takedownId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // Fresh, non-replica read — consent boundary (see header note).
    const td = await env.DB.prepare(
      `SELECT id, status, org_id, brand_id, module_key,
              target_type, target_value, target_url,
              evidence_summary, evidence_detail,
              provider_name, provider_abuse_contact, provider_method, severity
       FROM takedown_requests WHERE id = ?`,
    ).bind(takedownId).first<SubmitTakedownRow>();

    if (!td) return error("Takedown request not found", 404, origin);

    // ── Idempotency guard 1: status must be a submittable source state. ──
    if (!SUBMITTABLE_SOURCE_STATUSES.includes(td.status)) {
      return error(
        `Takedown is '${td.status}' — only 'draft' or 'requested' takedowns can be submitted (this one is already submitted or in a terminal state).`,
        409, origin,
      );
    }

    // ── Idempotency guard 2: no prior successful/queued submission. ──
    // Belt-and-suspenders against a status flip that failed after the
    // submission row landed. 'failed'/'rejected' rows do NOT block a retry.
    const priorSubmission = await env.DB.prepare(
      `SELECT 1 FROM takedown_submissions
       WHERE takedown_id = ? AND outcome IN ('submitted', 'queued') LIMIT 1`,
    ).bind(takedownId).first();
    if (priorSubmission) {
      return error(
        "Takedown already has a submission on record — refusing to double-dispatch.",
        409, origin,
      );
    }

    // ── STANDING GATE 1: owning org (authorization is org-scoped). ──
    if (td.org_id === null || td.org_id === undefined) {
      return error(
        "Cannot submit an orgless (SOC/prospect) takedown — takedown authorization is org-scoped, so there is no signing party and no legal standing to dispatch. Assign an owning org first.",
        422, origin,
      );
    }
    const orgId = td.org_id;

    // ── STANDING GATE 2: org owns the target brand (TK1 parity). ──
    const ownsBrand = await env.DB.prepare(
      "SELECT 1 FROM org_brands WHERE org_id = ? AND brand_id = ?",
    ).bind(orgId, td.brand_id).first();
    if (!ownsBrand) {
      return error(
        "Owning org does not own the target brand — no legal standing to submit this takedown.",
        403, origin,
      );
    }

    // ── STANDING GATE 3: module_key present. ──
    if (!td.module_key) {
      return error(
        "Takedown has no module_key — cannot verify takedown authorization to submit.",
        422, origin,
      );
    }
    const moduleKey = td.module_key as ModuleKey;

    // ── STANDING GATE 4: active signed authorization covers the module. ──
    try {
      await requireAuthorizationForModule(env, orgId, moduleKey);
    } catch (authErr) {
      if (authErr instanceof TakedownNotAuthorizedError) {
        return error(
          `Org lacks an active takedown authorization covering module '${moduleKey}' — cannot submit.`,
          403, origin,
        );
      }
      throw authErr;
    }

    // ── STANDING GATE 5: signed monthly cap not spent (Phase G parity). ──
    // F2 (residual window, accepted): the cap is READ here, not RESERVED. The
    // atomic claim below single-dispatches THIS row, but it does not reserve a
    // cap slot, so N concurrent hand-submits of DIFFERENT takedowns for one org
    // can each pass this read and overrun the signed cap by up to N. Phase G
    // has the identical property (it reads the cap once per batch). A true
    // reservation would need an atomic org-scoped counter; deliberately not
    // built for this low-frequency, human-triggered path. The cap is a soft
    // ceiling under concurrency, hard otherwise.
    const cap = await isUnderMonthlyTakedownCap(env, orgId);
    if (!cap.under) {
      return error(
        `Signed monthly takedown cap reached (${cap.used}/${cap.cap}). Re-sign the authorization to raise the cap, or wait until next month.`,
        409, origin,
      );
    }

    // ── Resolve the provider row (abuse endpoint). We deliberately do NOT
    // gate on auto_submit_enabled — that is the automation gate the human
    // replaces. Prefer the takedown's resolved provider_name; fall back to
    // resolveProvider() when it's unset or not in the directory. ──
    const { dispatchSubmission } = await import("../lib/takedown-submitters");
    let providerName = td.provider_name;
    let provider = providerName ? await loadSubmitProviderRecord(env, providerName) : null;
    if (!provider) {
      const { resolveProvider } = await import("../lib/provider-resolver");
      const resolved = await resolveProvider(env, td.target_value);
      if (resolved.abuse_contact) {
        providerName = resolved.abuse_contact.provider_name;
        provider = await loadSubmitProviderRecord(env, providerName);
      }
    }
    if (!provider || !providerName) {
      return error(
        "No abuse provider could be resolved for this takedown's target — cannot dispatch.",
        422, origin,
      );
    }

    // ── ATOMIC SINGLE-DISPATCH CLAIM (F1) ──────────────────────────────
    // Claim the row BEFORE dispatching. D1 serializes writes, so this
    // conditional UPDATE is a genuine atomic compare-and-swap: exactly one of
    // N concurrent requests flips the row out of draft/requested and gets
    // meta.changes===1; every loser gets 0 and returns 409 WITHOUT dispatching.
    // This is what makes the live-mode send safe against an analyst double-click
    // or two SOC analysts on the same takedown — the idempotency reads above
    // (status + prior-submission) are stale by the time we act, so they are a
    // fast-path courtesy, not the real guard. We claim straight to 'submitted'
    // (at-most-once): if the dispatch then fails/rejects we flip the row to
    // 'failed' rather than back to draft, so an ambiguous provider error can't
    // trigger an automatic re-send of a report that may already have gone out.
    const claim = await env.DB.prepare(
      `UPDATE takedown_requests
       SET status = 'submitted',
           submitted_at = datetime('now'),
           submitted_by = ?,
           updated_at   = datetime('now')
       WHERE id = ? AND status IN ('draft', 'requested')`,
    ).bind(ctx.userId, takedownId).run();

    if (!claim.meta || claim.meta.changes !== 1) {
      // Another concurrent request won the claim, or the row left
      // draft/requested between our read and now. Do NOT dispatch.
      return error(
        "Takedown was already claimed for submission by a concurrent request — refusing to double-dispatch.",
        409, origin,
      );
    }

    // ── Dispatch — inherits TAKEDOWN_SEND_MODE (PROD = live → real send).
    // Records the takedown_submissions audit row internally. ──
    const { result, submission_id } = await dispatchSubmission(
      env,
      {
        id:                     td.id,
        org_id:                 orgId,
        brand_id:               td.brand_id,
        module_key:             moduleKey,
        target_type:            td.target_type,
        target_value:           td.target_value,
        target_url:             td.target_url,
        evidence_summary:       td.evidence_summary,
        evidence_detail:        td.evidence_detail,
        provider_name:          providerName,
        provider_abuse_contact: td.provider_abuse_contact,
        provider_method:        td.provider_method,
        severity:               td.severity,
      },
      provider,
    );

    if (result.outcome === "failed" || result.outcome === "rejected") {
      // We already claimed the row to 'submitted'; the send did not land, so
      // move it to a terminal 'failed' (NOT back to draft — at-most-once, see
      // claim note). The takedown_submissions row records the attempt + error;
      // an operator can inspect and re-open manually if the failure was
      // transient. Best-effort — never let a bookkeeping write mask the 502.
      await env.DB.prepare(
        `UPDATE takedown_requests
         SET status = 'failed',
             resolved_at = datetime('now'),
             response_notes = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(
        `Hand-submit dispatch ${result.outcome}: ${result.error_message ?? "provider did not accept the report"}`,
        takedownId,
      ).run().catch(() => {});
      await audit(env, {
        action: "admin_takedown_submit",
        userId: ctx.userId,
        resourceType: "takedown_request",
        resourceId: takedownId,
        details: {
          previous_status: td.status, new_status: "failed", outcome: result.outcome,
          submitter_kind: result.submitter_kind, provider: providerName,
          submission_id, error: result.error_message ?? null,
        },
        outcome: "failure",
        request,
      }).catch(() => {});
      return error(
        `Submission ${result.outcome}: ${result.error_message ?? "provider did not accept the report"}`,
        502, origin,
      );
    }

    // Success — 'submitted' (live send) or 'queued' (draft under a non-live
    // TAKEDOWN_SEND_MODE). Row is already 'submitted' from the claim above.
    // WHO triggered the external action — audit the staff user (best-effort:
    // a logging failure must NOT misreport a completed send as a 500).
    await audit(env, {
      action: "admin_takedown_submit",
      userId: ctx.userId,
      resourceType: "takedown_request",
      resourceId: takedownId,
      details: {
        previous_status: td.status, new_status: "submitted",
        outcome: result.outcome, submitter_kind: result.submitter_kind,
        provider: providerName, submission_id,
        send_mode: result.outcome === "submitted" ? "live" : "draft",
      },
      outcome: "success",
      request,
    }).catch(() => {});

    // Notify the org's data-out destinations (best-effort), like Phase G + PATCH.
    emitOrgEvent(env, orgId, "takedown.status_changed", {
      takedown_id: takedownId,
      previous_status: td.status,
      new_status: "submitted",
      updated_by: ctx.userId,
    }).catch(() => {});

    return success(
      {
        takedown_id:    takedownId,
        status:         "submitted",
        outcome:        result.outcome,
        submitter_kind: result.submitter_kind,
        submission_id,
        provider:       providerName,
      },
      origin,
    );
  } catch (err) {
    return error(String(err), 500, origin);
  }
}
