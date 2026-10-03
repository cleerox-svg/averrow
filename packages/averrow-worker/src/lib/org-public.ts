// Averrow — public projection of `organizations` rows.
//
// The `organizations` table carries credentials next to ordinary
// metadata:
//   - webhook_secret  — HMAC signing key for the customer's outbound
//                       webhooks (lib/webhooks.ts signPayload). Anyone
//                       holding it can forge signed payloads to the
//                       customer's endpoint.
//   - webhook_url     — Slack/Teams/etc. incoming-webhook URLs embed
//                       their own bearer credential in the path.
//   - sso_config_json — IdP config (OIDC client secrets, SAML certs).
//   - invite_code     — org join code.
//   - stripe_customer_id / stripe_subscription_id — billing identifiers.
//
// Every handler that hands an org row to a client MUST go through
// `toPublicOrg()` and SELECT with `ORG_PUBLIC_SELECT_SQL` /
// `orgPublicSelectSql(alias)`. `toPublicOrg` is an ALLOWLIST: a column
// added to `organizations` later is dropped by default and never leaks
// until someone deliberately adds it to ORG_PUBLIC_FIELDS.
//
// The only response that may ever carry `webhook_secret` is the
// write-once flow in handlers/organizations.ts (first-set in
// handleUpdateWebhook, handleRegenerateSecret), which returns the newly
// minted secret to an org admin/owner exactly once. The only response
// that may carry the full `webhook_url` is the org-admin-gated
// handleGetWebhookConfig, which the customer uses to edit it.

/** Columns safe to return to any role that can read customer data. */
export const ORG_PUBLIC_FIELDS = [
  "id",
  "name",
  "slug",
  "plan",
  "plan_id",
  "status",
  "billing_status",
  "trial_ends_at",
  "max_brands",
  "max_members",
  "sso_provider",
  "created_at",
  "updated_at",
] as const;

/**
 * Columns that must never reach a client through a read response.
 * `toPublicOrg` refuses to copy these even if a caller passes one as an
 * extra key.
 */
export const ORG_SECRET_FIELDS: ReadonlySet<string> = new Set([
  "webhook_secret",
  "webhook_url",
  "sso_config_json",
  "invite_code",
  "stripe_customer_id",
  "stripe_subscription_id",
]);

/**
 * SELECT list for org reads that feed `toPublicOrg`: the public fields
 * plus `webhook_url`, which `toPublicOrg` reduces to `has_webhook` +
 * `webhook_url_redacted`. Built from compile-time constants only — no
 * caller input is ever interpolated.
 */
export function orgPublicSelectSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return [...ORG_PUBLIC_FIELDS, "webhook_url"].map((c) => `${prefix}${c}`).join(", ");
}

export const ORG_PUBLIC_SELECT_SQL = orgPublicSelectSql();

/**
 * Reduce a webhook URL to scheme + registrable domain so it identifies
 * the target service (slack.com, office.com, …) without disclosing the
 * credential-bearing path, query, userinfo — or subdomain, which some
 * providers use for a per-tenant token (e.g. <token>.m.pipedream.net).
 * IP-literal hosts are kept as-is (no subdomain to hide).
 *
 * null/undefined/"" → null. Unparseable → "[redacted]".
 */
export function redactWebhookUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${redactHost(u.hostname)}/…`;
  } catch {
    return "[redacted]";
  }
}

function redactHost(hostname: string): string {
  if (hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname;
  const labels = hostname.split(".");
  // Keep the last two labels, or three for a two-letter ccTLD with a short
  // second level (co.uk, com.au) so the result still names the service.
  const last = labels[labels.length - 1] ?? "";
  const second = labels[labels.length - 2] ?? "";
  const keep = last.length === 2 && second.length <= 3 && labels.length > 2 ? 3 : 2;
  if (labels.length <= keep) return hostname;
  return `…${labels.slice(-keep).join(".")}`;
}

/**
 * Project an organizations row (possibly joined with extra computed
 * columns) to its client-safe shape.
 *
 * @param extraKeys non-org columns the caller computed (e.g.
 *   member_count). Any key in ORG_SECRET_FIELDS is ignored.
 */
export function toPublicOrg(
  row: Record<string, unknown>,
  extraKeys: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ORG_PUBLIC_FIELDS) {
    if (key in row) out[key] = row[key];
  }
  for (const key of extraKeys) {
    if (ORG_SECRET_FIELDS.has(key)) continue;
    if (key in row) out[key] = row[key];
  }
  const webhookUrl = typeof row.webhook_url === "string" ? row.webhook_url : null;
  out.has_webhook = !!webhookUrl;
  out.webhook_url_redacted = redactWebhookUrl(webhookUrl);
  return out;
}
