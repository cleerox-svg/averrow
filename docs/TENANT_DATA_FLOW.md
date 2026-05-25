# Tenant Data Flow — what each page reads, and where the data lives

This document maps the customer-facing tenant SPA (`packages/averrow-tenant`,
served at `/tenant/*`) to the backend endpoints and D1 tables behind it. It
exists because of a recurring confusion: "the tenant has thousands of threats
but the pages look empty." That symptom is almost always an
**information-architecture** gap (a page reads a table that hasn't been
populated for that brand), **not** a data or linkage bug.

Audit date: 2026-05-25. Backend: `packages/trust-radar`. DB: `trust-radar-v2`.

---

## 1. How an org is linked to its brands and threats

```
users ──< org_members >── organizations
                                  │
                                  └──< org_brands >── brands ──< threats
                                       (org_id,        (id)      (target_brand_id → brands.id)
                                        brand_id)
```

- `organizations.id` is an **INTEGER**; `brands.id` and `org_brands.brand_id`
  are **TEXT** (e.g. `brand_google_com`).
- An org sees a brand **only if** there is a matching `org_brands` row. Every
  tenant query joins through `org_brands ON ob.org_id = ?`.
- A threat is attributed to a brand via `threats.target_brand_id` →
  `brands.id`. There is no brand-name string match and no `org_id` on `threats`.
- `brand_profiles` was a separate, user-created table — **dropped** in
  migration `0149`. It is *not* part of this flow. Don't reintroduce it.

Resolving "org → its threats" is therefore:
`threats JOIN org_brands ON org_brands.brand_id = threats.target_brand_id AND org_brands.org_id = ?`.

---

## 2. Page → endpoint → backing table(s)

| Tenant page (route) | Endpoint | Backing table(s) |
|---|---|---|
| Overview (`/`) | `GET /api/orgs/:orgId/dashboard` | `threats` (counts), `social_profiles`, `alerts`, `brands` |
| **Threats (`/threats`)** | **`GET /api/orgs/:orgId/threats`** | **`threats`** (the core feed-intel table) |
| Signals (`/alerts`) | `GET /api/orgs/:orgId/alerts` | `alerts` |
| Takedowns (`/takedowns`) | `GET /api/orgs/:orgId/takedowns` | `takedown_requests` |
| Domain (`/modules/domain`) | `GET /api/orgs/:orgId/modules/domain[/brands/:id]` | `lookalike_domains`, `ct_certificates`, **`threats`** |
| Social (`/modules/social`) | `GET /api/orgs/:orgId/modules/social[/brands/:id]` | `social_profiles` |
| App Store (`/modules/app-store`) | `GET /api/orgs/:orgId/modules/app-store[/brands/:id]` | `app_store_listings` |
| Dark Web (`/modules/dark-web`) | `GET /api/orgs/:orgId/modules/dark-web[/brands/:id]` | `dark_web_mentions` |
| Trademark (`/modules/trademark`) | `GET /api/orgs/:orgId/modules/trademark[/brands/:id]` | `trademark_findings`, `trademark_assets` |
| Abuse Mailbox (`/modules/abuse-mailbox`) | `GET /api/orgs/:orgId/modules/abuse-mailbox/*` | `abuse_inbox_messages` |
| Threat Actor (`/modules/threat-actor`) | `GET /api/orgs/:orgId/modules/threat-actor/*` | `threats` + `threat_attributions` |

### Two data sources, two behaviours

- **Feed-fed (`threats`)** — the platform's primary dataset (hundreds of K
  rows), populated continuously by the threat feeds + analyst brand-matching.
  Every `threat_type` (`phishing`, `typosquatting`, `impersonation`,
  `malware_distribution`, `credential_harvesting`, `c2`) is a malicious
  domain/URL/host. Surfaced by: **Threats page** (all types), **Domain module**
  (all types), **Threat Actor module** (attributed subset), and the Overview
  counts.
- **Scanner-fed** — `lookalike_domains`, `ct_certificates`, `social_profiles`,
  `app_store_listings`, `dark_web_mentions`, `trademark_findings` are written by
  their own per-module scanners. If a scanner hasn't run (or found nothing) for
  a brand, that module page is legitimately empty **even though the brand has
  thousands of feed threats**. This is a data-population state, not a wiring
  bug.

---

## 3. The disconnect this doc was written to fix

For the test org **Acme Corp** (`org_id=1`, 3 brands: Httpwg, Google, Slate):

| Source for Acme's brands | Rows | Surfaced where (before fix) |
|---|---:|---|
| `threats` (active) | **17,605** | Overview counts only — no record view |
| `lookalike_domains` | 0 | Domain module → empty |
| `ct_certificates` | 0 | Domain module → empty |
| `dark_web_mentions` | 0 | Dark Web module → empty |
| `app_store_listings` | 0 | App Store module → empty |
| `trademark_findings` | 0 | Trademark module → empty |
| `social_profiles` | 30 | Social module |
| `alerts` | 75 | Signals |

Threat-type split of those ~20K rows: `malware_distribution` 17,331,
`phishing` 1,954, `c2` 373, `typosquatting` 250, `credential_harvesting` 40.

**Root cause:** the tenant UI was built entirely around the 7 modules, each
reading its own scanner table. The ~20K feed threats mapped to no module — the
Domain module only pulled `threat_type='typosquatting'` (250 rows). A working
backend endpoint for per-brand threats existed but no page consumed it. So the
Overview showed correct *counts* with nowhere to drill in.

**Fix (2026-05-25):**
1. New org-wide endpoint `GET /api/orgs/:orgId/threats`
   (`handleTenantOrgThreats`) + a dedicated **Threats** page (`/tenant/threats`)
   listing every threat record across the org's brands, with brand / status /
   severity / type filters, domain search, and pagination. The Overview
   per-brand rows now deep-link into it (`/threats?brand=<id>`).
2. The **Domain** module was broadened from typosquats-only to **all** malicious
   domain/URL threat types, with a `malicious_threats_total` headline + per-brand
   count.

The other four scanner-fed modules (Social / App Store / Dark Web / Trademark)
were intentionally left unchanged — they have no `threats`-table equivalent and
will populate when their scanners produce rows for the org's brands.

---

## 4. Adding a new tenant data view — the checklist

1. Confirm which table actually holds the data (feed-fed vs scanner-fed).
2. Scope every query through `org_brands` (use `verifyOrgAccess(ctx, orgId)`).
3. Model list endpoints on `handleTenantAlerts` / `handleTenantOrgThreats`:
   dynamic WHERE, pagination, root-level `total` + faceted breakdowns.
4. KV-cache the default (no-filter, page-1) shape via `cachedValue`.
5. Frontend hook: clone `lib/alerts.ts` / `lib/threats.ts` (pivot the root-level
   `total`/breakdowns out of `apiGet`'s `data`-only envelope).
6. Add the route to `docs/API_REFERENCE.md` and update this table.
