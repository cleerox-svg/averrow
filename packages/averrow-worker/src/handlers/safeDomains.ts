// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Brand Safe Domains (Known/Owned Domain Allowlist)

import { json } from "../lib/cors";
import type { Env } from "../types";

/** Clean a domain string: strip protocol, path, www., trailing dots, lowercase, trim.
 *  Preserves wildcard prefix (*.) for wildcard entries. */
function cleanDomain(raw: string): string {
  let d = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^ftp:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
    .trim();
  // Don't strip www. from wildcards
  if (!d.startsWith("*.")) {
    d = d.replace(/^www\./, "");
  }
  return d;
}

/** Validate that a cleaned string looks like a valid domain (supports wildcard prefix *.) */
function isValidDomain(d: string): boolean {
  if (!d || d.length < 3) return false;
  if (!d.includes(".")) return false;
  if (/\s/.test(d)) return false;
  // Allow wildcard prefix
  const toCheck = d.startsWith("*.") ? d.slice(2) : d;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(toCheck);
}

// GET /api/brands/:id/safe-domains
export async function handleListSafeDomains(
  request: Request,
  env: Env,
  brandId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(
      `SELECT id, domain, source, added_at, notes
       FROM brand_safe_domains WHERE brand_id = ?
       ORDER BY added_at DESC`,
    )
      .bind(brandId)
      .all();
    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/brands/:id/safe-domains
export async function handleAddSafeDomain(
  request: Request,
  env: Env,
  brandId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = (await request.json().catch(() => null)) as {
      domain?: string;
      notes?: string;
    } | null;
    if (!body?.domain) return json({ success: false, error: "domain required" }, 400, origin);

    const domain = cleanDomain(body.domain);
    if (!isValidDomain(domain)) {
      return json({ success: false, error: "Invalid domain format" }, 400, origin);
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source, notes)
       VALUES (?, ?, ?, ?, 'manual', ?)`,
    )
      .bind(id, brandId, domain, userId, body.notes ?? null)
      .run();

    return json({ success: true, data: { id, domain, source: "manual" } }, 201, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/brands/:id/safe-domains/bulk
export async function handleBulkAddSafeDomains(
  request: Request,
  env: Env,
  brandId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = (await request.json().catch(() => null)) as {
      domains?: string[];
    } | null;
    if (!body?.domains || !Array.isArray(body.domains)) {
      return json({ success: false, error: "domains array required" }, 400, origin);
    }

    let added = 0;
    let skippedDuplicates = 0;
    let skippedInvalid = 0;

    for (const raw of body.domains) {
      const domain = cleanDomain(String(raw));
      if (!isValidDomain(domain)) {
        skippedInvalid++;
        continue;
      }

      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
         VALUES (?, ?, ?, ?, 'csv_upload')`,
      )
        .bind(crypto.randomUUID(), brandId, domain, userId)
        .run();

      if (result.meta?.changes && result.meta.changes > 0) {
        added++;
      } else {
        skippedDuplicates++;
      }
    }

    return json(
      { success: true, data: { added, skipped_duplicates: skippedDuplicates, skipped_invalid: skippedInvalid } },
      201,
      origin,
    );
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// DELETE /api/brands/:id/safe-domains/:domainId
export async function handleDeleteSafeDomain(
  request: Request,
  env: Env,
  brandId: string,
  domainId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    await env.DB.prepare(
      "DELETE FROM brand_safe_domains WHERE id = ? AND brand_id = ?",
    )
      .bind(domainId, brandId)
      .run();
    return json({ success: true, data: { deleted: true } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
