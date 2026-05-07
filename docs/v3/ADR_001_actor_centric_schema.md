# ADR-001 — Actor-centric schema for v3

**Status:** Proposed (Phase 0 step 2 — pending operator review)
**Date:** 2026-05-07
**Supersedes:** the implicit "threat-centric" shape inherited from v2
**Superseded by:** —
**Related:** `.claude/plans/v3.md` §1 (six-engine vision), §2.2 (correlation engine), §3 gaps #6/#7/#8 (kit/AI/actor write-back), §4 (v3 architecture), `docs/v3/PHASE_0_AUDIT.md` (data state)

---

## 1. Context

The v3 vision (`.claude/plans/v3.md` §1) names **correlation** as the engine that differentiates Averrow:

> The differentiator is the **correlation engine** — AI-powered actor pattern detection tied to brand context. Most platforms ingest, classify per-row, and present. Averrow's claim is that the same actor pivoting from provider A to B becomes one story, not two unrelated alerts.

The v2 schema doesn't model this story. It models **threats**.

### v2 today (live `trust-radar-v2`, snapshot 2026-05-07)

| Table | Rows | Role today |
|---|---:|---|
| `threats` | 236,337 | Canonical row of "something bad happened". 53 columns, lots of inline enrichment fields (vt_*, gsb_*, dbl_*, abuseipdb_*, pdns_*, greynoise_*, seclookup_*) |
| `threat_actors` | 17 | Sparse, hand-curated |
| `threat_attributions` | 47 | N:M between threats and actors. Used only by NEXUS / OTX / news / manual |
| `infrastructure_clusters` | 481 | NEXUS-detected groupings. Has `pivot_from_cluster_id` lineage + `actor_id` FK |
| `campaigns` | 2,302 | Auto-generated lower-confidence groupings |
| `infrastructure_clusters.actor_id` populated | **2 / 481 (0.4%)** | The actor binding path is wired but empirically dark |

### Symptoms of the threat-centric model

1. **`threats` carries 30+ enrichment columns** that are 0%-30% populated. Each new enrichment provider adds 3-5 columns inline. This is OLAP-on-OLTP — fast for single-row reads, brittle for sparse-feature evolution.
2. **Actor identity lives behind two indirections.** Reading "what did actor X do this week" requires `threat_actors → threat_attributions → threats`, with the middle table at 47 rows. The story-shaped query is the most expensive query.
3. **Pivots aren't first-class.** They're implicit via `infrastructure_clusters.pivot_from_cluster_id`. NEXUS infers the lineage; the data model doesn't promise it.
4. **No place for kit / MO / AI-content fingerprints.** Gaps #6, #7 in the plan have no schema home. Each lands as another inline column on `threats` or as a sibling JSON blob.
5. **Multi-brand actors are denormalized.** A single actor targeting Cloudflare Pages, Microsoft Office, and Google Forms shows up as three semi-related cluster rows, not one actor with three target bindings.

### Why now

The §8.6 audit (2026-05-06 / re-run 2026-05-07 — see `docs/v3/PHASE_0_AUDIT.md`) showed the customer-fit signal is **already** dominated by actor-side patterns: `pages.dev` has 770 threats not because Cloudflare is being attacked, but because operators host phishing kits on `*.pages.dev`. The data is asking for an actor-centric model. v2 just doesn't have one.

---

## 2. Decision

v3 adopts an **actor-centric schema**. The actor is the canonical entity; everything observed is evidence pointing at one or more actors with graded confidence. Schema-as-narrative.

### 2.1 Core entity ranking

| Tier | Entity | Why it's at this tier |
|---|---|---|
| **0 — canonical** | `actor` | The "who". Everything else exists to describe or attribute to one |
| **1 — evidence** | `detection` | A single observed bad-thing event. Ingest engine writes here. Renames `threats` to clarify role |
| **1 — evidence** | `kit_fingerprint`, `mo_fingerprint`, `ai_content_fingerprint` | Pattern hashes the correlation engine extracts from detections |
| **1 — evidence** | `pivot` | First-class actor-to-actor or infra-to-infra movement record |
| **2 — context** | `brand`, `hosting_provider`, `infrastructure_cluster`, `campaign` | What got hit / where it lived. Becomes side-context, not the spine |
| **3 — bindings** | `actor_brand_target`, `actor_hosting_provider`, `actor_kit`, `actor_mo`, `actor_ai_signature` | Many-to-many edges between an actor and the patterns / targets attributed to them |
| **4 — provenance** | `attribution_evidence` | Replaces `threat_attributions`. Says *which detection or fingerprint led to which actor binding, with what source and confidence* |

### 2.2 Read shape — the canonical actor query

```sql
-- "What does actor X look like this week?" — designed to run in <100ms with cubes.
SELECT
  a.id, a.name, a.aliases,
  a.attribution_confidence, a.first_seen, a.last_seen,
  abt.brands_targeted_7d,
  ahp.providers_used_7d,
  ak.kits_active_7d,
  amo.mo_fingerprints_active_7d,
  aai.ai_signatures_active_7d,
  ap.pivots_7d
FROM actor a
LEFT JOIN actor_brand_target_cube_7d abt ON abt.actor_id = a.id
LEFT JOIN actor_provider_cube_7d ahp ON ahp.actor_id = a.id
LEFT JOIN actor_kit_cube_7d ak ON ak.actor_id = a.id
LEFT JOIN actor_mo_cube_7d amo ON amo.actor_id = a.id
LEFT JOIN actor_ai_signature_cube_7d aai ON aai.actor_id = a.id
LEFT JOIN actor_pivot_cube_7d ap ON ap.actor_id = a.id
WHERE a.id = ?;
```

The shape v2 makes hardest is the shape v3 makes cheapest. Cubes (already a v2 platform pattern — `lib/cube-builder.ts`) become per-actor instead of per-geo / per-provider / per-brand.

### 2.3 Detection (renamed from `threats`) — write shape

```sql
CREATE TABLE detection (
  id TEXT PRIMARY KEY,
  source_feed TEXT NOT NULL,                              -- which ingest adapter saw it
  detection_type TEXT NOT NULL CHECK (detection_type IN (
    'phishing','typosquatting','impersonation','malware_distribution',
    'credential_harvesting','c2','scanning','malicious_ip','botnet',
    'malicious_ssl','spam_trap_hit','abuse_mailbox_report'
  )),
  -- Identifying fields the ingest adapter knows
  malicious_url TEXT,
  malicious_domain TEXT,
  ip_address TEXT,
  asn TEXT,
  country_code TEXT,
  -- Provenance
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','down','remediated')),
  severity TEXT CHECK (severity IN ('critical','high','medium','low','info')),
  confidence_score INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Notable subtractions from v2 `threats`:**
- All inline enrichment columns (`vt_*`, `gsb_*`, `dbl_*`, `abuseipdb_*`, `pdns_*`, `greynoise_*`, `seclookup_*`, `cf_*`) move to a side table `detection_enrichment(detection_id, provider, payload_json, checked_at)`. Sparse columns become row-presence; new providers add rows, not migrations.
- `target_brand_id` becomes a binding row in `detection_brand_target` (many-to-many). A single phishing URL can target two brands; v2 forced a denormalization.
- `cluster_id` and `campaign_id` move out — clusters and campaigns now hang off the actor, with detections joining them through actor binding rather than through direct FK.

### 2.4 Actor — the canonical entity

```sql
CREATE TABLE actor (
  id TEXT PRIMARY KEY,                  -- e.g. 'actor_otx_PUMA'
  name TEXT NOT NULL,                   -- 'PUMA', 'TA505', 'Storm-1058'
  aliases TEXT,                         -- JSON array
  description TEXT,
  -- Capabilities
  primary_motivation TEXT CHECK (primary_motivation IN (
    'financial','espionage','disruption','hacktivism','unknown'
  )),
  capability TEXT CHECK (capability IN ('apt','organized_crime','crimeware','script_kiddie','unknown')),
  affiliation TEXT,                     -- nation-state / criminal group reference
  -- Confidence
  attribution_confidence TEXT NOT NULL DEFAULT 'medium'
    CHECK (attribution_confidence IN ('confirmed','high','medium','low')),
  -- Lifetimes
  first_seen TEXT,
  last_seen TEXT,
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active','dormant','disrupted')),
  -- Provenance
  source TEXT DEFAULT 'manual'
    CHECK (source IN ('manual','nexus','news','otx','customer_report')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

Mostly preserves the v2 `threat_actors` columns (those land was already paid down). The schema change is **promoting this from a sparse curated table to the canonical entity that everything else hangs off**. The v2 columns stay; v3 adds the binding tables and the cubes.

### 2.5 Bindings — actor⇄everything is many-to-many

| Binding | What it joins | Why |
|---|---|---|
| `actor_brand_target(actor_id, brand_id, first_seen, last_seen, detection_count)` | actor → brand | "Who has this actor targeted?" — pre-computed, query-cheap |
| `actor_hosting_provider(actor_id, provider_id, first_seen, last_seen, detection_count)` | actor → provider | "Which providers does this actor use?" — feeds Provider Abuse Scorecard (gap #5) |
| `actor_kit(actor_id, kit_fingerprint_id, first_seen, last_seen, detection_count)` | actor → kit | "What phishing kits does this actor deploy?" — gap #6 |
| `actor_mo(actor_id, mo_fingerprint_id, first_seen, last_seen, detection_count)` | actor → MO | "What does this actor's typical attack look like?" — gap #6 |
| `actor_ai_signature(actor_id, ai_signature_id, first_seen, last_seen, detection_count)` | actor → AI fingerprint | "Is this actor leaning on LLM-generated content?" — gap #7 |
| `attribution_evidence(actor_id, detection_id, source, confidence, observed_at, metadata)` | actor ← detection | Replaces v2 `threat_attributions`. The audit trail for *why we say this actor did this thing* |

All binding tables share the shape `(actor_id, target_id, first_seen, last_seen, detection_count)` so the correlation engine has one write pattern: "I just observed X for actor A — increment, set last_seen, no-op if it exists." This collapses six different write paths into one.

### 2.6 Pivots — first-class

```sql
CREATE TABLE pivot (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actor(id) ON DELETE CASCADE,
  pivot_type TEXT NOT NULL CHECK (pivot_type IN (
    'provider','asn','country','tld','kit','mo','ai_signature'
  )),
  -- What changed
  from_value TEXT,
  to_value TEXT,
  -- When it happened (NEXUS detection time)
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Velocity / confidence
  hours_to_pivot INTEGER,        -- gap between last `from_value` detection and first `to_value`
  confidence TEXT NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('confirmed','high','medium','low')),
  -- Detection chain
  last_detection_before TEXT REFERENCES detection(id),
  first_detection_after TEXT REFERENCES detection(id),
  -- Trigger for Mitigation engine (gap #4 — auto-resubmit on pivot)
  triggered_resubmit_at TEXT,
  metadata TEXT
);
```

Replaces v2's `infrastructure_clusters.pivot_from_cluster_id` (which is geometry — "this cluster spawned that one"). Pivots in v3 are **about the actor's behavior**, not the cluster's lineage. The Mitigation engine (gap #4) listens to `pivot` INSERTs to fire auto-resubmit.

### 2.7 Fingerprints — kit / MO / AI

```sql
CREATE TABLE kit_fingerprint (
  id TEXT PRIMARY KEY,
  -- Hashes used for matching
  asset_sha256 TEXT,             -- e.g. login form CSS hash
  form_post_pattern TEXT,        -- normalized POST URL template
  redirect_chain_hash TEXT,
  -- Identification
  kit_name TEXT,                 -- 'evilginx2', 'modlishka', '<unknown_kit_42>'
  kit_family TEXT,
  first_seen TEXT, last_seen TEXT, detection_count INTEGER DEFAULT 0
);

CREATE TABLE mo_fingerprint (
  id TEXT PRIMARY KEY,
  pattern_hash TEXT NOT NULL,    -- normalized representation of attack steps
  pattern_description TEXT,
  step_count INTEGER,
  first_seen TEXT, last_seen TEXT, detection_count INTEGER DEFAULT 0
);

CREATE TABLE ai_content_fingerprint (
  id TEXT PRIMARY KEY,
  -- Output of the AI-content detection model
  ai_probability REAL NOT NULL,
  model_version TEXT,
  signal_type TEXT CHECK (signal_type IN ('phish_lure','social_profile','support_message')),
  content_excerpt TEXT,
  first_seen TEXT, last_seen TEXT, detection_count INTEGER DEFAULT 0
);
```

Extracted by correlation-engine sync agents on the Sentinel pass (v3 plan §3 gaps #6 and #7). Joining detections to fingerprints happens via three tables: `detection_kit(detection_id, kit_fingerprint_id)`, etc. The fingerprint table itself is small (one row per unique kit / pattern / signature); the join tables grow with detection volume.

---

## 3. Consequences

### 3.1 What gets easier

- **The canonical actor query is cheap** — actor-centric cubes deliver "what's actor X doing this week" in <100ms.
- **New enrichment providers add rows, not columns** — `detection_enrichment(provider='vt', ...)`, `detection_enrichment(provider='gsb', ...)` etc. No schema migration when ProviderXYZ joins the stack.
- **Multi-brand actors are first-class** — `actor_brand_target` is a binding, not a denormalization.
- **Pivots are queryable** — "show me actors who pivoted providers in the last 24h" is a single SELECT against `pivot WHERE pivot_type='provider' AND observed_at > ...`. Drives gap #4 auto-resubmit and the Provider Abuse Scorecard (gap #5).
- **Customer tenant IA snaps to the schema** — `Threat-actor` (§9.6 primary destination) is now the actor row + cubes. `Brand-health` is `brand` + filtered `actor_brand_target` rollups. `Intel` is briefings, unchanged.

### 3.2 What gets harder

- **The ingest engine has more write fan-out.** Today: one INSERT to `threats`. v3: INSERT detection + N enrichment rows + bindings (where known) + maybe a pivot. Mitigation: a single ingest transaction with all writes batched; Cloudflare D1 supports multi-statement transactions.
- **Backfill from v2 is non-trivial.** 236,337 threats → detections is straightforward. 47 attributions → attribution_evidence is fine. **Re-attributing the other 236,290 detections to actors is the work the correlation engine does anyway**, so v3's actor binding mostly *populates* over time rather than backfills wholesale. ADR-002 covers the migration plan.
- **Two correlation engine writes need to be idempotent**: kit/MO fingerprint matching, and pivot detection. Both should accept "I've seen this before" without duplicating rows. v2 already handles `ON CONFLICT DO UPDATE` patterns; v3 makes this the dominant write style.

### 3.3 What stays the same

- **`brand`, `hosting_provider`, `infrastructure_cluster`, `campaign`** keep their v2 shape. The schema change is around them, not to them. v2's `brand_enricher` agent keeps working; the firmographic columns stay where they are.
- **Cubes as the read-side primitive.** v2 has `threat_cube_geo`, `threat_cube_provider`, `threat_cube_brand`. v3 adds `actor_*_cube_7d` siblings. Same builder pattern (`lib/cube-builder.ts`).
- **Read replicas + KV cache.** Unchanged.
- **Agent mesh, Flight Control, cost guard.** Unchanged.

### 3.4 What this ADR does NOT decide

- **Cutover sequence** (parallel run vs phased) — ADR-002.
- **Per-tenant isolation** — actor data is cross-tenant by design (the consume side of cross-tenant intel, §7.4 / §5.5). Brand data and detection data are tenant-scoped. This split needs an ADR of its own once §5.5 + §7.4 land in code.
- **Storage location** (D1 vs Hyperdrive vs split) — D1 is the working assumption; if actor cubes get write-hot, revisit.
- **Customer-managed actor labels** — operators may want to give an actor a customer-side nickname ("the .ru group that hit us in Q1"). Out of scope for v3 schema.
- **GDPR / takedown of detection data** — needs its own retention ADR. v3 doesn't change v2's retention semantics.

---

## 4. Alternatives considered

### 4.1 Keep `threats` as canonical, add actor cubes on the side

**Rejected.** Cubes solve the read-side query speed but don't fix the structural problems: enrichment columns still pile up, multi-brand denormalization persists, pivots stay implicit. A read-side band-aid over a write-side problem.

### 4.2 Keep v2 verbatim, add per-tenant denormalization for the customer app

**Rejected.** Per-tenant materialized views were the v2 sketch; they made every cross-tenant intel query (§7.4) gymnastic. The actor is intrinsically cross-tenant — the model has to reflect that.

### 4.3 Event-sourcing — `event_log` as the spine, projections everywhere

**Rejected.** The "actor pivots provider" story benefits from event-source thinking, but the operational cost (rebuild projections, debugging in production) is high for a 4-engineer team. Stay relational; lift event-sourcing patterns selectively (e.g. `pivot` is event-shaped — it's an immutable log of behavior changes).

### 4.4 Graph database (Neo4j / DGraph)

**Rejected.** Cloudflare-native deployment is the operational floor; introducing a non-CF DB doubles ops. Graph queries are nicer for actor-pivot traversal, but Cloudflare D1 + careful joins handle the depth-2 / depth-3 traversals v3 actually needs.

---

## 5. Implementation sketch (informational — not part of this decision)

When ADR-002 (migration strategy) lands and Phase 1 starts, the rough order is:

1. **Phase 1.1 (week 1):** Create v3 D1 with new schema in parallel. Empty.
2. **Phase 1.2 (week 2):** Port ingest engine to write to v3 schema. v3 ingestion runs alongside v2. Two sources of truth, briefly.
3. **Phase 1.3 (week 3-4):** Port correlation engine. NEXUS / Sentinel / Cartographer write actor bindings + pivots + fingerprints natively.
4. **Phase 1.4 (week 5-6):** Backfill `actor` and `attribution_evidence` from v2 `threat_actors` + `threat_attributions`. The other 236K threats → detections is a one-shot copy; their actor bindings populate over time as v3 correlation runs.
5. **Phase 1.5 (week 7-8):** Cubes, read API, cutover gate.

This is the rough outline; ADR-002 owns the detail.

---

## 6. Open questions

| # | Question | Owner | When |
|---|---|---|---|
| Q1 | Should `detection.severity` move to `attribution_evidence.severity` so different attributions can disagree on severity? | Correlation engineer | Phase 1.3 |
| Q2 | Does `actor_brand_target` need a `target_relationship` enum (e.g. `direct_target`, `via_supply_chain`, `bystander`) for customer-tenant filtering? | Customer interviews (§9.9) | Phase 6.0 |
| Q3 | How long do we keep `detection_enrichment` rows? Some providers churn (a domain reclassified in 90 days); some are stable | Retention ADR | Phase 1.5 |
| Q4 | When does `kit_fingerprint.kit_name` resolve from `<unknown_kit_42>` to a named kit? Auto-merge logic vs analyst-curated? | Correlation engineer | Phase 2 |
| Q5 | Per-tenant vs cross-tenant: where does `attribution_evidence` live? Cross-tenant feels right but the original detection that produced the attribution is tenant-scoped | Privacy / cross-tenant ADR | Phase 5 |

---

## 7. References

- `.claude/plans/v3.md` §1 (six-engine vision), §2.2 (correlation gaps), §3 gap inventory, §4.1 (engine layout), §5.1 (split lock), §5.5 (cross-tenant pricing)
- `docs/v3/PHASE_0_AUDIT.md` — confirms the actor-vs-brand framing matches the data
- v2 schema:
  - `packages/trust-radar/migrations/0135_threat_attributions.sql` — current attribution shape
  - `packages/trust-radar/src/agents/nexus.ts` — current cluster + actor binding logic
  - `packages/trust-radar/src/lib/cube-builder.ts` — cube pattern v3 inherits
- Migration plan: ADR-002 (Phase 0 step 3, next)
