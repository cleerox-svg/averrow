# Dark Web Monitoring — Build Plan

Status: draft (planning only — no code yet)
Branch: `claude/dark-web-monitoring-assessment-vWeyc`
Author: assessment session, 2026-05-28

---

## 1. Goal

Convert the current "Pastebin keyword scanner" into credible multi-source dark
web monitoring **without adding net D1 read pressure or new AI token spend**.

The strategy in one line: **activate intelligence we already collect, add
free structured sources, classify deterministically, read through cubes.**

## 2. Hard constraints

- **D1:** net read impact ≤ 0 across all phases (Phase 3 reduction must fund
  Phase 1 additions).
- **AI tokens:** zero net increase. Haiku stays scoped to ambiguous free-text
  Pastebin rows it already handles. All new sources are structured →
  deterministic SQL classification.
- **No breaking changes** to the `dark_web_mentions` schema, the tenant/ops
  API surfaces, or the existing UI. Everything is additive.
- **No Tor crawling** — not feasible from CF Workers (no SOCKS). "Dark web
  coverage" here means clearnet aggregators of dark-web activity, which is
  how most commercial competitors operate anyway.

## 3. Current state (single paragraph)

The dark web module (`agents/darkWebMonitor.ts` → `scanners/dark-web-monitor.ts`
→ `feeds/psbdmp.ts`) is a per-brand keyword scan against the PSBDMP Pastebin
archive. `source='pastebin'` is the only value ever written to
`dark_web_mentions`. Telegram leak channels (`feeds/telegram.ts`) are already
ingested and brand-matched but land in `social_mentions` and never reach the
dark web module. A ransomware-leak-site feed (`feeds/_archive/ransomwatch.ts`)
is fully built and shelved. HIBP is a disabled stub writing to an orphan
`stealer_log_results` table. The Breaches/ATO intel pages query
`breach_checks`/`ato_events` — tables with no migration and no writer
anywhere in the repo. A `dark_web_brand_summary` cube exists
(`cube-builder.ts:520`, healed every 6h via cube-healer cron `12 */6 * * *`)
and is read by the **staff** handler but the **tenant** handler still runs
8 correlated subqueries per brand row.

## 4. Architecture target

- **One read model:** `dark_web_mentions` table fed by N sources. Source enum
  (TEXT column, already free-form) extends to `pastebin | telegram |
  ransomware_leak | hibp` in Phase 1–2.
- **Two ingestion patterns:**
  - **Per-brand free-text scan** (existing): PSBDMP. Keep, unchanged. Haiku
    review pass unchanged.
  - **Global-pull → SQL brand-match → insert-matches** (new): every
    structured source. One external fetch per cron, match against `brands`
    table in SQL, insert only brand-matched rows. Cheaper per brand than the
    PSBDMP fan-out.
- **Cross-table bridge:** a cursor-based reconciler (pattern copy of
  `lib/dns-queue-reconciler.ts`) promotes brand-matched leak rows from
  `social_mentions` (Telegram) and `threats` (ransomware) into
  `dark_web_mentions`. Cursor bounds reads to "rows added since last tick."
- **Read path:** tenant handler swapped onto the existing
  `dark_web_brand_summary` cube; cube rebuild promoted from 6h to Navigator's
  5-min tick so new leak rows surface in minutes; Navigator pre-warm extended
  to cover the tenant dark-web overview.
- **Classification:** deterministic SQL for all structured sources. Haiku
  unchanged on Pastebin free text.

---

## 5. Phase 1 — Activate existing data (week 1)

Goal: surface Telegram leak channels and re-enable ransomwatch. No new
external sources beyond ransomwatch (which is built but benched).

### 5.1 Schema

No migration required. `dark_web_mentions.source` is `TEXT NOT NULL` with no
CHECK constraint (migration 0103) — `'telegram'` and `'ransomware_leak'` are
valid today.

### 5.2 New file: `packages/trust-radar/src/lib/dark-web-reconciler.ts`

Pattern copy of `lib/dns-queue-reconciler.ts`. Two cursor sources:

- **Cursor A — Telegram leak channels**
  - KV key: `reconciler:dark_web:telegram_cursor`
  - Bootstrap default: `now - 30 minutes`
  - Query: `social_mentions WHERE platform='telegram' AND brand_id IS NOT NULL
    AND (has_threat_keyword OR match_type='domain') AND created_at >= cursor
    ORDER BY created_at LIMIT 500`
  - Promote → `dark_web_mentions` with:
    - `source='telegram'`
    - `source_url=content_url`, `source_channel=channel_name`,
      `source_author=channel_name`, `posted_at=content_created`
    - `match_type='domain'` or `'brand_name'` (carry from `match_type`)
    - `severity` derived: domain match + threat keyword → HIGH; domain match
      only → MEDIUM; brand name + threat keyword → MEDIUM; brand name only →
      LOW (no Haiku)
    - `classification='confirmed'` when severity ≥ MEDIUM, else `'suspicious'`
    - `classified_by='system'`
  - Idempotent via existing `idx_dark_web_mentions_uniq (brand_id, source,
    source_url)`.

- **Cursor B — Ransomware leak sites (DLS)**
  - KV key: `reconciler:dark_web:ransomware_cursor`
  - Bootstrap default: `now - 30 minutes`
  - Query: `threats WHERE type='ransomware' AND target_brand_id IS NOT NULL
    AND created_at >= cursor ORDER BY created_at LIMIT 500`
  - Promote → `dark_web_mentions` with:
    - `source='ransomware_leak'`
    - `source_channel=tags JSON group_name`, `source_url=url`,
      `posted_at=first_seen`
    - `severity='CRITICAL'`, `classification='confirmed'`,
      `match_type='domain'`, `classified_by='system'`
    - Confidence: 0.95 (DLS posts are high-fidelity by construction)
  - Bridge mechanic: the existing per-tick `runBrandMatchBackfill`
    (orchestrator.ts:872, via `lib/brandDetect.ts:matchBrand`) already maps
    ransomware threats with a victim `domain` to `target_brand_id` — the
    reconciler reads the brand-matched rows downstream of that.

Both cursors advance to `MAX(created_at)` of the page processed; `>= cursor`
(not `>`) handles identical-timestamp boundary, same as the DNS reconciler.

### 5.3 Wire into Navigator

Edit `packages/trust-radar/src/cron/navigator.ts` — add
`reconcileDarkWeb(env)` call alongside the existing
`reconcileDnsQueue(env)` (navigator.ts:195). Runs every 5 minutes on the
existing `*/5 * * * *` cron. No new cron entry.

### 5.4 Re-enable ransomwatch feed

- Move `packages/trust-radar/src/feeds/_archive/ransomwatch.ts` →
  `packages/trust-radar/src/feeds/ransomwatch.ts`
- Add `import { ransomwatch } from "./ransomwatch"` + register in the export
  block of `packages/trust-radar/src/feeds/index.ts`
- New migration: `migrations/0204_enable_ransomwatch_feed.sql` —
  `INSERT OR IGNORE INTO feed_configs` row with:
  - `feed_name='ransomwatch'`, `display_name='Ransomwatch DLS'`
  - `source_url='https://raw.githubusercontent.com/joshhighet/ransomwatch/main/posts.json'`
  - `enabled=1`, `schedule_cron='0 */6 * * *'` (every 6h is enough; DLS
    publication cadence is slow)
  - `feed_type='dark_web'`, `rate_limit=1`, `batch_size=500`
- Confirm `lib/brandDetect.matchBrand` recognizes the ransomwatch domain
  field — the feed already extracts `URL(post.website).hostname` and passes
  it as `ioc_value`/`domain` to `insertThreat`. Brand match runs every tick
  on pending threats — no extra wiring.

### 5.5 Dead-surface honesty

Two adjacent endpoints (`/api/breaches`, ATO) query `breach_checks` and
`ato_events` — tables with no CREATE TABLE migration anywhere. Three options
(decision needed before Phase 1 ships):

| Option | Effort | Result |
|---|---|---|
| A — Hide pages behind feature flag | 1 file edit | UI honest; no broken endpoints |
| B — Add empty `CREATE TABLE IF NOT EXISTS` migrations | 1 migration | Endpoints return `[]` instead of erroring |
| C — Fold into dark web module | (Phase 2+) | Breaches join `dark_web_mentions` with `source='hibp'` |

Recommendation: **B for Phase 1** (cheapest honest fix), **C as Phase 2.3
target** once HIBP is budgeted.

### Phase 1 cost math

| Item | D1 reads | D1 writes | AI tokens |
|---|---|---|---|
| Reconciler (per Navigator tick, 12/hr) | 2 × LIMIT 500 cursor reads, typically returns <50 rows in steady state | Only on new brand-matched leaks — historically <50/day total | 0 |
| Ransomwatch (every 6h) | 1 external fetch; 500 rows scanned in-memory; brand-match via existing tick | Insert-matches only (~5–20/day) | 0 |
| Cube rebuild (existing 6h cube-healer cycle) | unchanged | unchanged | 0 |
| **Net** | **+~150K reads/day worst case** (cursor pages × 12 × 24 even if mostly empty) | **+~70 writes/day** | **0** |

The +150K reads/day is funded entirely by Phase 3.1 (removing 8 correlated
subqueries per tenant overview page-load).

---

## 6. Phase 2 — Expand structured sources (week 2)

### 6.1 New feed: `feeds/ransomware_live.ts`

- `https://api.ransomware.live/recentvictims` — free, clearnet, no auth.
  Wider group coverage than ransomwatch (~100+ groups vs ransomwatch's ~40).
- Same `FeedModule` shape as ransomwatch; same `insertThreat` with
  `type='ransomware'`.
- Dedup against ransomwatch via `threatId('ransomware', 'domain', key)` —
  identical victims from both feeds collapse to one threat row, one
  `dark_web_mentions` row.
- New `feed_configs` row + index.ts registration.

### 6.2 Expand Telegram channel coverage

Pure operational change — no code.

- Update KV key `telegram_monitored_channels` with curated additions:
  stealer-log channels (RedLine, Raccoon, LummaC2 distribution channels),
  ransomware-affiliate negotiation channels, breach-broker channels.
- The existing per-channel loop in `feeds/telegram.ts` handles the new
  channels with no change; the reconciler from Phase 1 promotes any new
  brand-matched leaks into `dark_web_mentions` automatically.

### 6.3 HIBP wiring (deferred until subscription budgeted)

When HIBP Pro is purchased:

- Set `HIBP_API_KEY` secret + flip `feed_configs.enabled=1` for
  `hibp_stealer_logs`.
- Extend reconciler with Cursor C: `stealer_log_results WHERE entries_count
  > 0 AND brand_id IS NOT NULL AND checked_at >= cursor`.
- Promote → `dark_web_mentions` with `source='hibp'`, severity by
  `entries_count` band: ≥1000 → CRITICAL, ≥100 → HIGH, ≥1 → MEDIUM.
- Closes the loop on the modules.ts:71 "leaked credentials" promise.

### Phase 2 cost math

| Item | D1 reads | D1 writes | AI tokens |
|---|---|---|---|
| ransomware.live (every 6h) | 1 fetch; ~200 victims/day globally | Insert-matches only (~5–20/day, deduped vs ransomwatch) | 0 |
| Telegram channel expansion | covered by existing per-channel loop | covered | 0 |
| HIBP (when enabled) | 1 cursor read per tick | Insert-matches on actual exposure events | 0 |
| **Net** | **negligible** | **<30 writes/day total** | **0** |

---

## 7. Phase 3 — Read-path optimization (week 3, funds the D1 budget for Phases 1–2)

### 7.1 Migrate tenant handler to the existing summary cube

- `packages/trust-radar/src/handlers/tenantDarkWebModule.ts:42`
  (`handleGetDarkWebModuleSummary`) currently runs 8 correlated subqueries
  against `dark_web_mentions` per brand row.
- Replace with a single JOIN onto `dark_web_brand_summary` (already built
  by `cube-builder.ts:520`, already cron-healed). The summary covers
  `total_active / confirmed_active / suspicious_active / critical_active /
  high_active / medium_active / low_active` — sufficient for the current
  UI cards.
- For the `sources_covered` column the current UI also returns: add a
  follow-up cube column (Phase 3.4 below) — until then, return a constant
  derived from `(SELECT COUNT(DISTINCT source) FROM dark_web_mentions WHERE
  brand_id=?)` cached with `cachedCount` for 5 min.

### 7.2 Add tenant dark-web overview to Navigator pre-warm

- Navigator already pre-warms 24 endpoints across Phase A/B/C.
- Add `/api/orgs/<primary>/modules/dark-web` to Phase B.
- 5-min refresh keeps page warm; reads are now cube-backed, so each warm
  costs ~one indexed JOIN per org.

### 7.3 Promote `dark_web_brand_summary` rebuild to Navigator

- Currently rebuilt by cube-healer every 6h. After the reconciler is live,
  new leak rows would otherwise wait up to 6h to roll into the summary.
- Move (or duplicate) the call into Navigator's 5-min tick, after the
  reconciler step. Each rebuild is one `INSERT OR REPLACE` per brand —
  bounded by brand count (~9.6K rows max — small).
- Keep cube-healer's 6h call as backstop in case Navigator misses ticks
  (parity with the dns-queue reconciler/reaper dual layer).

### 7.4 (Optional) Extend summary cube with per-source rollups

- Migration: `ALTER TABLE dark_web_brand_summary ADD COLUMN source_mix TEXT`
  (JSON object: `{"pastebin": 12, "telegram": 4, "ransomware_leak": 1}`).
- Update `buildDarkWebBrandSummary` to populate via `GROUP BY brand_id,
  source` aggregated into JSON per brand.
- UI can render a source-badge row per brand using this column.

### Phase 3 cost math

| Item | D1 reads | D1 writes | AI tokens |
|---|---|---|---|
| Tenant overview: was 8 subqueries × N brands × page-loads/day | **was ~1.2M reads/day** at modest tenant traffic | unchanged | 0 |
| Tenant overview: now 1 JOIN × N brands × page-loads/day | **~150K reads/day** (8× reduction) | unchanged | 0 |
| Summary rebuild promoted to 5-min | ~5K rows × 288 ticks/day = ~1.4M index-only `INSERT OR REPLACE` per day | small | 0 |
| Navigator pre-warm of dark-web overview | folds into existing pre-warm cost | n/a | 0 |
| **Net** | **roughly flat — the subquery reduction offsets the cube refresh** | small | **0** |

Combined across phases: **Phase 3 read savings ≥ Phase 1+2 read additions**.
Constraint met.

---

## 8. UI / module copy

- `packages/averrow-tenant/src/lib/modules.ts:71` — keep current "Brand
  mentions, leaked credentials, executive exposure." Phase 2.3 (HIBP) makes
  the credentials clause true; Phase 1 makes the mentions clause true across
  more than just paste sites.
- `packages/averrow-tenant/src/lib/darkWebModule.ts` — extend the source
  label map: add `ransomware_leak: 'Ransomware leak site'`. `telegram` and
  `hibp` labels exist already.
- `packages/averrow-tenant/src/features/dark-web/DarkWeb.tsx` and
  `packages/averrow-ops/src/features/dark-web/DarkWeb.tsx` — add a source
  badge row per brand (reads `source_mix` from Phase 3.4 when present;
  graceful fallback if absent).
- Brand detail "Dark Web" tab in `BrandDarkWebFindings.tsx` already filters
  by source — no change needed; new source values appear in the existing
  filter chips automatically.

## 9. Validation / observability

- `agent_runs` will show a `dark_web_reconciler` row per Navigator tick
  (Navigator wraps invocations into the agent run mesh).
- `feed_status` for `ransomwatch` and `ransomware_live` should show
  `success` within one cron cycle of enable.
- `/api/internal/platform-diagnostics`:
  - `ai_spend_24h.dark_web_monitor` should stay flat (no new Haiku calls).
  - `agent_mesh.per_agent.dark_web_reconciler.avg_duration_ms` should be
    <500ms in steady state.
  - `feeds.per_feed[ransomwatch].failure_rate_pct` watched; ransomwatch
    upstream is a GitHub-hosted JSON and has historically been reliable.
- KV usage: 2 new cursor keys (negligible).

## 10. Rollback

Each phase is independently revertible:

- **Phase 1.3 reconciler:** remove the single `reconcileDarkWeb` call from
  `cron/navigator.ts`. Cursor KV keys can be left in place.
- **Phase 1.4 ransomwatch:** `UPDATE feed_configs SET enabled=0 WHERE
  feed_name='ransomwatch'`. Feed file can stay in `src/feeds/` (unused).
- **Phase 2.1 ransomware.live:** same — flag flip.
- **Phase 3.1 tenant handler:** revert `tenantDarkWebModule.ts` to subquery
  form (single-file revert).
- All schema additions are `CREATE … IF NOT EXISTS` / `ALTER … ADD COLUMN`
  — no destructive migrations.

## 11. Out of scope (intentionally)

- **Tor / .onion crawling** — not feasible from CF Workers (no SOCKS).
  Mitigation: clearnet aggregators (ransomwatch, ransomware.live, Telegram)
  cover the same intelligence with no Tor dependency.
- **Underground forum scraping** (BreachForums, XSS, Exploit) — high
  legal/operational risk, traditionally paid-data territory.
- **Stealer-log broker integrations** (Russian Market, Genesis) — paid;
  HIBP-Pro is the legitimate channel (Phase 2.3).
- **AI-driven cross-source correlation** — defer until structured sources
  are in place; the current Haiku review on Pastebin stays exactly as is.
- **Per-executive PII exposure** — a separate executive-protection module
  rather than another bolt-on to dark web. Out of this plan's scope.

---

## 12. Summary table

| Phase | Sources after | Net D1 | Net AI | Calendar |
|---|---|---|---|---|
| Today | 1 (Pastebin) | baseline | baseline | — |
| Phase 1 | 3 (Pastebin, Telegram, Ransomwatch) | +~150K reads/day | 0 | week 1 |
| Phase 2 | 4 (+ ransomware.live; HIBP when budgeted) | negligible delta | 0 | week 2 |
| Phase 3 | 4 | ~−1M reads/day vs today (8-subquery removal) | 0 | week 3 |
| **Total** | **paste + leak channels + ransomware DLS** | **net flat or negative** | **0** | **3 weeks** |

That's real dark web monitoring within the budget.
