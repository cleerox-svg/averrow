// Wave 2.1 PR-AF — seed_domains admin endpoints.
//
// Operator surface for the seed-domain config introduced in
// migration 0181. The auto-seeder iterates `WHERE status='active'`
// rows on every tick, so adding a row here adds it to the next
// planting round.
//
// All endpoints are admin-gated via the route layer (routes/admin.ts).
//
//   GET    /api/admin/seed-domains         — list all rows
//   POST   /api/admin/seed-domains         — add a domain
//   PATCH  /api/admin/seed-domains/:domain — update status / pages / notes
//   DELETE /api/admin/seed-domains/:domain — hard delete (rare; prefer
//                                            status='retired' so the
//                                            historical seed_addresses
//                                            rows still resolve)
//
// See `docs/SEED_DOMAINS_RUNBOOK.md` for the operator workflow
// (register domain in CF → add row here → wait one auto-seeder tick).

import { handler, success, error } from "../lib/handler-utils";

interface SeedDomainRow {
  domain:         string;
  status:         string;
  added_at:       string;
  added_by:       string | null;
  notes:          string | null;
  pages:          string;
  seeds_per_page: number;
}

const VALID_STATUSES = new Set(["active", "paused", "retired"]);

const DOMAIN_REGEX = /^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

function validateDomain(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const trimmed = d.trim().toLowerCase();
  if (!DOMAIN_REGEX.test(trimmed)) return null;
  return trimmed;
}

// ── GET /api/admin/seed-domains ──────────────────────────────────

export const handleListSeedDomains = handler(async (_request, env, ctx) => {
  const rows = await env.DB.prepare(
    `SELECT domain, status, added_at, added_by, notes, pages, seeds_per_page
     FROM seed_domains
     ORDER BY status = 'active' DESC, domain ASC`,
  ).all<SeedDomainRow>();
  return success({ domains: rows.results ?? [] }, ctx.origin);
});

// ── POST /api/admin/seed-domains ─────────────────────────────────

interface AddSeedDomainBody {
  domain?:         string;
  pages?:          string;
  seeds_per_page?: number;
  notes?:          string;
}

export const handleAddSeedDomain = handler(async (request, env, ctx) => {
  let body: AddSeedDomainBody;
  try {
    body = (await request.json()) as AddSeedDomainBody;
  } catch {
    return error("Invalid JSON body", 400, ctx.origin);
  }

  const domain = validateDomain(body.domain);
  if (!domain) return error("domain required and must look like 'example.com'", 400, ctx.origin);

  const pages = typeof body.pages === "string" && body.pages.trim()
    ? body.pages.trim()
    : "/admin-portal,/internal-staff,/team-directory,/staff-contacts";

  const spp = typeof body.seeds_per_page === "number" && body.seeds_per_page > 0 && body.seeds_per_page <= 100
    ? body.seeds_per_page
    : 6;

  const notes = typeof body.notes === "string" ? body.notes.slice(0, 500) : null;

  const result = await env.DB.prepare(
    `INSERT INTO seed_domains (domain, status, added_by, notes, pages, seeds_per_page)
     VALUES (?, 'active', 'admin_api', ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE
       SET status = 'active',
           pages = excluded.pages,
           seeds_per_page = excluded.seeds_per_page,
           notes = excluded.notes`,
  ).bind(domain, notes, pages, spp).run();

  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  return success({ domain, changes, pages, seeds_per_page: spp }, ctx.origin);
});

// ── PATCH /api/admin/seed-domains/:domain ────────────────────────

interface PatchSeedDomainBody {
  status?:         string;
  pages?:          string;
  seeds_per_page?: number;
  notes?:          string;
}

export const handlePatchSeedDomain = handler(
  async (request: Request & { params?: Record<string, string> }, env, ctx) => {
    const domain = validateDomain(request.params?.domain ?? "");
    if (!domain) return error("Invalid domain in path", 400, ctx.origin);

    let body: PatchSeedDomainBody;
    try {
      body = (await request.json()) as PatchSeedDomainBody;
    } catch {
      return error("Invalid JSON body", 400, ctx.origin);
    }

    const sets: string[] = [];
    const binds: unknown[] = [];

    if (body.status !== undefined) {
      if (!VALID_STATUSES.has(body.status)) {
        return error(`status must be one of: ${Array.from(VALID_STATUSES).join(", ")}`, 400, ctx.origin);
      }
      sets.push("status = ?"); binds.push(body.status);
    }
    if (body.pages !== undefined) {
      if (typeof body.pages !== "string" || !body.pages.trim()) {
        return error("pages must be a non-empty comma-separated string", 400, ctx.origin);
      }
      sets.push("pages = ?"); binds.push(body.pages.trim());
    }
    if (body.seeds_per_page !== undefined) {
      if (typeof body.seeds_per_page !== "number" || body.seeds_per_page <= 0 || body.seeds_per_page > 100) {
        return error("seeds_per_page must be 1-100", 400, ctx.origin);
      }
      sets.push("seeds_per_page = ?"); binds.push(body.seeds_per_page);
    }
    if (body.notes !== undefined) {
      sets.push("notes = ?"); binds.push(typeof body.notes === "string" ? body.notes.slice(0, 500) : null);
    }

    if (sets.length === 0) return error("nothing to update", 400, ctx.origin);

    binds.push(domain);
    const result = await env.DB.prepare(
      `UPDATE seed_domains SET ${sets.join(", ")} WHERE domain = ?`,
    ).bind(...binds).run();

    const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
    if (changes === 0) return error("domain not found", 404, ctx.origin);
    return success({ domain, changes }, ctx.origin);
  },
);

// ── DELETE /api/admin/seed-domains/:domain ───────────────────────

export const handleDeleteSeedDomain = handler(
  async (request: Request & { params?: Record<string, string> }, env, ctx) => {
    const domain = validateDomain(request.params?.domain ?? "");
    if (!domain) return error("Invalid domain in path", 400, ctx.origin);

    const result = await env.DB.prepare(
      `DELETE FROM seed_domains WHERE domain = ?`,
    ).bind(domain).run();
    const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
    if (changes === 0) return error("domain not found", 404, ctx.origin);
    return success({ domain, deleted: true }, ctx.origin);
  },
);
