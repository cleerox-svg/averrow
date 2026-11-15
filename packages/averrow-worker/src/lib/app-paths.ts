// Where the two React SPAs are mounted. One source of truth for every
// server-generated link, redirect and allowlist that points into the staff app.
//
// The staff back office (packages/averrow-ops) lives at /ops/. It was /v2/ until
// 2026-11-15, when it moved as a hard cut: /v2 and /v2/* now return 404 (no
// redirect, no service-worker stub). The customer app stays at /tenant/.
//
// Static files that cannot import this constant (the ops sw.js / manifest.json /
// index.html, vite.config's `base`, public/_headers) hard-code the same literal;
// pinned by test/ops-base-path.test.ts and the ops basePath test.

/** Mount path of the staff SPA, no trailing slash. */
export const OPS_BASE = "/ops";
/** Mount path of the customer SPA, no trailing slash. */
export const TENANT_BASE = "/tenant";

/** The staff app's shell URL (trailing slash) — the default landing for staff. */
export const OPS_HOME = `${OPS_BASE}/`;
export const TENANT_HOME = `${TENANT_BASE}/`;

/** The retired staff mount. Requests under it get a plain 404. */
export const RETIRED_OPS_BASE = "/v2";

/** Absolute URL of an in-app path (SPA-relative, e.g. "/admin/users"). */
export function opsUrl(origin: string, appPath = "/"): string {
  const p = appPath.startsWith("/") ? appPath : `/${appPath}`;
  return `${origin.replace(/\/$/, "")}${OPS_BASE}${p}`;
}
