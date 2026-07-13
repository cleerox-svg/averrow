# Platform Security Audit — 2026-07-12

> **Supersedes `docs/archive/SECURITY_AUDIT_2026-06-10.md`.** That audit is archived as a point-in-time record. This one re-verifies every non-imprsn8 finding against the current code on `claude/platform-sub-agents-ozh9kd` (HEAD `8e3d03c`).
>
> **imprsn8 is out of scope — decommissioned 2026-07-12.** The `packages/imprsn8` package, its Worker, and its Cloudflare resources were removed; a tree-wide grep for `imprsn8` across `.ts`/`.toml`/`.json` returns zero hits. Prior findings **C1, C3, C4, H7, M5, M6** were all imprsn8-scoped and are moot by removal — not carried forward.

In-scope packages: `packages/trust-radar` (backend Worker), `packages/averrow-ops` + `packages/averrow-tenant` (SPAs), `packages/averrow-mcp` (MCP server), `packages/averrow-marketing` (Astro site), `packages/shared`. Read-only audit — no source was modified.

## TL;DR — current posture

The platform hardened substantially since 2026-06-10. **Every High and every non-imprsn8 Critical from the prior audit is now FIXED in code (not just annotated)**, and the fix was verified at each cited site rather than trusting the back-cite comments. The cross-tenant data paths (H1/H2), the public stored-XSS (C2), OAuth login-CSRF (H3), disk-persisted auth data (H6), and `localStorage` token theft (H5) are all closed. All `/api/internal/*` endpoints are uniformly gated by a timing-safe internal-secret check. CORS is now a real allowlist and the `_headers` / `middleware/security.ts` CSP are reconciled and identical.

**What remains open is smaller and mostly configuration/supply-chain, not exploitable app-logic:**
- **The single most material residual: the MCP service account still mints a 90-day *super_admin* JWT** (M3's timing-safe half was fixed; the "scope it read-only" half was not). This is the largest standing blast radius on the platform.
- **`staging` and `dev` Workers are bound to the *production* D1 database** (identical `database_id`), so a staging deploy or dev run mutates prod data.
- Dependency CVEs are almost entirely dev/build tooling not shipped to the production runtime; the one prod-shipped one (Astro reflected-XSS in the marketing site) appears unreachable because the vulnerable feature (server islands) isn't used.

---

## 1. Reconciliation of every prior non-imprsn8 finding

| Prior | Finding (short) | Status | Evidence (current) |
|---|---|---|---|
| **C2** | Stored XSS in public scan-result page | **FIXED** | `packages/trust-radar/src/templates/scan-result.ts:25` `escapeHtml` helper, applied at every user/AI/DB interpolation: title/meta `:121-122`, url/meta `:287-288`, domain `:298`, AI insight `:305-310`, signal value/detail `:321-322`, flag severity/detail `:332-333`. Static labels (`s.label`) are hardcoded, not attacker input. |
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

> **Remediation status (2026-07-13):** **O1 FIXED** (PR #1612 — service JWT re-scoped to read-only `auditor`, TTL 90d→30d, `/mcp` rate-limited). **O2 FIXED in config, deploy pending** (dedicated staging/dev D1 databases created + wired; see the O2 note for the remaining `wrangler d1 migrations apply` + `deploy` cutover steps). O3–O7 remain open as low-priority hygiene.

### O1 — MCP service account mints a 90-day `super_admin` JWT; `/mcp` unthrottled *(High)* — **FIXED (PR #1612)**
- `packages/trust-radar/src/handlers/auth.ts` `handleMintServiceJwt` — `INSERT OR IGNORE … role 'super_admin'` for `SERVICE_ACCOUNT_ID`, then `signJWT({ role: "super_admin" }, …, SERVICE_JWT_TTL_SECONDS)` (90 days); `packages/trust-radar/src/index.ts:663-671` mint route; `packages/averrow-mcp/src/index.ts:560-623` caches the JWT in `MCP_TOKEN_CACHE` KV.
- **Exploit / blast radius:** the MCP tools only need *read* diagnostics, but the JWT they carry is full-platform `super_admin` — it satisfies `requireSuperAdmin`, bypasses `getOrgScope`, and can drive every mutating `/api/admin/*` and `/api/orgs/:orgId/*` endpoint. If `MCP_AUTH_TOKEN` leaks (it mints on demand) **or** the cached service JWT in KV leaks, the attacker holds 90 days of unrevocable super-admin (preview/service JWTs are standalone — no DB role read-back to revoke). Compare the sibling `mint-ui-preview-jwt` (`index.ts:679-687`), which is deliberately hard-capped to `analyst|admin|client` and never `super_admin` — the service path should mirror that discipline.
- **Remediation (owner: `backend-engineer`):** mint the service account at the least role the MCP tools actually need (a read-only global role — `auditor` is exactly this shape: global read scope, mutates nothing), shorten the TTL, and add a per-IP/token rate limit on the `/mcp` entrypoint (`averrow-mcp/src/index.ts:878`). If any MCP tool needs a mutation, gate that one path explicitly rather than blanket super-admin.
- *Confidence: high on the JWT scope (read the mint code); the rate-limit gap is bounded by the bearer gate, so lower urgency than the role scope.*

### O2 — `staging` and `dev` Workers were bound to the PRODUCTION D1 database *(Medium)* — **FIXED in config, deploy pending**
- `packages/trust-radar/wrangler.toml`: `[[env.staging.d1_databases]]` and `[[env.dev.d1_databases]]` previously both set `database_id = "a3776a5f-…"` (and audit `55d58eff-…`) — the **same IDs** as the production `DB`/`AUDIT_DB` bindings.
- **Exploit / blast radius:** this isn't a remote-attacker vuln, it's a standing data-integrity hazard with a large blast radius. Any deploy to `trust-radar-staging`/`trust-radar-dev`, any `wrangler dev`, or any test run that writes through `env.DB` mutated **production** threat/user/org data and the production audit log. There was no isolation boundary between test and prod at the data layer.
- **Resolution (2026-07-13):** created four dedicated D1 databases and repointed the env bindings:
  | Env | Binding | Database | UUID |
  |---|---|---|---|
  | staging | `DB` | `trust-radar-v2-staging` | `7709322c-7020-41f9-ad96-aa797cf585de` |
  | staging | `AUDIT_DB` | `trust-radar-v2-audit-staging` | `45539971-b965-4bfb-a1d3-93a03771b1c4` |
  | dev | `DB` | `trust-radar-v2-dev` | `83f702ee-3600-4f0a-84e8-102c49765429` |
  | dev | `AUDIT_DB` | `trust-radar-v2-audit-dev` | `3f2c2683-bc2b-474a-b61a-89d80bb2cded` |
  Production bindings are unchanged. The new databases are **empty** — the config change alone does not isolate a running deployment. **Remaining cutover steps (need `wrangler` deploy auth, not available in the build sandbox):**
  1. `wrangler d1 migrations apply trust-radar-v2-staging --env staging` and `… trust-radar-v2-audit-staging --env staging` (repeat for `--env dev`) to build the schema on the new DBs.
  2. `wrangler deploy --env staging` (and `--env dev`) to cut the running Workers over to the isolated DBs.
  3. Optional: seed staging with a sanitized dataset if realistic staging data is wanted.
  Until steps 1–2 run, the deployed staging/dev Workers still point at whatever they were last deployed with. Also note (out of O2 scope): the env blocks declare only `DB`/`AUDIT_DB`, not `GEOIP_DB`/`DNS_QUEUE_DB`; if staging/dev exercise those code paths they need their own reference DBs too — track separately.

### O3 — Astro reflected-XSS advisory in `averrow-marketing` (likely unreachable) *(Low–Medium, uncertain)*
- `packages/averrow-marketing/package.json:17` pins `astro ^4.16.18`; advisory GHSA-wrwg-2hg8-v723 (reflected XSS via **server islands**) covers `<=5.15.6`, patched `>=5.15.8`.
- **Reachability:** a grep for `server:defer` / `serverIsland` across `packages/averrow-marketing/src` returns **nothing**, so the vulnerable feature isn't used. If the marketing site is built as static SSG output (no SSR server-islands runtime), this is **not reachable**. Could not fully confirm the deploy is pure-static from config alone.
- **Remediation (owner: `frontend-engineer`):** bump Astro to `>=5.15.8` (or the latest 4.x carrying the fix) as routine hygiene, and confirm the marketing deploy has no SSR/server-islands runtime. *Labeled uncertain — worth confirming, not asserting exploitable.*

### O4 — Dependency CVEs are dev/build-tooling, not shipped to the prod runtime *(Low)*
- `pnpm audit` (high+): 52 findings (3 critical / 17 high). The critical ones are **vitest** (`<3.2.6` in ops/tenant, `4.0.x` in trust-radar — "Vitest UI server arbitrary file read/exec," only when the UI server is listening — a local-dev/CI risk, never prod), plus transitive dev-chain: `wrangler>miniflare>undici` (SSRF/routing), `jsdom>ws` (DoS), `flatted` (DoS). None are bundled into the deployed Workers or SPA runtime.
- **D3 pin verified good:** `protocol-buffers-schema >=3.6.1` override is present (`package.json:29-30`, rationale `:20-21`) — this is the one transitive that *does* ship (into the ops SPA via deck.gl→pbf) and it's correctly pinned to the patched release.
- **Remediation (owner: `backend-engineer`/`docs-maintainer`):** bump `vitest` (≥3.2.6 / ≥4.1.0), `wrangler` (pulls patched `undici ≥7.28.0`), `jsdom`/`ws` as routine dev-dep hygiene. Low urgency — none are prod-reachable.

### O5 — Unbounded `new RegExp` from operator catalogs (carry-over L7) *(Low, accepted)*
- `lib/named-threat-matcher.ts:74`; also `dmarc-receiver.ts` dynamic patterns. No ReDoS today because the catalogs are operator-curated, not self-serve.
- **Remediation:** add a source-length/complexity cap **before** any feature makes these catalogs tenant-editable. Flag for `code-reviewer` on any such future diff.

### O6 — `requireRole(...)` `Math.min` footgun (carry-over L8) *(Low, nit)*
- `middleware/auth.ts:159-173` — `Math.min` of listed roles' levels is correct for all current call sites, but `requireRole("super_admin","client")` would silently admit everyone.
- **Remediation:** add an assert/comment, or switch to an explicit set-membership check. Cosmetic-defensive.

### O7 — Config/hygiene nits *(Low / informational)*
- `packages/averrow-mcp/wrangler.toml:16` ships `id = "REPLACE_WITH_KV_NAMESPACE_ID"` placeholder for `MCP_TOKEN_CACHE` — deploy-config drift; confirm the real namespace is set out-of-band or the MCP UI-verify tools will fail closed.
- CSP (both `middleware/security.ts:24-34` and `public/_headers:2`) allows `script-src 'unsafe-inline'`. Standard for these SPAs and consistent across both surfaces (the reconciliation this session landed is real and correct), but `'unsafe-inline'` weakens the XSS defense-in-depth that would otherwise backstop a regression of C2. Consider a nonce/hash-based policy long-term.
- Legacy `[[queues.consumers]] architect-analysis` still bound (`wrangler.toml:142-147`) — documented cleanup pending CLI dereg; no security exposure, just surface to eventually remove.
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
