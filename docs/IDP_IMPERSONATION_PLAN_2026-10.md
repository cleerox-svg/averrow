# Identity Provider Impersonation ("Oktajacking") — Build Plan (2026-10-10)

Status: **planned, not started.** Implements roadmap item S4.5
(`docs/IMPROVEMENT_PLAN_2026-07.md`, Wave 4). Run through the CLAUDE.md §1A pipeline.

## Goal
A separate, prominent component that measures identity-provider (IdP) impersonation
**across all brands**, with KPIs and TTPs (MITRE ATT&CK) in one place. One classifier,
backfilled history, no full `threats` scans on page load.

Covers: phishing on attacker-controlled **legitimate IdP tenants** (`acme-sso.okta.com`,
`*.okta-emea.com`, `*.oktapreview.com`, `*.onelogin.com`, `*.auth0.com`, Microsoft tenant
lures), Scattered Spider / 0ktapus **lookalikes** (`acme-okta.com`, `acme-sso.com`,
`acme-servicedesk.com`, `acme-helpdesk.com`, `acme-vpn.com`), and **device-code** phishing.
Out of scope: true Oktajacking via a rogue AD agent inside a customer's own Okta (only
visible in the customer's Okta System Log).

## Owner decisions (2026-10-10)
1. **Home:** new ops page `/identity-threats` in the INTELLIGENCE nav (beside
   Observatory / Explorer / Coverage) + a KPI tile on Overview linking to it.
   Label: "Identity Provider Impersonation"; nav "Identity Threats". "Oktajacking" is a
   vendor term — staff notes only, never customer copy.
2. **Detection widening ships in the first build** (not deferred): add `sso`, `okta`,
   `helpdesk`, `servicedesk`, `vpn` lures. Watch alert/takedown volume for 7 days.
3. **Tenant slice:** later (v1.1), after the numbers are validated on real data.
4. **Attribution — dual signal:** credit the threat to the **targeted customer brand**
   (Acme), AND record the **abused IdP** (Okta etc.) in a separate classification
   (`threats.impersonated_idp`), surfaced as a "By identity provider" view — a signal for
   the IdP vendors themselves, kept separate from the IdP's own brand-impersonation count.

## Data plan
- **Migration 0288** (additive): `threats.impersonated_idp TEXT`,
  `lookalike_domains.idp_lure TEXT`, index `threats(technique, created_at)`.
- **Classifier `lib/idp-impersonation.ts`** (pure): host/URL/brand → `{ vector, idp }` or null.
  - Vectors: `idp_tenant`, `idp_lookalike`, `device_code` (existing
    `technique='device_code_phishing'` from `lib/device-code-detector.ts:158` joins the family).
  - IdPs: `okta`, `entra`, `onelogin`, `auth0`, `ping`, `duo`, `google`, `generic_sso`.
  - Stamps `threats.technique` (indexed, migration 0205; written by `lib/feedRunner.ts:79,102`).
    Never overwrite a non-null technique (`lib/named-threat-matcher.ts:202` reads it).
  - Microsoft: detect tenant lures from path/tenant GUID; do NOT make
    `microsoftonline.com` a multi-tenant host.
- **Hooks:** feedRunner insert (new threats); lookalike seeder sets `idp_lure`;
  bounded cursor backfill `POST /api/admin/backfills/idp-impersonation?limit=500`
  (idempotent, rowid cursor).
- **Attribution fix:** add okta.com, oktapreview.com, okta-emea.com, onelogin.com,
  auth0.com to `MULTI_TENANT_HOSTS` (`lib/brandDetect.ts:~229`) AND
  `SHARED_HOSTING_DOMAINS` (`lib/safeDomains.ts:~124`) so `acme-sso.okta.com` is not
  auto-dismissed as an "official subdomain". Brand-count reconciler corrects Okta's drift.
- **Widening:** `lib/dnstwist.ts:120-121` PREFIXES/SUFFIXES; `lib/nrd-brand-match.ts:122-124`
  (+`okta`, `vpn`); `durableObjects/CertStreamMonitor.ts:~345` lure list.

## API
`GET /api/intel/identity-threats?window=7d|30d` — `requireStaff`, `cachedValue` 300s,
key `idp.summary.<window>`; GROUP BY over `(technique, created_at)`. Add to
`docs/API_REFERENCE.md`. Response `{ success, data }`:
```
{ window, generated_at,
  kpis: { detections, detections_prev, brands_targeted, idps_impersonated,
          live, taken_down, lookalikes_flagged },
  trend:      [{ day, count }],
  by_vector:  [{ vector, label, count, prev }],
  by_idp:     [{ idp, label, count, brands, prev }],      // the IdP-vendor signal
  top_brands: [{ brand_id, brand_name, count, idps[] }],
  recent:     [{ threat_id, domain, brand_id, brand_name, idp, vector, status, created_at }],
  mitre:      [{ id, name, tactic, vectors[], count }] }
```
MITRE: T1566.002, T1557, T1078.004, T1528, T1621, T1111, T1583.001, T1583.006, T1656.
Tenant v1.1: `GET /api/orgs/:orgId/identity-threats` (`requireOrgMember`, `scopeCacheSegment`).

## Tasks & PR slicing
| # | Task | Owner |
|---|---|---|
| T1 | Classifier rules, IdP host table, vectors, MITRE map + unit tests | threat-intel-analyst |
| T2 | Migration 0288, feedRunner/seeder hooks, backfill | backend-engineer |
| T3 | Attribution + shared-hosting host additions | backend-engineer |
| T4 | Summary endpoint + API_REFERENCE | backend-engineer |
| T5 | Widening (dnstwist, nrd-brand-match, CertStream) | backend-engineer + threat-intel-analyst |
| T6 | Tests (classifier, attribution, triage non-dismissal, endpoint) | test-engineer |
| T7 | Gate + end-to-end | qa-verifier |
| T8 | Review | code-reviewer + appsec-reviewer |
| T9 | Page `features/identity-threats/`, nav item, CommandPalette, Overview tile | frontend-engineer |
| T10 | Design + code review of UI | design-reviewer + code-reviewer |
| T11 | Copy, changelogs, MINOR bump | content-strategist |
| T12 | Doc sync (CLAUDE.md §8, AI_AGENTS) | docs-maintainer |
| later | IdP sign-in-widget page signal; tenant slice; tenant-subdomain source research | — |

- **PR1:** T1–T8 (backend incl. widening; has a migration → verify deploy after merge).
- **PR2:** T9–T11 (UI; can build against the contract above in parallel).
- **PR3+:** later items.

## Risks
- `threats.technique` is single-valued — one technique per threat.
- Widening raises lookalike rows / `lookalike_domain_active` alerts / takedown drafts.
- Backfill writes in bounded batches; watch D1 budget via `./scripts/platform-diagnostics.sh 24`.
