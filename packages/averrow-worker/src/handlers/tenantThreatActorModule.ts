// Averrow — Threat-Actor Intelligence tenant module surface
//
// Tenant-filtered view of threat_actors + threat_attributions:
// "actors targeting your brands" with attack count, country,
// capability, and per-brand drill-down.
//
//   GET /api/orgs/:orgId/modules/threat-actor
//     Per-actor summary scoped to the org's brands. Lists every
//     actor with at least one threat_attributions row OR
//     threat_actor_targets row hitting an org_brands brand.
//
//   GET /api/orgs/:orgId/modules/threat-actor/actors/:actorId
//     Per-actor drill-down: full profile + the org's brands
//     this actor has targeted + the org's threats attributed
//     to this actor + actor's known infrastructure.
//
// Phase B sprint 8 (last per-module surface).

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import { requireModule, ModuleNotEntitledError } from "../lib/entitlements";

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

interface ActorSummaryRow {
  actor_id:                string;
  name:                    string;
  aliases:                 string | null;
  affiliation:             string | null;
  country_code:            string | null;
  capability:              string | null;
  status:                  string;
  attribution_confidence:  string;
  threat_count_for_org:    number;
  brands_targeted_for_org: number;
  last_seen_for_org:       string | null;
}

// ─── GET /api/orgs/:orgId/modules/threat-actor ──────────────────

export async function handleGetThreatActorModuleSummary(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "threat_actor");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Threat-Actor Intelligence isn't enabled for your organization. Contact support@averrow.com.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  // Two paths to "this actor cares about your brands":
  //  1. threat_actor_targets row binds the actor to one of your brands
  //  2. threat_attributions row points at a threat that hits one of your brands
  //
  // Union the actor IDs via a UNION subquery, then aggregate the per-org
  // attribution counts.
  const result = await env.DB.prepare(
    `WITH org_actors AS (
       SELECT DISTINCT tat.threat_actor_id AS actor_id
       FROM threat_actor_targets tat
       JOIN org_brands ob ON ob.brand_id = tat.brand_id
       WHERE ob.org_id = ?
       UNION
       SELECT DISTINCT attr.actor_id
       FROM threat_attributions attr
       JOIN threats t        ON t.id = attr.threat_id
       JOIN org_brands ob    ON ob.brand_id = t.target_brand_id
       WHERE ob.org_id = ? AND attr.actor_id IS NOT NULL
     )
     SELECT
       ta.id   AS actor_id,
       ta.name,
       ta.aliases,
       ta.affiliation,
       ta.country_code,
       ta.capability,
       ta.status,
       ta.attribution_confidence,
       (SELECT COUNT(*)
          FROM threat_attributions attr
          JOIN threats t      ON t.id = attr.threat_id
          JOIN org_brands ob2 ON ob2.brand_id = t.target_brand_id
         WHERE attr.actor_id = ta.id AND ob2.org_id = ?) AS threat_count_for_org,
       (SELECT COUNT(DISTINCT tat2.brand_id)
          FROM threat_actor_targets tat2
          JOIN org_brands ob3 ON ob3.brand_id = tat2.brand_id
         WHERE tat2.threat_actor_id = ta.id AND ob3.org_id = ?) AS brands_targeted_for_org,
       (SELECT MAX(t2.last_seen)
          FROM threat_attributions attr2
          JOIN threats t2    ON t2.id = attr2.threat_id
          JOIN org_brands ob4 ON ob4.brand_id = t2.target_brand_id
         WHERE attr2.actor_id = ta.id AND ob4.org_id = ?) AS last_seen_for_org
     FROM org_actors oa
     JOIN threat_actors ta ON ta.id = oa.actor_id
     ORDER BY threat_count_for_org DESC, ta.name ASC`,
  ).bind(
    orgIdNum, orgIdNum, orgIdNum, orgIdNum, orgIdNum,
  ).all<ActorSummaryRow>();

  const actors = result.results ?? [];

  const totals = {
    actor_count:    actors.length,
    threat_count:   actors.reduce((acc, a) => acc + a.threat_count_for_org, 0),
    countries_count: new Set(actors.map((a) => a.country_code).filter(Boolean)).size,
    high_confidence_actors: actors.filter((a) =>
      a.attribution_confidence === "confirmed" || a.attribution_confidence === "high",
    ).length,
  };

  return json({
    success: true,
    data: {
      org_id: orgIdNum,
      actors,
      totals,
    },
  }, 200, origin);
}

// ─── GET /api/orgs/:orgId/modules/threat-actor/actors/:actorId ──

export interface ThreatActorProfile {
  id:                     string;
  name:                   string;
  aliases:                string | null;
  affiliation:            string | null;
  country_code:           string | null;
  capability:             string | null;
  primary_ttps:           string | null;
  description:            string | null;
  first_seen:             string | null;
  last_seen:              string | null;
  status:                 string;
  attribution_confidence: string;
}

export interface OrgThreatRow {
  id:               string;
  threat_type:      string;
  malicious_url:    string | null;
  malicious_domain: string | null;
  target_brand_id:  string | null;
  brand_name:       string | null;
  country_code:     string | null;
  severity:         string | null;
  status:           string;
  first_seen:       string;
  last_seen:        string;
  attribution_confidence: string;
  attribution_source:     string;
  observed_at:      string;
}

export interface ActorInfrastructureRow {
  id:               string;
  asn:              string | null;
  ip_range:         string | null;
  domain:           string | null;
  hosting_provider: string | null;
  country_code:     string | null;
  confidence:       string;
  first_observed:   string;
  last_observed:    string;
}

export interface OrgTargetedBrand {
  brand_id:         string;
  brand_name:       string;
  canonical_domain: string | null;
  first_targeted:   string;
  last_targeted:    string;
}

export async function handleGetThreatActorDetail(
  request: Request,
  env:     Env,
  orgId:   string,
  actorId: string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "threat_actor");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Threat-Actor Intelligence isn't enabled for your organization.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  const actor = await env.DB.prepare(
    `SELECT id, name, aliases, affiliation, country_code, capability,
            primary_ttps, description, first_seen, last_seen,
            status, attribution_confidence
     FROM threat_actors
     WHERE id = ?`,
  ).bind(actorId).first<ThreatActorProfile>();

  if (!actor) {
    return json({ success: false, error: "Threat actor not found" }, 404, origin);
  }

  const THREATS_LIMIT = 100;

  const [threats, infrastructure, targetedBrands] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.threat_type, t.malicious_url, t.malicious_domain,
              t.target_brand_id, b.name AS brand_name, t.country_code,
              t.severity, t.status, t.first_seen, t.last_seen,
              attr.confidence AS attribution_confidence,
              attr.source     AS attribution_source,
              attr.observed_at
       FROM threat_attributions attr
       JOIN threats t      ON t.id = attr.threat_id
       JOIN org_brands ob  ON ob.brand_id = t.target_brand_id
       LEFT JOIN brands b  ON b.id = t.target_brand_id
       WHERE attr.actor_id = ? AND ob.org_id = ?
       ORDER BY attr.observed_at DESC
       LIMIT ?`,
    ).bind(actorId, orgIdNum, THREATS_LIMIT).all<OrgThreatRow>(),

    env.DB.prepare(
      `SELECT id, asn, ip_range, domain, hosting_provider, country_code,
              confidence, first_observed, last_observed
       FROM threat_actor_infrastructure
       WHERE threat_actor_id = ?
       ORDER BY last_observed DESC
       LIMIT 100`,
    ).bind(actorId).all<ActorInfrastructureRow>(),

    env.DB.prepare(
      `SELECT b.id AS brand_id, b.name AS brand_name, b.canonical_domain,
              tat.first_targeted, tat.last_targeted
       FROM threat_actor_targets tat
       JOIN brands b      ON b.id  = tat.brand_id
       JOIN org_brands ob ON ob.brand_id = tat.brand_id
       WHERE tat.threat_actor_id = ? AND ob.org_id = ?
       ORDER BY tat.last_targeted DESC`,
    ).bind(actorId, orgIdNum).all<OrgTargetedBrand>(),
  ]);

  return json({
    success: true,
    data: {
      actor,
      org_id:           orgIdNum,
      targeted_brands:  targetedBrands.results,
      threats:          threats.results,
      infrastructure:   infrastructure.results,
      page_size:        THREATS_LIMIT,
    },
  }, 200, origin);
}
