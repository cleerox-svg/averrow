# Averrow Platform Assessment & AI / Agentic Strategy — 2026-10

**Status:** Phase 0 and Phase 1 implemented (2026-10-02, see "Status (2026-10-02)" below); Phases 2+ remain a proposal — open owner decisions in §8.
**Date:** 2026-10-01
**Method:** Five parallel assessment lanes, then a synthesis. The lanes were: purpose & outcomes (delivery-lead), AI call inventory (backend-engineer), live spend & health from read-only production D1 queries (platform-sre), Cloudflare AI platform research, and agentic opportunity mapping (threat-intel-analyst).
**Supersedes the AI sections of:** `docs/IMPROVEMENT_PLAN_2026-07.md` and `docs/PLATFORM_ASSESSMENT_2026-07.md`. All other sections of those docs still stand.

## Status (2026-10-02)

**Phase 0 — done.** Production runs with `AI_MODE = "rules_only"`.

- **`AI_MODE` switch** (`wrangler.toml` `[vars]`, also set for `staging` and `dev`; values `rules_only` | `enabled`, unset = `enabled`). Under `rules_only`, `callAnthropic` throws `AiDisabledError` before any network or D1 access and the `lib/haiku.ts` helpers return `failure_kind: 'throttled'` (a deliberate skip). Agents take their rule-based paths, and Flight Control's `platform_ai_calls_failing` stays quiet because nothing counts as an attempt.
- **Key-prefix leak removed** from the analyst diagnostic (`key_source` only).
- **`estimateCost` no longer throws** on an unknown model: prefix/alias matching, then a most-expensive-tier fallback rate with a once-per-model warning, so the ledger row is always written (`lib/budgetManager.ts`).
- **Outage alert reaches a human:** `platform_ai_calls_failing` also emails `BRIEFING_RECIPIENT` (at most once per UTC day) and pushes as sticky (`STICKY_PUSH_TYPES`); severity stays `high`. The alert text never interpolates a `parse_error`'s raw model output.
- **Push delivery audit is truthful:** `notification_deliveries` push status now comes from `dispatchPush`'s counts (`skipped` for no devices / push unconfigured, `failed` when every device failed); service accounts are excluded from audience fan-out.
- Service worker `VERSION` bumped to `2026-10-02.1` (sticky-push payload flag).

**Phase 1 — done.** These call sites no longer make AI calls:

- #1 Cartographer provider score: `computeHeuristicScore` only (`costGuard: 'exempt'`). Batch API path deleted (`lib/anthropic-batches.ts`, `lib/cartographer-batch.ts`); FC `scaleAgents` no longer gates Cartographer on `pause_all_ai`.
- #3 Sentinel classification: `ruleBasedClassify` only; #4 the "state-sponsored pattern" call is deleted.
- #6 Attributor: no AI. Stamps `attribution_attempted_at` and runs OTX-to-cluster inheritance; never names an actor from free text.
- #8 Strategist "coordinated campaigns" call deleted (NEXUS connected components cover it).
- #13 Seed Strategist: three SQL rules (R1 `seed_brand`, R2 `review_channel`, R3 `expand_campaign`); recommendations only, it no longer inserts campaigns or addresses.
- #18 Lookalike scanner threat level: `composeRuleLevel` plus the deterministic page verdict; `ai_assessment` is read-only history.
- #27 Hourly orchestrator "AI attribution" step and `POST /api/admin/backfill-ai-attribution` removed.
- #29 Architect analyzer/synthesizer and tests deleted. **Outstanding:** the `architect-analysis` queue binding is still declared in `wrangler.toml` (the wrangler CLI removal steps in its comment have not been run).
- #10 Narrator: severity and the alert gate are rule-derived (`computeNarrativeSeverity`, `shouldCreateNarrativeAlert`); the model only writes prose, with a deterministic template when the call is skipped or fails. This is the "severity must come from rules" half of #10 only; the prose call stays on Claude.
- Rules-only degradation for the paths with no rule equivalent: news watcher returns before fetching or inserting; advisories extraction is skipped without marking anything processed; `runSentinelSocialAssessment` returns before its SELECT. Evidence assembler, public trust check and social assessor treat a deliberate skip as a quiet fallback (no medium diagnostic row).

**Still AI-dependent (all skipped under `rules_only`):** #2 analyst brand inference (keyword pre-match remains), #5 sentinel social assessment, #7 strategist campaign naming, #9 observer narrative, #10 narrator prose, #11 news extraction, #12 advisories, #14 watchdog, #16/#17 alert AI judge and deep analyzers, #19 dark-web and #20 app-store ambiguous-case classifiers, #21 social AI assessor, #22 brand enricher, #23 evidence assembler, #24 phantom enumerator, #25 Campaign Hunter, #26 pathfinder, and the retired-but-callable sync agents in #28.

**Deviations from the §2 plan**

- Cartographer insight rows take their top threat types from `threat_cube_provider` (active threats in the cube window), not a `GROUP BY` over raw `threats`; the breakdown is queried only for providers that emit an insight.
- Lookalike scanner has a **one-time catch-up** for rows a retired Haiku verdict held below HIGH: mail+web, `ai_assessment IS NOT NULL`, status not `benign`/`taken_down`, stored level below HIGH. Sized at ~90 rows in prod (84 LOW, 6 MEDIUM). It is self-extinguishing and files the alert before persisting the level.
- Narrator alert dedupe: a new `threat_narrative` alert is raised only on escalation or a new signal channel versus any open narrative alert for the brand in the last 7 days (`isDuplicateNarrativeAlert`).
- Attribution Backlog now ranks clusters whose text mentions a known actor name/alias (`actor_hint`); an ordering hint only, never an attribution.
- The AI-call counters are now emitted by analyst only.

**Not started:** Phase 2 onward, including Unified Billing (deferred to Phase 2, §4.1) and the `[ai]` binding.

---

Path roots used below: `W/` = `packages/averrow-worker/src/`, `T/` = `packages/averrow-tenant/src/`.

---

## 0. TL;DR

1. **AI has been completely down for 83 days, and nobody noticed.**
   - The last successful AI call was 2026-07-10 11:10 UTC; since then every call has failed with `HTTP 400 credit balance too low`.
   - Every scheduled pipeline kept running on its rule-based fallback.
   - No customer-visible feature broke, and no alert was ever actioned by AI.
   - That is an accidental 83-day A/B test, and it says most of today's AI is not load-bearing.
2. **The AI we had was cheap and mostly misplaced.**
   - It cost about $70–140/month, all of it Claude Haiku.
   - Three call sites (cartographer, analyst, sentinel) were more than 90% of spend.
   - Cartographer alone was 66%, and it asks a model to output a number that `computeHeuristicScore` already computes. That breaks the "SQL does correlation, AI does narrative" doctrine.
3. **"The token credit system" is two problems stacked.**
   - *Provider:* Anthropic prepaid credits have a cliff edge. When the balance hits zero, AI stops.
   - *Ours:* four overlapping budget layers, applied inconsistently. About 20 call sites bypass the global throttle, and the throttle measures our own ledger rather than the real balance.
   - Moving to Cloudflare fixes the first problem only if we use **Workers AI with Standard (postpaid) billing**. Cloudflare's "Unified Billing" for third-party models such as Claude is *also* prepaid credits.
4. **Only one current "agent" is actually agentic.**
   - The rest are cron jobs. Some make a single LLM call.
   - The one real agent is Campaign Hunter: a multi-turn Sonnet tool-use loop. No user can reach it.
5. **Recommendation: a three-tier AI architecture, with agentic work aimed at the analyst's per-signal workflow.**
   - **Tier 0 — rules/SQL:** about 85% of former call volume goes back to deterministic code.
   - **Tier 1 — Workers AI:** classification, extraction and embeddings. Postpaid, no credit cliff, roughly 15–50× cheaper than Haiku.
   - **Tier 2 — Claude via AI Gateway with our own key (BYOK):** a short list of narrative, customer-facing and investigative uses, with automatic fallback to Workers AI.
   - **Agentic target:** **"Investigate this signal → Evidence Pack → Request takedown"**, built on the existing Workflows + `agent-loop` infrastructure, with human approval on every consequential action.

---

## 1. What Averrow is, and what it actually delivers

**Stated purpose** (CLAUDE.md §13): "threat actor intelligence platform — threats are evidence, patterns are the product."

**Actual product:** a working Digital Risk Protection / brand-protection platform with a strong correlation engine underneath.

| Stage | What runs today |
|---|---|
| Ingest | About 45 feeds, CertStream, and scanners for lookalike domains, trademarks, social, app stores, dark web, executives, spam traps and the abuse mailbox. 21 cron triggers. |
| Enrich | DNS, geo (MaxMind + D1), provider attribution, VirusTotal / Google Safe Browsing / GreyNoise / SecLookup, page-content phishing scorer (`W/lib/page-phishing-scorer.ts`), weaponization velocity. |
| Correlate | NEXUS clustering in six lanes, plus the connected-components post-pass (`W/lib/cluster-components.ts`) and infra-movement detection. **Pure SQL/rules, and the real intelligence engine.** |
| Alert | `createAlert`, then rule-based triage in Tiers 1/1.5 (`W/lib/alert-triage.ts`), then an optional on-demand AI judge. |
| Act | Takedowns drafted by Sparrow and the evidence assembler, sent live under a signed authorization (`TAKEDOWN_SEND_MODE="live"`). Tenant HITL approval. |

**Where reality diverges from the positioning**

- **The "WHO" is mostly borrowed.** Actor names come from feed labels. The AI attributor resolved only 0.4% of clusters (`W/agents/attributor.ts:60-70`), and the July assessment already recommended re-anchoring away from the WHO claim (`PLATFORM_ASSESSMENT_2026-07.md` §6).
- **The threat-actor module is Enterprise-only** (`migrations/0153_pricing.sql:62-80`). Customers paying $1,499 or $3,999 never see what is positioned as "the product".
- **The largest dataset is read-only for customers.** Tenant takedowns can only be requested from the lookalike-domain module (`T/lib/domainModule.ts:178-202`). Threats, social, app-store and dark-web findings have no takedown action.

### Outcome measurement — the biggest product gap

- **The platform cannot prove value to a customer.**
  - Takedown time-to-resolution, volume and success rate are computed (`W/lib/takedown-metrics.ts`) but shown only to staff (`W/handlers/takedowns.ts:505-528`).
  - The tenant home (`T/features/modules/Modules.tsx`) shows inputs only: threats, signals, exposure.
  - Nothing computes analyst-hours saved. The marketing site says so itself (`averrow-marketing/src/pages/why-averrow.astro:241-262`).
- **Promised vs. delivered:**
  - "Custom monitoring rules" (Business) are saved, but nothing applies them (`W/handlers/tenantData.ts:957-1047`).
  - "Daily strategic briefings" (Professional) do not exist for tenants. The tenant digest is weekly and switched off (`TENANT_DIGEST_MODE="off"`).
  - SSO/SAML/SCIM and SIEM connectors are placeholders.
  - Pricing copy and plan entitlements disagree (Abuse Mailbox, App Store).

**Implication for AI:** the platform's problem is not a lack of AI-generated prose. It is that **customers can't act on most findings, and can't see the outcomes of the ones they do act on.** Agentic work should close those two loops: act and prove.

---

## 2. AI inventory — what we have and what to do with each

All AI goes through `W/lib/anthropic.ts:280` (`callAnthropic`). There is no Workers AI binding, no `@cf/` model and no Vectorize. Volumes below are June 2026 (the last full working month) divided by 30.

| # | Call site | Purpose | ~calls/day | Verdict |
|---|---|---|---|---|
| 1 | `W/agents/cartographer.ts:942,964`, `W/lib/cartographer-batch.ts:168` | Provider reputation score from counts | ~410 (**66% of spend**) | **RULES** — `computeHeuristicScore` (`:1304`) already exists |
| 2 | `W/agents/analyst.ts:274` `inferBrand` | Which brand a domain targets (100 brand names in every prompt) | ~730 | **WORKERS AI** — embeddings + Vectorize nearest-brand, with keyword pre-pass kept |
| 3 | `W/agents/sentinel.ts:367` | Severity/confidence classification | ~76 | **RULES** — `ruleBasedClassify` (`:422`) |
| 4 | `W/agents/sentinel.ts:574` | "State-sponsored pattern" guess from a domain list | ≤24 | **DELETE** |
| 5 | `W/agents/sentinel.ts:795` | Social impersonation judgment (duplicates #21) | ≤80 | **WORKERS AI**, merged into #21 |
| 6 | `W/agents/attributor.ts:288` | Names an APT from ASN/country | ~170 | **RULES** — 99.6% "unknown"; wrong answers create `threat_actors` rows. Attribute only from specific evidence (OTX inheritance, sink IDs, cert serials). |
| 7 | `W/agents/strategist.ts:254,445,609` | Campaign naming | ~45 | **WORKERS AI** (or a template) |
| 8 | `W/agents/strategist.ts:708` | "Coordinated campaign" correlation | ≤4 | **RULES** — NEXUS components already do this |
| 9 | `W/agents/observer.ts:638` | Daily intel narrative | ~2 | **CLAUDE** |
| 10 | `W/agents/narrator.ts:71` | Brand threat story | ~4 | **CLAUDE** for prose; **severity must come from rules** (today the model's severity creates alerts, `:255-265`) |
| 11 | `W/lib/news-extractor.ts:74` | Actor/country extraction from articles | ~2 | **WORKERS AI** |
| 12 | `W/feeds/advisories.ts:207` | Named-threat extraction | <1 | **WORKERS AI** |
| 13 | `W/agents/seed-strategist.ts:164` | Spam-trap seeding plan | <1 | **RULES** |
| 14 | `W/agents/watchdog.ts:312` | Social mention classification | ~19 | **WORKERS AI** |
| 15 | `W/lib/abuse-mailbox-classifier.ts:244` | Phishing verdict emailed to the customer | <1 | **CLAUDE** |
| 16 | `W/lib/abuse-mailbox-deep-analyzer.ts:333` | Attribution narrative (Sonnet) | <1 | **CLAUDE** |
| 17 | `W/lib/alert-ai-judge.ts:154` | Alert verdict; auto-dismisses at ≥90 confidence | backfill only | **CLAUDE, but only behind the Evidence Pack** (§5). Today it judges from metadata alone. |
| 18 | `W/scanners/lookalike-domains.ts:1318` | Threat level from DNS booleans, with a veto down to LOW | ~0 | **RULES** |
| 19 | `W/scanners/dark-web-monitor.ts:639` | Paste classification | ≤60 | **WORKERS AI** |
| 20 | `W/scanners/app-store-monitor.ts:585` | App listing classification | ~50 | **WORKERS AI** |
| 21 | `W/agents/social-ai-assessor.ts:284` | Social impersonation classification | low | **WORKERS AI** |
| 22 | `W/lib/brand-enricher.ts:353` | Brand sector | backfill | **WORKERS AI** |
| 23 | `W/agents/evidence-assembler.ts:232` | Abuse report sent to providers | ~1 | **CLAUDE** |
| 24 | `W/agents/phantomEnumerator.ts:112` | Predict LLM-hallucinated domains for a brand | 0 | **WORKERS AI** (arguably *more* representative on open models) |
| 25 | `W/lib/agent-loop.ts:77` via `W/agents/campaign-hunter.ts:138` | Multi-turn tool-use investigation (Sonnet) | 0 | **CLAUDE** — becomes the agentic core (§5) |
| 26 | `W/agents/pathfinder.ts:171` | Sales lead copy | 0 | CLAUDE, low priority |
| 27 | `W/handlers/admin/backfills.ts:818` | Batch brand attribution | ~1 | **RULES** |
| 28 | Retired-but-callable agents: `public-trust-check`, `honeypot-generator`, `brand-deep-scan` (up to 200 yes/no calls per click), `admin-classify`, `url-scan`, `scan-report`, report narratives | — | ~0 | Narratives → CLAUDE / WORKERS AI. public-trust, honeypot → **WORKERS AI**. deep-scan, admin-classify, url-scan, scan-report → **RULES**. `brand_deep_scan` is replaced by Campaign Hunter. |
| 29 | `W/agents/architect/analysis/analyzer.ts:120`, `synthesis/synthesizer.ts:111` | Reachable only from the retired Architect agent (`agents/architect/index.ts`), which `agents/index.ts` does not register | 0 | **DELETE**, along with the dead `architect-analysis` queue |

*Status of the rows above as of 2026-10-02: #1, #3, #4, #6, #8, #13, #18, #27 and #29 are done (see "Status (2026-10-02)"); #10's severity is rule-derived, its prose is not. All other rows are unchanged.*

**Totals.**
- About 8 call sites go to rules. They were about 85% of former call volume and most of the cost.
- About 13 move to Workers AI.
- About 8 stay on Claude: all low-volume, roughly <$5/month at historical rates.

### Side findings (fix regardless of direction)

*Status 2026-10-02: the key-prefix write, the `estimateCost` throw, the Batch API gateway bypass (file deleted) and the outage-alert reach (email + sticky push) are fixed. The stale file-header claims are not.*

- `W/agents/analyst.ts:309` writes the first 8 characters of the API key into `agent_outputs`. Remove it; it is poor secret hygiene.
- `W/lib/budgetManager.ts:48`: `estimateCost` throws on any model missing from its price table. A model swap then silently loses ledger rows, and the outage detector depends on the ledger.
- `W/lib/anthropic-batches.ts:92`: the Batch API bypasses AI Gateway.
- Several file headers claim the global throttle is "automatic" when those files bypass it: `abuse-mailbox-classifier.ts:24`, `alert-ai-judge.ts:28`, `social-ai-assessor.ts:27`.
- **Outage detection did not reach a human.**
  - Flight Control has raised `platform_ai_calls_failing` (21 notifications so far) and `agent_runs` shows `partial` runs.
  - Even so, AI stayed dead for 83 days.
  - The guard fires; nobody is woken by it. Route this alert to email/push, not only to the in-app notification list.

---

## 3. The "token credit system" — diagnosis

| Layer | Where | Problem |
|---|---|---|
| Anthropic prepaid balance | Provider | Hard cliff: at zero, every call returns HTTP 400. This caused the 83-day outage. |
| Monthly $ ceiling | `budget_config` ($150 in prod), `W/lib/budgetManager.ts`, KV `ai:throttle_reason` (`W/lib/haiku.ts:376`) | Measures *our own ledger*, not the real balance: it read `none` while the balance was $0. Only enforced inside the `haiku.ts` helpers; ~20 direct callers bypass it. |
| Per-agent token caps | `W/lib/per-agent-budget.ts:84`, `agent_budget_rollups` | Unregistered agent IDs pass uncapped: `advisories`, `alert_ai_judge`, `abuse_mailbox_deep_analyzer`, `ai-attribution`, `brand-enricher`, `honeypot-generator`. |
| Per-run caps + scattered `checkCostGuard` | Individual agents | Inconsistent; each agent re-implements its own guard. |

There are **no customer-facing AI credits or quotas**; `org_usage_daily` only counts module usage. So "credits" is purely an internal operating problem, which makes it fixable without any pricing change.

---

## 4. Target AI architecture

### 4.1 Three tiers

```
                ┌───────────────────────────────────────────────┐
                │ W/lib/ai.ts  — single provider-agnostic gate  │
                │  task → tier routing · one budget check ·     │
                │  failure_kind + recordAiCall · ledger write   │
                └───────────────┬───────────────────────────────┘
       ┌────────────────────────┼─────────────────────────────┐
  Tier 0: RULES            Tier 1: WORKERS AI            Tier 2: CLAUDE
  (no model call)          env.AI binding                via AI Gateway (BYOK)
  scores, severity,        classify / extract /          narratives, customer-
  attribution, triage,     embed / rerank / vision       facing verdicts, takedown
  correlation, routing     postpaid CF invoice           drafts, agentic loops
                                                         ↳ Dynamic Routing fallback
                                                           → Workers AI open model
```

**Tier 1 — Workers AI** (add an `[ai]` binding in `wrangler.toml`)

| Use | Model (as of Oct 2026) | Price (input / output per M tokens) |
|---|---|---|
| Classification | `@cf/qwen/qwen3-30b-a3b-fp8` (function calling, thinking off) or `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | ~$0.05 / $0.35 |
| Extraction / harder classification | `@cf/openai/gpt-oss-120b` | $0.35 / $0.75 |
| Embeddings | `@cf/baai/bge-m3` | $0.012 |
| Page-screenshot vision (later) | `@cf/google/gemma-4-26b-a4b` | — |

- **Brand inference (#2)** becomes embeddings plus **Vectorize** nearest-neighbour. That is cheaper and more accurate than putting 100 brand names in every prompt.
- **Billing:** Standard billing is **postpaid on the Cloudflare invoice**, so there is no balance to run dry. Free allocation is 10k Neurons/day; beyond that it is $0.011 per 1k Neurons.
- **At former volume** (about 1.7–2.3k calls/day), Tier 1 is roughly **$1–5/month**.
- **Constraint:** JSON mode is *not guaranteed* ("JSON Mode couldn't be met"). Every Tier 1 call must validate against a schema, retry once, then fall back to rules. Add the new failure kinds (429, error 3040 out-of-capacity, JSON-mode failure) to `failure_kind`.

**Tier 2 — Claude**

- **Routing:** through the existing AI Gateway (`averrow-ai-gateway`) with **our own Anthropic key (BYOK)** and the `byok_only` / "Require provider credentials" setting. That avoids silently falling back to Unified Billing credits.
- **Payment:** turn on Anthropic auto-reload, if the console supports it (verify). At <$10/month of Tier 2 volume, a small balance plus auto-reload plus the outage alert is enough.
- **Fallback:** an AI Gateway **Dynamic Routing** route falls back to `gpt-oss-120b` (or `kimi-k2.x` for narrative quality, rate-limited to 20 requests/min) when Claude errors. Narratives then degrade instead of disappearing.
- **Spend cap:** AI Gateway **Spend Limits** (per model/provider, returns 429 over budget) become the hard ceiling. This replaces `budget_config` as the source of truth.

**Why not all Workers AI?**
- Open-model confidence is poorly calibrated, so auto-dismiss (#17) must stay on a frontier model behind evidence.
- Customer-facing prose (#15, #23) carries tone and accuracy risk.
- Multi-step tool loops (#25) need reliable schema-following.
- The frontier open models (Kimi K2.x, DeepSeek-V4) are capped at 20 requests/min. That is fine for a fallback, not for primary bulk work.

**Why not Unified Billing for Claude?** It brings back prepaid credits (5% fee on each top-up) and caps requests at 200 per 60s per gateway. It is only worth it if a single invoice outweighs the credit cliff.

### 4.2 Collapse the budget layers into one gate

- Replace `checkCostGuard`, per-agent token caps, the KV throttle and per-run caps with **one** function in a new `W/lib/ai.ts`, called by every tier.
- `W/lib/ai.ts` does four things: resolve tier → check the per-task budget (a single table) → call → `recordAiCall` + ledger write.
- AI Gateway Spend Limits enforce the provider-side ceiling.
- `budget_ledger` stays as our audit log. It no longer decides whether a call happens.
- Every caller goes through `W/lib/ai.ts`; a lint/test asserts that `callAnthropic` is not imported anywhere else.

---

## 5. Where agentic AI fits

### 5.1 What the current agents actually are

| Kind | Agents |
|---|---|
| (a) Deterministic pipeline | Nexus, Flight Control, Navigator, Cube Healer, most of Sparrow — **the real value** |
| (b) Single LLM call in a cron job | Sentinel, Analyst, Cartographer, Strategist, Observer, Narrator, Attributor, evidence assembler, alert judge |
| (c) Genuinely agentic (multi-step, tool use, decisions) | **Campaign Hunter only** (`W/agents/campaign-hunter.ts`, `W/lib/agent-loop.ts`). Internal route only (`W/index.ts:659`); its tools are read-only DB lookups (`W/lib/hunter-tools.ts`); no eval harness; no UI. |

### 5.2 Where the human time actually goes

On the tenant Intelligence Card (`T/features/alerts/IntelligenceCard.tsx`):
- The **Evidence** tab shows static `alert.details`.
- The **Infrastructure** tab exists only for threat-sourced alerts.
- The **Related** tab only links to "all threats for brand".
- There is **no takedown action**.

So the analyst manually checks whether the site is live, inspects the page safely, runs WHOIS/DNS/certs, finds sibling domains, judges the kit, and then goes to another surface to request removal.

That is exactly the multi-step, tool-using, judgment-at-the-end work agents are good at. Every result also maps to a button that already exists.

### 5.3 Ranked agentic opportunities

| Rank | Opportunity | User outcome (the button) | Tools (existing) | Tier | Trigger | Guardrail |
|---|---|---|---|---|---|---|
| **1** | **Investigate → Evidence Pack** | Pack on the Intelligence Card: live?, redirect chain, page signals, RDAP, DNS, cert, siblings (cluster/sink/registrant), cited verdict. Buttons: **Request takedown**, **Dismiss (reason prefilled)**, **Add siblings to investigation** | `fetchSuspectPage` (`W/lib/page-fetch.ts:881`), `scorePagePhishing` (`W/lib/page-phishing-scorer.ts:209`), `rdapLookup` (`W/lib/whois.ts:49`), `resolveToIP` (`W/lib/dns.ts:23`), hunter tools, `W/lib/cluster-components.ts` | Deterministic collector first; Claude loop **only when ambiguous** (anti-bot wall, conflicting reputation) | On demand, plus auto for high/critical alerts that survive triage | Recommend only; dismissals and takedowns are human-approved. The ≥90 auto-dismiss is re-enabled **only** with a pack attached and after eval (§5.5). |
| **2** | **Takedown pack with live re-verification** | Every takedown re-checks liveness right before sending, attaches page evidence, routes via `evaluateTakedownPolicy` (`W/lib/takedown-policy.ts:132`, stays rules); **Request takedown** available from *every* signal type | Same as #1 plus the evidence assembler | Rules + Claude draft | Pre-send | Existing tenant approval (`T/features/takedowns/TakedownActions.tsx`) + signed authorization |
| **3** | **Campaign Hunter for users** | Campaign dossier → **bulk takedown / watchlist** across siblings. Replaces the legacy `brand_deep_scan` button | Hunter tools + DNS/RDAP/page/cluster | Claude loop | On demand | Org-scoped tools; eval gate before customer auto-runs |
| **4** | **Infra-movement dossier** | When a cluster moves infrastructure (`pivot_detected`, `kind='infra_movement'`): what moved, which tenants are exposed, likely next registrations. **Watch ASNs/domains**, **Notify affected orgs** | SQL fingerprint diff (exists) | Rules + one Claude narrative | Event | Staff review before tenant notify. This is the strongest honest "WHERE they move" product. |
| **5** | **Abuse-reply loop** | Classifies provider replies (resolved / needs-info / rejected), drafts follow-ups with the requested evidence | Takedown thread + evidence pack | Workers AI classify + Claude draft | Inbound reply | A human approves every send |
| **6** | **Weekly "what changed" brief** (not agentic) | Per-tenant deltas, every line deep-linked to a filtered queue. Fulfils the briefing promise | Cubes, `brand_score_snapshots`, takedown metrics | SQL + Workers AI / Claude prose | Weekly cron | Turn on `TENANT_DIGEST_MODE` once quality is reviewed |
| **7** | **Natural-language query over tenant data** | "Ask Averrow" | Parameterized, org-scoped query tools | Claude | On demand | **Last.** Highest cross-org leakage risk. `orgId` always comes from the session, never the model. TrustBot is not safe for tenants as-is (it reads platform-wide tables, `W/agents/trustbot.ts:19-23`). |

### 5.4 Runtime

- Build on what is already proven here: **Cloudflare Workflows + `W/lib/agent-loop.ts`**. The CAMPAIGN_HUNTER Workflow binding already exists.
- Use `step.waitForEvent` for human approval.
- **Adopt the Cloudflare Agents SDK later**, and only if we need per-entity persistent agent state, such as a long-lived "watch this actor" agent with its own schedule. It is model-agnostic and composes with Workflows (`AgentWorkflow`, `waitForApproval`).
- Note that `McpAgent` is deprecated in favour of `createMcpHandler`. That matters if `averrow-mcp` is rebuilt.

### 5.5 Principles for agentic work in Averrow

1. **Evidence first.** Deterministic code collects the evidence; the model chooses what to check next and writes the conclusion. No verdict without a pack, and the verdict cites the pack.
2. **Every output maps to a button.** If no one can act on it, it is a SQL report, not an agent.
3. **Tools are read-only; writes go through existing reviewed paths** (`createAlert`, takedown authorization). Dismissals, outbound sends and actor naming always need a human.
4. **Agents never raise severity or name an actor on their own.** Severity and attribution are rules.
5. **Org scope comes from the session, never from model input.** Page and email content is untrusted data and must be treated as a prompt-injection risk.
6. **Cost per insight is tracked.** Workers AI by default, Claude only for loops and narrative; turn caps; the `agent_configs.enabled` kill-switch.
7. **Eval harness before autonomy.** Build labelled sets from historical alert dispositions and takedown outcomes, and measure the **false-safe rate** before any automatic action. Shadow-run Workers AI against the last known Haiku outputs before cutover.
8. **Show the work.** The full tool trail is persisted and visible to the user.
9. **Measure consumption.** `agent_outputs` has no viewed/acted columns today, so nobody can tell whether AI output is read. Every agentic surface logs view → action.

---

## 6. Outcome layer (non-AI, but it is what makes AI worth anything)

These come before or alongside agentic work, because they are what a customer pays for:

1. **"Value delivered" panel** on the tenant home: auto-triaged alerts, takedowns completed, median time-to-removal, exposure trend. The data already exists in `W/lib/takedown-metrics.ts`, `alerts.resolution_notes` and `brand_score_snapshots`.
2. **Request takedown from any signal type**, not just lookalikes.
3. **Apply custom monitoring rules**, or stop selling them.
4. **Align pricing copy with plan entitlements** — one source of truth.
5. **Instrument consumption** (view/act) on every insight surface.

---

## 7. Phased plan

| Phase | Scope | Owner(s) | Exit criteria |
|---|---|---|---|
| **P0 — Stop the bleeding** (days) | Remove the API-key prefix write (`analyst.ts:309`); fix the `estimateCost` throw; route `platform_ai_calls_failing` to email/push; **decide** whether to top up Anthropic now (§8.1) | backend-engineer, platform-sre | The outage alert reaches a human; no secrets in `agent_outputs` |
| **P1 — Rip to rules** | Make the existing fallbacks the primary path for #1, #3, #4, #6, #8, #13, #18, #27; delete #29 and the dead queue; derive Narrator severity from rules | backend-engineer, threat-intel-analyst, test-engineer | Those call sites make no AI calls; tests pin rule outputs |
| **P2 — `lib/ai.ts` + Workers AI** | Add the `[ai]` binding; build the single gate; move the Tier 1 sites; Vectorize brand inference; shadow eval vs. last Haiku labels; collapse the budget layers; AI Gateway spend limits + Dynamic Routing fallback; BYOK Claude for Tier 2 | backend-engineer, qa-verifier, appsec-reviewer | Agreement ≥ the agreed bar on the labelled set; nothing imports `callAnthropic` outside `ai.ts`; `ai_health` green |
| **P3 — Outcome layer** | §6 items 1, 2, 5 | frontend-engineer, backend-engineer, design-reviewer | Tenants see value delivered; takedown can be requested from any signal |
| **P4 — Evidence Pack agent** | Opportunity #1 + #2; eval harness; re-gate the AI judge behind the pack | backend-engineer, threat-intel-analyst, frontend-engineer, test-engineer, appsec-reviewer | False-safe rate measured; analyst time per signal measured |
| **P5 — Campaign Hunter for users + infra-movement dossier** | Opportunities #3, #4; retire `brand_deep_scan` | same | Dossier → bulk action used by ≥1 tenant |
| **P6 — Briefs, abuse-reply loop, then NL query** | Opportunities #5, #6, then #7 | same + content-strategist | Digest on; reply loop human-approved |

---

## 8. Open owner decisions

1. **Top up Anthropic now, or run rules-only until P2?** Recommendation: **don't top up for bulk work.** P1 makes it unnecessary. Add a small balance with auto-reload only when the Tier 2 uses are rewired through BYOK in P2. Until then, the four customer-facing Claude uses stay on their fallbacks: abuse-mailbox verdict (#15), deep analyzer (#16), evidence-assembler drafts (#23) and narratives (#9/#10).
2. **Positioning.** CLAUDE.md §13 still says "identify WHO". Either re-anchor the copy to "detect, correlate, remove — and show where operators move" (honest today), or invest in specific-evidence attribution (P5 dossier). This doc deliberately does not edit §13.
3. **Show takedown metrics to customers?** Recommendation: yes. It is the category's main proof point.
4. **Pricing alignment** (Abuse Mailbox tier, App Store on Professional, "custom monitoring rules", "daily briefings").
5. **Quality bar for the Workers AI cutover** — e.g. ≥95% agreement with the last Haiku labels on classification tasks, measured in shadow.

---

## Appendix A — Live evidence (read-only production queries, 2026-10-01)

- **Ledger:** `budget_ledger` last row was 2026-07-10 11:10 UTC; there are 0 rows in the last 30 days. `agent_runs` error messages in the last 7 days contain no "credit"/"Anthropic" strings, so the failure is invisible in run logs.

**Monthly AI spend** (`agent_budget_rollups`, all Haiku):

| Month | Spend | Calls |
|---|---|---|
| 2026-04 | $122.73 | 94.9K |
| 2026-05 | $142.66 | 116K |
| 2026-06 | $71.50 | 45.5K |
| 2026-07 (to the 10th) | $20.06 | 13.1K |

**Spend by agent, final window before the outage:**

| Agent | Share of spend |
|---|---|
| Cartographer | 66% |
| Analyst | 24% |
| Sentinel | ~2% |

The attributor made 1,584 calls averaging about 4 output tokens each.

**Alerts, last 90 days:**
- 3,435 alerts; 3,405 are still `new` (about 99% unactioned).
- 12 have `ai_assessment` set; 0 were dismissed by the AI judge; 18 were dismissed by rules.
- The backlog is a human-workflow problem, not an AI problem. That is why §5 targets the per-signal workflow.

**AI output volume, last 30 days (`agent_outputs`):**
- About 33K rows in total, dominated by Navigator diagnostics.
- AI-agent insight rows are now produced by the rule-based fallbacks.
- There are no viewed/ack columns, so consumption cannot be measured.

**`wrangler.toml` (Cloudflare bindings):**
- 5 Workflows, 2 Durable Objects, 4 D1 databases, KV, R2, Analytics Engine.
- No `[ai]` binding and no Vectorize.
- AI Gateway is used by URL only, when `CF_ACCOUNT_ID` is set.

## Appendix B — Cloudflare / Anthropic pricing reference (Oct 2026)

| Model | $/M input | $/M output | ≈100k short calls/day* |
|---|---|---|---|
| Workers AI `granite-4.0-h-micro` | 0.017 | 0.112 | ~$1.2/day |
| Workers AI `llama-3.1-8b-fp8-fast` | 0.045 | 0.384 | ~$3.7/day |
| Workers AI `qwen3-30b-a3b-fp8` | 0.051 | 0.335 | ~$3.7/day |
| Workers AI `gpt-oss-120b` | 0.35 | 0.75 | ~$18/day |
| Workers AI `bge-m3` (embeddings) | 0.012 | — | ~$0.24/day |
| Claude Haiku 4.5 | 1.00 | 5.00 | ~$65/day (~$33 with Batch API) |
| Claude Sonnet 5.5 | 2.00 | 10.00 | ~$130/day |

\*400 input + 50 output tokens per call. Sources: developers.cloudflare.com/workers-ai/platform/pricing, claude.com/pricing, and the AI Gateway docs (unified billing, dynamic routing, spend limits, require-provider-credentials, Sep 2026). Re-verify prices before committing to a budget.
