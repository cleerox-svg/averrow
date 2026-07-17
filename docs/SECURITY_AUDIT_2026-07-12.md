# Platform Security Audit — 2026-07-12

> **Supersedes `docs/archive/SECURITY_AUDIT_2026-06-10.md`.** That audit is archived as a point-in-time record. This one re-verifies every non-imprsn8 finding against the current code on `claude/platform-sub-agents-ozh9kd` (HEAD `8e3d03c`).
>
> **imprsn8 is out of scope — decommissioned 2026-07-12.** The `packages/imprsn8` package, its Worker, and its Cloudflare resources were removed; a tree-wide grep for `imprsn8` across `.ts`/`.toml`/`.json` returns zero hits. Prior findings **C1, C3, C4, H7, M5, M6** were all imprsn8-scoped and are moot by removal — not carried forward.

In-scope packages: `packages/trust-radar` (backend Worker), `packages/averrow-ops` + `packages/averrow-tenant` (SPAs), `packages/averrow-mcp` (MCP server), `packages/averrow-marketing` (Astro site), `packages/shared`. Read-only audit — no source was modified.

## TL;DR — current posture

The platform hardened substantially since 2026-06-10. **Every High and every non-imprsn8 Critical from the prior audit is now FIXED in code (not just annotated)**, and the fix was verified at each cited site rather than trusting the back-cite comments. The cross-tenant data paths (H1/H2), the public stored-XSS (C2), OAuth login-CSRF (H3), disk-persisted auth data (H6), and `localStorage` token theft (H5) are all closed. All `/api/internal/*` endpoints are uniformly gated by a timing-safe internal-secret check. CORS is now a real allowlist and the `_headers` / `middleware/security.ts` CSP are reconciled and identical.

**All findings from this audit have since been remediated (2026-07-13) — see the per-finding status flags below.** The two with real blast radius:
- **The MCP service account no longer mints `super_admin`** — re-scoped to a read-only `auditor` JWT, TTL 90d→30d, `/mcp` rate-limited (O1, PR #1612).
- **`staging`/`dev` are no longer bound to the production D1 database** — dedicated isolated databases created + wired; verified no live cutover is needed because no staging/dev Worker is deployed and CI is prod-only (O2, PR #1613).
The remaining low-severity items (dev-tooling dep CVEs, an unreachable Astro advisory, dynamic-regex bounding, a `requireRole` guard, the MCP KV binding) were closed out in a follow-up batch (O3–O7). Residual accepted items: 6 `pnpm audit` highs inside the unreachable Astro 4.x tree, and CSP `unsafe-inline` (deferred to a future nonce-based policy).

---

## 1. Reconciliation of every prior non-imprsn8 finding

| Prior | Finding (short) | Status | Evidence (current) |
|---|---|---|---|
| **C2** | Stored XSS in public scan-result page | **FIXED** | `packages/averrow-worker/src/templates/scan-result.ts:25` `escapeHtml` helper, applied at every user/AI/DB interpolation: title/meta `:121-122`, url/meta `:287-288`, domain `:298`, AI insight `:305-310`, signal value/detail `:321-322`, flag severity/detail `:332-333`. Static labels (`s.label`) are hardcoded, not attacker input. |
| **H1** | Staff `/v2` routes accept `client` tokens | **FIXED** | `routes/brands.ts` now 60× `requireStaff` / 3× `requireAdmin`, zero `requireAuth`; `routes/threats.ts` all `requireStaff`/`requireAdmin`; `routes/scan.ts` all `requireStaff`; `routes/dashboard.ts:54` (`/providers`), `:42/:48` (`overview`/`top-brands`) → `requireStaff`. Residual `requireAuth` in `dashboard.ts:137-242` is only the per-user notifications surface (each threads `ctx.userId`) — correct. |
| **H2** | IDOR on `/api/alerts/:id` GET+PATCH | **FIXED** | `handlers/alerts.ts:162-187` (`handleGetAlert`) and `:189-217` (`handleUpdateAlert`) both call `buildAlertOwnershipWhere(userId, scope)` (`:145-160`) enforcing `a.user_id = ?` + org `brand_ids`. Routes gate `requireStaff` + thread scope (`routes/dashboard.ts:106-117`). |
| **H3** | OAuth `state` not bound to browser | **FIXED** | `handlers/auth.ts:35-39,76-78` set HttpOnly `radar_oauth_state` = `sha256(nonce)` at init; `:100-110` callback rejects unless cookie matches `sha256(state)`; cookie def `:674-688` (`SameSite=Lax` — correctly justified for the cross-site OAuth top-level nav; `Secure` on https). Mismatch is audited (`:108`). |
| **H4** | Unauthenticated public AI = spend amplification | **FIXED** | `handlers/public.ts:328-343` global daily ceiling (`PUBLIC_ASSESS_DAILY_CAP`, KV day-keyed counter) that serves the most-recent cached assessment past cap and 429s otherwise. *Residual (see L1):* per-IP limiter still fails open on KV error, but the global cap is now the hard ceiling on spend. |
| **H5** | JWT access+refresh in `localStorage` | **FIXED** | `averrow-ops/src/lib/api.ts:8-16,32-35,127-151` — access token in memory, refresh via HttpOnly `radar_refresh` cookie, legacy `localStorage` keys purged. `averrow-tenant/src/lib/api.ts:5-27,38-62` — identical model. |
| **H6** | Service worker caches authed API responses | **FIXED** | `averrow-ops/public/sw.js:100-101` `/api/*` is network-only (never Cache Storage); `:70-80` activate deletes ALL API caches; `:122-129` `CLEAR_API_CACHE` message on logout clears legacy caches. |
| **M1** | SSRF via org `webhook_url` | **FIXED** | New `lib/url-guard.ts` `validateOutboundWebhookUrl` (https-only + reject private/loopback/link-local/CGNAT/ULA, `:35-82`), called at **set** time (`handlers/organizations.ts:334`, `:1042`) and delivery uses `redirect:"manual"` (`lib/webhooks.ts:120,214`). |
| **M2** | `POST /brands/:id/deep-scan` client-reachable | **FIXED** | `routes/brands.ts:176-177` now `requireStaff`. |
| **M3** | MCP bearer not timing-safe; no `/mcp` rate limit; token → broad service JWT | **PARTIAL** | Timing-safe compare **done** (`averrow-mcp/src/index.ts:59-65`, used `:878`; central mint gate `trust-radar/src/index.ts:666`). **Still open:** no rate limit on `/mcp`, and `handleMintServiceJwt` mints a **90-day `super_admin` JWT** (`handlers/auth.ts` service-account block) — the opposite of the recommended read-only scope. Carried to open findings as **O1**. |
| **M4** | Sub-role guards defined but unused | **STALE / addressed** | `requireSales` now wired onto the `/api/admin/sales-leads/*` lifecycle (`routes/admin.ts:649-684`). `requireSupport`/`requireBilling` remain intentionally unwired per `CLAUDE.md §7` (support covered by `read_customers` + `requireStaff` alerts; billing by `view_billing`/`edit_pricing`). No action. |
| **L1** | Auth rate limiter fails open, per-IP only | **FIXED (auth bucket)** | `middleware/rateLimit.ts:83-91` — the `auth` bucket now fails **closed**; other buckets stay fail-open by design. |
| **L2** | Spoofable `X-Forwarded-For` identity | **FIXED** | `middleware/rateLimit.ts:35-37` and `handlers/auth.ts:609-610,780-781` use `CF-Connecting-IP` only. |
| **L3** | MCP CORS reflects arbitrary Origin | **FIXED** | `averrow-mcp/src/index.ts:919-922` — `corsHeaders()` emits no `Access-Control-Allow-Origin` at all. |
| **L4** | Handlers echo raw `Origin \|\| "*"` | **FIXED** | `routes/threats.ts:82,102` and `handlers/tenantTrademarkModule.ts:197` route through central `corsHeaders(origin, env)` (`lib/cors.ts`). |
| **L5** | Abuse-unsubscribe HMAC falls back to internal secret | **FIXED** | `handlers/abuseMailboxUnsubscribe.ts:21-31` uses dedicated `ABUSE_UNSUBSCRIBE_SECRET`, fails closed when unset (CI wiring: `.github/workflows/set-abuse-unsubscribe-secret.yml`). |
| **L6** | `domain-checker` http fallback lacks `redirect:'manual'` | **FIXED** | `lib/domain-checker.ts:81,91` both probe branches set `redirect:'manual'` (comment `:26`). |
| **L7** | Dynamic `new RegExp` from catalogs (ReDoS if self-serve) | **OPEN (accepted)** | `lib/named-threat-matcher.ts:74` still `new RegExp(src,"i")` with no length/complexity cap. Catalogs remain operator-curated → not attacker-reachable today. Carried as **O5** (accepted-low, gate before any self-serve catalog). |
| **L8** | `requireRole(...)` uses `Math.min` of levels | **OPEN (nit)** | `middleware/auth.ts:159-173` unchanged; still correct for all current call sites (`:179,186,205`), no footgun-guard comment added. Carried as **O6**. |

**Prior "what's done well" claims — re-verified and still true:** hardened HS256 JWT verification, timing-safe internal-secret on every `/api/internal/*` (confirmed: blanket GET gate `index.ts:585-590` + per-POST checks), token-at-rest hashing, WebAuthn, prepared statements throughout, open-redirect defense, clean secret hygiene, Stripe webhook verification, no `dangerouslySetInnerHTML` in the SPAs. All hold.

---

## 2. Currently-open findings (severity-ordered)

> **Remediation status (2026-07-13):** **All findings addressed.** O1 FIXED (PR #1612), O2 FIXED (PR #1613). O3–O7 closed out in a follow-up batch: **O4** all 3 critical + most high dep advisories cleared (0 crit / 6 high residual, all in Astro's tree); **O3** Astro bumped to latest safe 4.x with the residual advisory verified not-reachable (SSG, no server islands) so the breaking major was not forced; **O5** dynamic regex compilation now length/complexity-capped via `lib/safe-regex.ts`; **O6** `requireRole` mixed-tier footgun now warns; **O7** MCP KV namespace created + wired (CSP `unsafe-inline` and the legacy queue binding left as documented accept/defer). See each finding for detail.

### O1 — MCP service account mints a 90-day `super_admin` JWT; `/mcp` unthrottled *(High)* — **FIXED (PR #1612)**
- `packages/averrow-worker/src/handlers/auth.ts` `handleMintServiceJwt` — `INSERT OR IGNORE … role 'super_admin'` for `SERVICE_ACCOUNT_ID`, then `signJWT({ role: "super_admin" }, …, SERVICE_JWT_TTL_SECONDS)` (90 days); `packages/averrow-worker/src/index.ts:663-671` mint route; `packages/averrow-mcp/src/index.ts:560-623` caches the JWT in `MCP_TOKEN_CACHE` KV.
- **Exploit / blast radius:** the MCP tools only need *read* diagnostics, but the JWT they carry is full-platform `super_admin` — it satisfies `requireSuperAdmin`, bypasses `getOrgScope`, and can drive every mutating `/api/admin/*` and `/api/orgs/:orgId/*` endpoint. If `MCP_AUTH_TOKEN` leaks (it mints on demand) **or** the cached service JWT in KV leaks, the attacker holds 90 days of unrevocable super-admin (preview/service JWTs are standalone — no DB role read-back to revoke). Compare the sibling `mint-ui-preview-jwt` (`index.ts:679-687`), which is deliberately hard-capped to `analyst|admin|client` and never `super_admin` — the service path should mirror that discipline.
- **Remediation (owner: `backend-engineer`):** mint the service account at the least role the MCP tools actually need (a read-only global role — `auditor` is exactly this shape: global read scope, mutates nothing), shorten the TTL, and add a per-IP/token rate limit on the `/mcp` entrypoint (`averrow-mcp/src/index.ts:878`). If any MCP tool needs a mutation, gate that one path explicitly rather than blanket super-admin.
- *Confidence: high on the JWT scope (read the mint code); the rate-limit gap is bounded by the bearer gate, so lower urgency than the role scope.*

### O2 — `staging` and `dev` Workers were bound to the PRODUCTION D1 database *(Medium)* — **FIXED (PR #1613)**
- `packages/averrow-worker/wrangler.toml`: `[[env.staging.d1_databases]]` and `[[env.dev.d1_databases]]` previously both set `database_id = "a3776a5f-…"` (and audit `55d58eff-…`) — the **same IDs** as the production `DB`/`AUDIT_DB` bindings.
- **Exploit / blast radius:** this isn't a remote-attacker vuln, it's a standing data-integrity hazard with a large blast radius. Any deploy to `trust-radar-staging`/`trust-radar-dev`, any `wrangler dev`, or any test run that writes through `env.DB` mutated **production** threat/user/org data and the production audit log. There was no isolation boundary between test and prod at the data layer.
- **Resolution (2026-07-13):** created four dedicated D1 databases and repointed the env bindings:
  | Env | Binding | Database | UUID |
  |---|---|---|---|
  | staging | `DB` | `trust-radar-v2-staging` | `7709322c-7020-41f9-ad96-aa797cf585de` |
  | staging | `AUDIT_DB` | `trust-radar-v2-audit-staging` | `45539971-b965-4bfb-a1d3-93a03771b1c4` |
  | dev | `DB` | `trust-radar-v2-dev` | `83f702ee-3600-4f0a-84e8-102c49765429` |
  | dev | `AUDIT_DB` | `trust-radar-v2-audit-dev` | `3f2c2683-bc2b-474a-b61a-89d80bb2cded` |
  Production bindings are unchanged.
- **No live cutover needed (verified 2026-07-13).** There is **no deployed `trust-radar-staging` / `trust-radar-dev` Worker** (Cloudflare `workers_list`: only `trust-radar` prod exists), and CI (`.github/workflows/deploy-radar.yml`) deploys **production only** — `pnpm run deploy` with no `--env staging|dev`, and migrations run against the prod DBs only. So the hazard was only ever reachable from a developer's *local* `wrangler deploy --env staging` / `wrangler dev`. The merged binding change is therefore a complete forward-looking guardrail: the moment anyone stands up staging/dev locally, they hit the isolated empty DBs instead of prod. The new DBs stay empty until such a deployment exists; whoever provisions a real staging/dev environment (with local `wrangler`) applies migrations (`wrangler d1 migrations apply … --env staging|dev`) as part of that workflow — nothing is pending on the current, prod-only deployment.
- **Out of O2 scope (track separately):** the env blocks declare only `DB`/`AUDIT_DB`, not `GEOIP_DB`/`DNS_QUEUE_DB`; a future real staging/dev environment that exercises those code paths would need its own reference DBs too.

### O3 — Astro reflected-XSS advisory in `averrow-marketing` (not reachable) *(Low–Medium)* — **FIXED / residual accepted**
- `packages/averrow-marketing/package.json` pinned `astro ^4.16.18`; advisory GHSA-wrwg-2hg8-v723 (reflected XSS via **server islands**) is patched `>=5.15.8`.
- **Reachability confirmed not reachable (2026-07-13):** `astro.config.mjs` is `output: 'static'` with no SSR adapter, and a grep for `server:defer`/`serverIsland` in `packages/averrow-marketing/src` returns nothing — server islands cannot run in a pure-SSG build.
- **Resolution:** bumped to the latest safe 4.x (`^4.16.19`); marketing build verified (14 static pages). The advisory's fix only lands at `>=5.15.8` (a breaking 4→5/6 major), which is disproportionate to an **unreachable** advisory, so the major was **not** forced. Residual: 6 `pnpm audit` highs remain inside the Astro 4.x dependency tree (astro ×3, `@rollup/pluginutils>picomatch`, `devalue`, `@astrojs/react>vite`) — accepted as not-reachable; revisit if/when the marketing site adopts SSR or a future Astro major is scheduled.

### O4 — Dependency CVEs are dev/build-tooling, not shipped to the prod runtime *(Low)* — **FIXED**
- Originally `pnpm audit` (high+): 52 findings (3 critical / 17 high) — **vitest** ("Vitest UI server arbitrary file read/exec"), `wrangler>miniflare>undici` (SSRF/routing), `jsdom>ws` (DoS), `flatted` (DoS). None bundled into the deployed Workers or SPA runtime.
- **Resolution (2026-07-13):** vitest → `^4.1.10` (trust-radar) / `^3.2.7` (ops/tenant); wrangler → `^4.110.0` (pulls `undici ≥7.28.0`); vite → `^6.4.3` (ops/tenant). Transitives unreachable by a direct bump pinned via `pnpm.overrides` (documented in `overridesNotes`): `flatted >=3.4.2`, `ws >=8.21.0`, `form-data >=4.0.6`. **All 3 criticals eliminated; highs 17 → 6** (the 6 residual are the O3 Astro-tree advisories). `protocol-buffers-schema >=3.6.1` (D3, the one transitive that ships) confirmed intact. Verified: `pnpm typecheck` 5/5, trust-radar 1262 tests + ops 292 tests green.
- *Follow-up ticket (out of scope): `wrangler@4.110` peer-wants `@cloudflare/workers-types@^5`; left on `^4` — a Worker-facing types bump with typecheck risk, deferred.*

### O5 — Unbounded `new RegExp` from operator catalogs (carry-over L7) *(Low, accepted)* — **FIXED**
- `lib/named-threat-matcher.ts`; also `dmarc-receiver.ts` dynamic patterns. No ReDoS today because the catalogs are operator-curated, not self-serve.
- **Resolution (2026-07-13):** new `lib/safe-regex.ts` `safeCompilePattern()` caps dynamic sources at 512 chars / 20 quantifiers and never throws (skip + `logger.warn` on reject). Both call sites (`compileRegexes`, `xmlTag`/`xmlTagAll`) route through it. Cap is ~9× the longest real seed pattern (`0204_named_threats_catalog.sql`) so no current pattern changes behavior; it's defense-in-depth for a future self-serve catalog. New `test/safe-regex.test.ts`; existing matcher/DMARC suites unchanged.

### O6 — `requireRole(...)` `Math.min` footgun (carry-over L8) *(Low, nit)* — **FIXED**
- `middleware/auth.ts` — `Math.min` of listed roles' levels is correct for all current call sites, but `requireRole("super_admin","client")` would silently admit everyone.
- **Resolution (2026-07-13):** `requireRole` now emits a dev-safe `logger.warn("require_role_mixed_tier", …)` when passed a multi-role list spanning more than one hierarchy tier (the footgun shape). `Math.min` semantics and every current gate are unchanged — verified all real call sites are single-role or single-tier (level 3), so none warn today.

### O7 — Config/hygiene nits *(Low / informational)* — **FIXED (KV) / accept-defer (rest)**
- **FIXED:** `packages/averrow-mcp/wrangler.toml` shipped `id = "REPLACE_WITH_KV_NAMESPACE_ID"` for `MCP_TOKEN_CACHE` and no such namespace existed (binding fell through → JWT cache in-memory only, `/mcp` limiter fail-open). Created a dedicated `averrow-mcp-token-cache` KV namespace (`44e12db8feed4216996f8609187979d2`) and wired its id. Takes effect on the next **averrow-mcp** deploy (that Worker is not in the `trust-radar` prod CI — see note below).
- **Accepted / deferred:** CSP (both `middleware/security.ts` and `public/_headers`) allows `script-src 'unsafe-inline'` — standard for these SPAs and consistent across surfaces; a nonce/hash-based policy is a larger long-term change, left as a deliberate defer. Legacy `[[queues.consumers]] architect-analysis` binding — no security exposure, cleanup pending CLI dereg, left as-is.
- **⚠️ Deploy note (O1 + O7):** the `averrow-mcp` Worker is deployed manually, not by the `trust-radar` prod CI (`deploy-radar.yml` only deploys `trust-radar`). So the averrow-mcp-side changes — the O1 `/mcp` rate limiter and this KV binding — take effect only on the next manual `averrow-mcp` deploy. The **security-critical** half of O1 (the service-JWT re-scope to `auditor`) lives in the trust-radar handler and deploys automatically.
- **Reviewed and acceptable (no action):** the unauthenticated aggregate endpoints `/api/dashboard/stats`, `/api/heatmap`, `/api/observatory/*`, and `/api/signals` (`handlers/signals.ts` reads the public `scans` table, i.e. homepage scan submissions, not tenant data) are intentionally public. The authenticated `/api/internal/taxii/discover` and `/cf-zone-introspect` are operator SSRF primitives but sit behind the timing-safe internal-secret gate — low, operator-only.

---

## 3. What's done well (current state)

- **Cross-tenant isolation is now enforced in depth.** `requireStaff` sweep across brands/threats/scan/dashboard, `buildAlertOwnershipWhere` on alert by-id, `requireOrgMember` as the route-layer backstop on the `/api/orgs/:orgId/*` tenant surface, plus the per-handler `verifyOrgAccess` inner net. The RBAC model (two role namespaces, `auditor` minted-only via `mint-ui-preview-jwt`, preview-JWT hard-capped away from `super_admin`) is coherent and matches `CLAUDE.md §7`.
- **Uniform internal-surface gating.** Every `/api/internal/*` POST checks `timingSafeBearerEq` individually; the GET family has a blanket gate at `index.ts:585-590`. Fail-closed when the secret is unset.
- **Auth-data handling.** Tokens are in-memory + HttpOnly cookie (H5), the service worker never persists API responses (H6), OAuth state is browser-bound (H3), the auth rate-limit bucket fails closed (L1), rate-limit identity uses `CF-Connecting-IP` (L2).
- **Output/SSRF hygiene.** Public HTML escapes all attacker/AI-derived fields (C2); outbound webhooks and domain probes validate URLs and refuse redirects/private ranges (M1/L6); abuse-unsubscribe uses a dedicated HMAC secret (L5).
- **CORS is an allowlist** (`lib/cors.ts:46-54`) with localhost gated behind explicit dev/test environments; MCP emits no reflected ACAO (L3); the CSP is reconciled between `_headers` and middleware.
- **Secret hygiene is clean.** No live credentials in tracked files — only test placeholders (`sk-ant-test`) and a legitimate PEM-parsing regex in `lib/google-service-account.ts`. `.gitignore` covers `.env*`/`.dev.vars`. All Worker secrets externalized; the D3 `protocol-buffers-schema` override is correctly pinned.
- **imprsn8 fully removed** — the entire prior Critical cluster (seeded admin, unsalted hashing, dashboard XSS) no longer exists.

---

## 4. Recommended remediation order

1. **O1 (High)** — re-scope the MCP service JWT off `super_admin` to a read-only global role + shorten TTL; add `/mcp` rate limiting. Largest standing blast radius. Owner: `backend-engineer`.
2. **O2 (Medium)** — give `staging`/`dev` their own D1 databases; stop pointing them at production. Owner: `platform-sre` + `backend-engineer`.
3. **O3 (Low–Medium)** — bump Astro ≥5.15.8 and confirm marketing is static-only. Owner: `frontend-engineer`.
4. **O4 (Low)** — routine dev-dep bumps (vitest / wrangler→undici / ws). Owner: `backend-engineer`.
5. **O5–O7 (Low)** — regex length-cap before any self-serve catalog, `requireRole` assert, MCP KV-id placeholder, CSP `unsafe-inline` review, legacy queue cleanup. Fold into normal hardening / `code-reviewer` gates.

**Hand-offs:** O1/O2/O4 remediations are code/infra changes → owning engineers + `platform-sre`; if any lands as a diff touching auth, route it through `appsec-reviewer` per the per-change gate. Nothing here required (or received) any source edit — diagnose-and-report only.
