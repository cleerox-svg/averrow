# Platform Security Audit — 2026-06-10

> **Update (2026-07-12):** `packages/imprsn8` has been decommissioned —
> package, Worker, and Cloudflare resources removed. Every finding below
> scoped to imprsn8 (C1, C3, C4, H7, M5, M6) is moot: the vulnerable code
> no longer exists to exploit. Findings scoped to `trust-radar`,
> `averrow-ops`/`averrow-tenant`, and `averrow-mcp` are unaffected and this
> record is left otherwise unchanged as the point-in-time audit result.

Full-platform security review covering `packages/trust-radar` (backend Worker),
`packages/averrow-ops` and `packages/averrow-tenant` (SPAs), `packages/imprsn8`,
`packages/averrow-mcp`, and `packages/shared`. Read-only code audit — no behavior
was changed. Findings are ordered by severity; each includes file/line references
and a concrete remediation. Headline findings were independently re-verified
against the code before publication.

**TL;DR:** The core trust-radar Worker is in good shape — hardened JWT
verification, timing-safe internal-secret checks, prepared statements everywhere,
clean secrets hygiene, solid WebAuthn. The serious problems cluster in three
places: (1) the **imprsn8** package (seeded known-password admin, unsalted
password hashing, stored XSS, no rate limiting), (2) **staff-API authorization**
(client-role tokens can reach cross-tenant staff endpoints; alert IDOR), and
(3) a **public stored-XSS** in the shareable scan-result page.

---

## Critical

### C1 — Production admin seeded with a publicly known password (imprsn8)
- `packages/imprsn8/migrations/0006_seed_admin.sql`, `0007_fix_admin_hash.sql`
- Committed migrations seed `admin@imprsn8.io` (`is_admin=1`, enterprise plan)
  and the migration comment documents the cleartext password. Verified:
  `sha256(<password in comment>)` matches the seeded hash exactly. Anyone with
  repo read access can log in as an imprsn8 admin. Login path is live
  (`imprsn8/src/handlers/auth.ts:88-95`).
- **Fix (do this first):** rotate/disable the account in production D1
  immediately; remove the password from the migration comments; never seed
  fixed credentials via migrations — bootstrap the first admin out-of-band
  from a `wrangler secret`. If the repo is shared, treat the credential as
  burned regardless of history rewriting.

### C2 — Stored XSS in the public scan-result page (trust-radar)
- `packages/trust-radar/src/templates/scan-result.ts:108-109,274,285,292-297`
  (served by `handlers/scanPage.ts:36`, cached `public, max-age=3600`)
- `scan.url`, `scan.domain`, signal/finding details, and all `aiInsight.*`
  fields are interpolated into HTML with no escaping. The URL is validated
  only by `z.string().url()` which accepts `"><script>` payloads. An attacker
  submits a crafted scan URL and shares the public results link — the payload
  executes for every viewer, including staff. The `aiInsight` path is also a
  prompt-injection → XSS chain (model output over attacker input rendered raw).
- **Fix:** escape every interpolation with the `escapeHtml()` helper already
  used in `templates/incident-detail.ts:47`.

### C3 — Stored XSS in the imprsn8 dashboard via attacker-controlled handles
- `packages/imprsn8/src/templates/dashboard.ts:752-761,883-893,907-919,953-963,987`
- Threat/social/analysis renderers concatenate `suspect_handle`, `platform`,
  `threat_type`, etc. straight into `innerHTML`. The impersonator's handle is
  attacker-chosen by definition — a handle like `<img src=x onerror=…>`
  executes in the authenticated victim's session.
- **Fix:** add an `esc()` helper in the template's client script (or build DOM
  via `textContent`) and escape every interpolated field.

### C4 — Unsalted SHA-256 password hashing, live in imprsn8
- `packages/imprsn8/src/lib/hash.ts:3-10` (live: called from
  `handlers/auth.ts`); identical dead code at
  `packages/trust-radar/src/lib/hash.ts:3-12` (no call sites — auth is
  OAuth/magic-link/passkey only).
- Single unsalted SHA-256 digest, non-constant-time `===` comparison. A DB
  leak makes the whole user table trivially crackable.
- **Fix:** PBKDF2 via `crypto.subtle.deriveBits` (≥210k iterations, SHA-256,
  random per-user 16-byte salt, stored as `salt$iter$hash`) with a
  constant-time compare. Migrate on next successful login. In trust-radar,
  delete the unused functions so nobody wires them up later.

---

## High

### H1 — Staff `/v2` API routes accept customer (`client`-role) tokens
- Pervasive in `packages/trust-radar/src/routes/brands.ts` (verified: 64
  `requireAuth` guards, zero `requireStaff`), plus `dashboard.ts`,
  `threats.ts`, `scan.ts`.
- `requireAuth` admits any active user including `role='client'`. The
  "clients never reach /v2" rule is enforced only by client-side React
  routing. A tenant token can call e.g. `GET /api/brands/:id/threats`,
  `/api/threats/stats`, `/api/dashboard/providers`, `/api/threats/correlations`
  and read global, cross-tenant intelligence. Only the list endpoints apply
  `getOrgScope`.
- **Fix:** switch these routes to `requireStaff` (already used correctly in
  `routes/agents.ts`, `feeds.ts`, `export.ts`, `email-security.ts`,
  `investigations.ts`, `spam-trap.ts`). Tenant-facing equivalents live under
  the org-scoped tenant handlers and are unaffected.

### H2 — IDOR on `/api/alerts/:id` (GET and PATCH)
- `routes/dashboard.ts:102-111` → `handlers/alerts.ts:134` (`handleGetAlert`),
  `:156` (`handleUpdateAlert`)
- The by-ID read/update query purely by alert id — no `userId`/org scoping.
  Any authenticated user (including clients, per H1) can read or change the
  status of any tenant's alert. Contrast the correctly scoped
  `handleTenantUpdateAlert` (`handlers/tenantData.ts:388`) which JOINs
  `org_brands … AND ob.org_id = ?`.
- **Fix:** gate with `requireStaff` and/or add the ownership predicate
  mirroring the tenant handler.

### H3 — OAuth `state` not bound to the browser → login-CSRF/fixation
- `packages/trust-radar/src/handlers/auth.ts:27-35` (init), `:94-99` (callback)
- The CSRF nonce is stored only server-side in KV; nothing ties the callback
  to the browser that started the flow, enabling classic login-CSRF /
  session-fixation.
- **Fix:** set a short-lived HttpOnly cookie containing (a hash of) the nonce
  at initiation and require it to match `state` in the callback.

### H4 — Unauthenticated public AI assessment is a spend-amplification vector
- `routes/public.ts:107,313` → `handlers/public.ts:126` →
  `agents/public-trust-check.ts:214` (paid Anthropic call per request)
- Rate limiting is per-IP KV only (10/hr on `/api/v1/public/assess`, but the
  `/assess` form path uses the shared 30/min `scan` bucket), fails **open** on
  KV errors (`middleware/rateLimit.ts:80-83`), and is trivially distributed
  across IPs. No global ceiling → unbounded Anthropic spend + unbounded
  `assessments`/`brands` inserts.
- **Fix:** global daily cap (KV/D1 counter) that serves cached/deterministic
  results past the limit; serve existing cached assessments per domain; align
  the form path onto the stricter hourly bucket; consider Turnstile.

### H5 — JWT access + refresh tokens stored in `localStorage` (both SPAs)
- `packages/averrow-ops/src/lib/api.ts:24-27,42-44`,
  `packages/averrow-tenant/src/lib/api.ts:8,18-29`
- Any XSS (e.g. C2) or compromised npm dependency yields durable account
  takeover including the long-lived refresh token.
- **Fix:** move the refresh token to an `HttpOnly; Secure; SameSite` cookie
  (the backend's `radar_refresh` cookie infrastructure and the ops app's
  `cookie-refresh` mode already exist — finish that migration) and keep only
  the short-lived access token in memory.

### H6 — Service worker caches authenticated API responses to disk
- `packages/averrow-ops/public/sw.js:91-93,132-148`
- Every 200 GET under `/api/*` is written to Cache Storage — tenant threat
  and customer data persisted unencrypted, not cleared on logout.
- **Fix:** allowlist only truly public/static GETs; skip caching when an
  `Authorization` header is present; clear the API cache on logout; add
  `Cache-Control: no-store` to sensitive API responses.

### H7 — No rate limiting / brute-force protection on imprsn8 auth
- `packages/imprsn8/src/handlers/auth.ts:21-102`, no limiter in
  `imprsn8/src/index.ts`
- Unthrottled login (against unsalted hashes, see C4), unlimited registration,
  and distinguishable errors enable account enumeration + online guessing.
- **Fix:** per-IP + per-account rate limits on `/api/auth/*`, uniform error
  messages, Turnstile on register.

---

## Medium

| # | Finding | Location | Fix |
|---|---|---|---|
| M1 | SSRF via org `webhook_url` — stored unvalidated, tenant can trigger delivery on demand and read status/error (port-probe oracle) | `lib/webhooks.ts:102,188`; set at `handlers/organizations.ts:320,1024` | Require `https:`, reject private/loopback/link-local/CGNAT and internal hosts at set **and** send time; `redirect: "manual"` |
| M2 | `POST /api/brands/:id/deep-scan` is `requireAuth` — client-reachable paid AI scan against any brand | `routes/brands.ts:176-180` | `requireStaff`, or org-scope `:id` if tenant-exposed |
| M3 | MCP bearer-token check is not timing-safe, no rate limit on `/mcp`; token grants a 90-day service JWT usable against any `/api/*` | `packages/averrow-mcp/src/index.ts:847` | Constant-time compare (reuse `timingSafeBearerEq` pattern); scope the service account read-only |
| M4 | Specialty sub-role guards (`requireSales`/`requireSupport`/`requireBilling`) defined but never used — permission matrix in `lib/role-permissions.ts` unenforced at the route layer (over-restrictive today, but contradicts documented model) | `middleware/auth.ts:159-178`; `routes/admin.ts:464-503,535-600` | Wire the guards onto pricing/sales/billing routes, or remove them + the docs claim |
| M5 | imprsn8 serves HTML with no security headers (no CSP/HSTS/XFO/nosniff) — dashboard clickjackable | `imprsn8/src/index.ts:392-403` | Port trust-radar's `applySecurityHeaders` |
| M6 | imprsn8 CORS allowlist ships `http://localhost:3000`/`:5173` in production | `imprsn8/src/lib/cors.ts:1-22` | Gate localhost origins behind a dev env check |

## Low

| # | Finding | Location | Fix |
|---|---|---|---|
| L1 | Auth rate limiter fails open on KV errors; per-IP only | `middleware/rateLimit.ts:80-83` | Fail closed (or DO-backed fallback) for the auth bucket |
| L2 | Spoofable `X-Forwarded-For` fallback used for rate-limit identity and `sessions.ip_address` | `middleware/rateLimit.ts:34-38`; `handlers/auth.ts:455,597-599` | Use only `CF-Connecting-IP` |
| L3 | averrow-mcp CORS reflects arbitrary `Origin` (bounded by bearer gate, no credentials) | `averrow-mcp/src/index.ts:887-892` | Drop CORS or pin to known origins |
| L4 | Two handlers echo raw `Origin \|\| "*"` instead of the central `corsHeaders()` allowlist | `routes/threats.ts:72,79,99`; `handlers/tenantTrademarkModule.ts:195` | Route through `lib/cors.ts` |
| L5 | Abuse-unsubscribe HMAC falls back to `AVERROW_INTERNAL_SECRET ?? ""` | `handlers/abuseMailboxUnsubscribe.ts:54` | Dedicated secret; fail closed when unset |
| L6 | `domain-checker.ts` plain-`http` fallback lacks `redirect: 'manual'`; no private-IP guard if a future caller passes user input | `lib/domain-checker.ts:71,81` | Add `redirect: 'manual'` + guard comment |
| L7 | Dynamic `new RegExp` from operator-curated catalogs (ReDoS only if catalog becomes self-serve) | `lib/named-threat-matcher.ts:74`; `dmarc-receiver.ts:341,346` | Length cap / complexity check if self-serve |
| L8 | `requireRole(...)` enforces `Math.min` of the listed roles' levels — correct today, but `requireRole("super_admin","client")` would admit everyone | `middleware/auth.ts:99-113,142-146` | Add a warning comment / assert |

---

## What's done well (keep doing this)

- **JWT verification** (`lib/jwt.ts:45-96`): HS256 locked (alg-none and
  RS256-confusion rejected), constant-time `crypto.subtle.verify`, `exp` +
  future-`iat` checks; `JWT_SECRET` is a required type with no fallback.
- **Internal-secret auth**: every `/api/internal/*` / debug route gates via
  timing-safe `timingSafeBearerEq` (`lib/internal-secret.ts`), fail-closed
  when unset.
- **Token storage at rest**: refresh/invite/magic-link tokens are 256–384-bit
  CSPRNG values stored only as SHA-256 hashes; refresh rotation with revoke,
  30-day absolute session cap, forced-logout KV check on access and refresh.
- **WebAuthn**: server-side single-use challenges, origin/rpID checks,
  sign-count clone detection, enumeration-resistant begin flow.
- **SQL**: no injection found anywhere — prepared statements with bound
  params; dynamic identifiers go through allowlists/ternaries; dynamic
  `UPDATE` builders push static `"col = ?"` fragments only.
- **Open-redirect defense**: `sanitizeReturnTo` server-side + path-boundary
  `isSafeReturnTo` in the shared AuthProvider.
- **Secrets hygiene**: nothing live hardcoded (except C1's seed migration);
  `.gitignore` covers `.env`/`.dev.vars`; git history clean; all Worker
  secrets externalized via `wrangler secret`; no `VITE_*` leakage into
  client bundles; secret-named vars logged only as presence/absence.
- **Email**: Resend JSON API (no header injection); attacker-derived fields
  escaped in briefing/abuse-mailbox templates.
- **Prompt-injection containment**: abuse-mailbox classifier output validated
  against fixed enums; `takedown` is a human-review label, not auto-executed.
- **Security headers** on trust-radar HTML: HSTS preload, CSP,
  `frame-ancestors 'none'`, nosniff.
- **Stripe webhook** signature verification before trusting payloads.
- **React SPAs**: zero `dangerouslySetInnerHTML`/`innerHTML` sinks; default
  escaping covers threat-derived strings.

---

## Recommended remediation order

1. **Today:** C1 — rotate/disable `admin@imprsn8.io` in production.
2. **This week:** C2, C3 (escape the two XSS template families); H1 + H2
   (`requireStaff` sweep + alert scoping) — these three close the only
   cross-tenant data paths found.
3. **Next:** C4 (PBKDF2 in imprsn8, delete dead hash code in trust-radar),
   H3 (OAuth state cookie), H4 (global cap on public AI endpoints),
   H7 (imprsn8 rate limiting).
4. **Then:** H5/H6 (SPA token storage + SW cache), M1–M6, then the Lows as
   routine hardening.
