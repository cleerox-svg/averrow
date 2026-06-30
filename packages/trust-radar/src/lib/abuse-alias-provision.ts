/**
 * Per-tenant abuse-alias provisioning (Tier 3, the "cheap branded" option).
 *
 * Mints `verify-<slug>@averrow.com` for an org into org_abuse_aliases.
 * Inbound routing already dispatches `verify-*` local-parts to the
 * abuse-mailbox handler (see src/index.ts), so a freshly minted alias is
 * live the moment the row exists — no DNS/MX change. The alias maps back
 * to the org, so its inbound submissions get that org's branded responder.
 *
 * The envelope sender for replies stays on Averrow's authenticated domain;
 * this only gives the customer a per-tenant INBOUND address to publish.
 */

import type { Env } from "../types";

/** Domain all platform abuse aliases live on (authenticated for mail). */
export const ABUSE_ALIAS_DOMAIN = "averrow.com";

/**
 * Reduce an org slug/name to a safe email local-part segment:
 * lowercase, [a-z0-9-] only, collapsed hyphens, trimmed, length-capped.
 * Returns null when nothing usable survives.
 */
export function aliasSlug(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || null;
}

export interface ProvisionResult {
  ok: boolean;
  alias?: string;
  created?: boolean;
  reason?: string;
}

/**
 * Provision (idempotently) the `verify-<slug>@averrow.com` alias for an org.
 * `slug` defaults to the org's stored slug, falling back to its name, then
 * to `org<id>`. Existing rows are left untouched (ON CONFLICT DO NOTHING) so
 * re-running is safe and never steals an alias from another org.
 */
export async function provisionAbuseAlias(
  env: Env,
  orgId: number,
  slugHint?: string | null,
): Promise<ProvisionResult> {
  let slug = aliasSlug(slugHint);
  if (!slug) {
    try {
      const org = await env.DB.prepare(
        "SELECT slug, name FROM organizations WHERE id = ?",
      ).bind(orgId).first<{ slug: string | null; name: string | null }>();
      if (!org) return { ok: false, reason: "org-not-found" };
      slug = aliasSlug(org.slug) ?? aliasSlug(org.name) ?? `org${orgId}`;
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const alias = `verify-${slug}@${ABUSE_ALIAS_DOMAIN}`;

  // If this alias already exists for a DIFFERENT org, don't hijack it —
  // report the collision so the operator can pick another slug.
  try {
    const existing = await env.DB.prepare(
      "SELECT org_id FROM org_abuse_aliases WHERE LOWER(alias) = ?",
    ).bind(alias.toLowerCase()).first<{ org_id: number }>();
    if (existing && existing.org_id !== orgId) {
      return { ok: false, alias, reason: "alias-taken-by-other-org" };
    }

    const res = await env.DB.prepare(
      `INSERT INTO org_abuse_aliases (alias, org_id, forwarding_instructions)
       VALUES (?, ?, ?)
       ON CONFLICT(alias) DO NOTHING`,
    ).bind(
      alias,
      orgId,
      `Publish ${alias} as your report-fraud / abuse address, or forward your existing abuse@ mailbox to it. Submissions are auto-triaged and the reporter gets a branded determination email.`,
    ).run();

    const created = (res.meta?.changes ?? 0) > 0;
    return { ok: true, alias, created };
  } catch (err) {
    return { ok: false, alias, reason: err instanceof Error ? err.message : String(err) };
  }
}
