# Trademark Monitoring

The trademark module gives a **unified, mark-centric view of brand misuse**:
which marks a brand owns (`trademark_assets`) and where they're being misused
(`trademark_findings`). It surfaces in the staff ops SPA (`/v2 → Trademarks`)
and the customer tenant app (`/tenant → Trademark Infringement`, entitlement
`trademark`).

It ships in two phases. **Phase 1 is live and costs nothing.** Phase 2 is a
paid add-on, deferred until there's customer demand.

---

## Phase 1 — internal correlation (shipped, zero cost)

No external API, no AI spend. Produced by `scanners/trademark-monitor.ts`
(`runTrademarkScanBatch`), wrapped by the `trademark_monitor` agent
("Herald"), dispatched from the orchestrator's hourly tick via
`runJob('trademark_scan', …)`. Scope: **`org_brands`** (brands under active
tenant monitoring). All writes are idempotent (`INSERT OR IGNORE` on
deterministic ids + the `(brand_id, found_url, asset_id)` unique index), so it
re-runs safely every tick.

### Assets — seeded from the `brands` table

| Asset | Source | Notes |
|---|---|---|
| Wordmark | `brands.name` | One per monitored brand (`tm-asset-wordmark-<brandId>`) |
| Logo | `brands.logo_hash` + `brands.logo_url` | Only when a perceptual hash already exists |

### Findings — correlated from signals other scanners already collect

| `found_context` | Source table | Selection | Classification mapping |
|---|---|---|---|
| `social` | `social_profiles` | `classification IN (impersonation, suspicious)`, active | impersonation→confirmed, suspicious→likely |
| `app_store` | `app_store_listings` | same | same |
| `website` | `threats` | `threat_type = 'typosquatting'`, active | severity high/critical→likely, else unknown |
| `website` | `lookalike_domains` | `registered = 1`, not benign/taken_down | threat_level high/critical→likely, else unknown |

Classification/severity are **derived** from each source row's own verdict —
no AI tokens are spent. Findings link to the brand's wordmark asset via
`asset_id`.

> Why correlation, not crawling: the genuinely novel, paid work is logo/image
> matching (Phase 2). Wordmark misuse is already captured by the domain,
> social, and app-store scanners — Phase 1 simply unifies it under the brand's
> marks, which is the product's value-add and free.

### Where it shows up

- **Ops:** `GET /api/trademarks/overview` → `features/trademarks/Trademarks.tsx` (`/v2/trademarks`).
- **Tenant:** existing `GET /api/orgs/:orgId/modules/trademark[/brands/:id]` handlers + the `Trademark` / `BrandTrademarkFindings` pages — already wired; they light up once the scanner runs.

---

## Phase 2 — logo / image misuse (deferred, PAID — when we have customers)

The schema is already built for this: `trademark_assets.phash`,
`trademark_findings.found_phash`, `match_distance` (Hamming), `found_image_url`,
`ai_action`. Phase 2 crawls/looks up images in the wild, perceptual-hashes
them, and matches against a brand's logo `phash`, with a vision-LLM tie-break.

**What it needs (and the cost):**

| Capability | Option | Cost |
|---|---|---|
| pHash compute | self-hosted (`sharp` / Workers) | Free |
| Reverse-image "where does this logo appear" | TinEye API · Google Vision Web Detection · Bing Visual Search | **Paid**, per-call (~$1–3 / 1k) |
| Logo detection in images | Google Cloud Vision · AWS Rekognition | **Paid**, ~$1.50 / 1k images |
| Marketplace counterfeit scan | Corsearch · Red Points · MarqVision | **Paid**, enterprise |

Gate Phase 2 behind a paid tier/entitlement (same pattern as other premium
modules). Wire the vision/reverse-image client behind an env-var guard so it
stays inert until a key is provisioned (lesson from the crt.sh path: never ship
an active external dependency that can't degrade cleanly).

---

## Future free enhancement — registry ingestion (needs API keys, no $)

Populating `trademark_assets` *registration metadata* (`registration_country`,
`registration_number`, `registration_date`) from official IP offices is free
but needs API keys provisioned as Worker secrets:

| Office | Coverage | Auth |
|---|---|---|
| USPTO TSDR / Open Data | US | free API key (`USPTO_API_KEY`) |
| EUIPO eSearch / Open Data | EU | free OAuth client creds |
| WIPO Global Brand DB | International | free, limited |

Not built yet because (a) it needs keys this environment can't provision and
test, and (b) it's additive metadata on top of the Phase 1 wordmark assets.
When added, guard each office's fetch behind its env key so it no-ops when
unset.

---

## Cost summary

- **Phase 1 (live):** $0 — internal correlation + asset seeding.
- **Registry metadata (future):** $0 but needs free API keys.
- **Phase 2 (deferred):** real per-call / enterprise cost — paid-tier only.
