# AI Spend & Outstanding Items — Handoff, 2026-10-01

Session handoff, not a standing spec. Everything below was measured against
production D1 or verified in the code on 2026-10-01; figures will drift.
Written after the AI-silence fix shipped (PRs #1730, #1731) so a follow-up
session on AI cost strategy starts from facts rather than assumptions.

Companion standing docs: `CLAUDE.md` §6 ("AI-call health"), §10 (`ai_health`),
§13 (the SQL-vs-AI doctrine), and `docs/DEPLOYMENT.md` (0272 deploy order).

> **Superseded in part (2026-10-02).** AI_STRATEGY Phase 0/1 changed several
> items below: the Batch API path is deleted (`lib/anthropic-batches.ts` and
> `lib/cartographer-batch.ts` no longer exist, so Batch-API cost ideas are moot);
> `platform_ai_calls_failing` stays severity `high` (it now also emails once per
> UTC day and pushes sticky, but is deliberately not `critical`); production runs
> `AI_MODE = "rules_only"` instead of waiting on a top-up; and Cloudflare Unified
> Billing is deferred to Phase 2 per `docs/AI_STRATEGY_2026-10.md` §4.1. Sentinel
> and cartographer no longer call AI, so only analyst emits the `aiCalls*`
> counters. Read `docs/AI_STRATEGY_2026-10.md` "Status (2026-10-02)" first.

---

## 1. State as of this handoff

| | |
|---|---|
| Open PRs | none |
| Migrations applied in prod | through **0272** (0267–0272 all applied) |
| `platform_ai_calls_failing` raised | **21** — the new detector is live and firing |
| `budget_ledger` rows in last 7 days | **0** — AI is still down |
| Last successful AI call | **2026-07-10 11:10:20 UTC** |

The AI-silence fix is fully deployed and working. The underlying cause — an
unpaid Anthropic bill — is unchanged. Detection is not restoration.

---

## 2. The central finding: the platform has run without AI for ~3 months

Since the last successful call on 2026-07-10, with **zero AI calls**:

| Metric | Value |
|---|---|
| Threats ingested | 549,610 |
| Threats classified (non-null, non-`unknown` type) | **549,610 — 100%** |
| Providers scored | 712 |
| Alerts raised | 3,350 |

Carried entirely by the rule-based fallbacks: `ruleBasedClassify`
(`agents/sentinel.ts:837`) and `computeHeuristicScore`
(`agents/cartographer.ts:1304`).

Brand matching — the thing analyst spent Haiku tokens on:

| Era | Threats | Brand-matched |
|---|---|---|
| While AI worked (Apr 1 – Jul 10) | 580,204 | 69.5% |
| Since AI died (Jul 10 – Oct 1) | 549,610 | **84.5%** |

**This is correlational, not causal.** The brand catalog grew and the keyword
pre-match path changed in the same window, so it does *not* establish that AI
hurt brand matching. What it does establish: **the measurable output never
degraded.** Nobody noticed the outage for three months because, on these
metrics, there was nothing to notice.

Read alongside `CLAUDE.md` §13: *"never pay AI tokens to do what `GROUP BY` can
do in 50ms."* The code had drifted from the platform's own doctrine, and the
outage incidentally tested it.

**Caveat before acting on this.** "Classified" is not "classified as well."
Feeds supply a `threat_type` and the rules map feed → type + confidence; the AI
was adding confidence/severity refinement and brand inference. Quality
equivalence is **not** demonstrated by the table above and would need an eval
over a labelled sample.

---

## 3. What AI actually cost

Lifetime `budget_ledger`, by model:

| Model | Calls | Cost | Share |
|---|---|---|---|
| `claude-haiku-4-5` | 269,661 | **$356.81** | ~100% |
| `claude-sonnet-4-5` | 22 | $0.14 | 0% |

The platform was already ~100% Haiku. There is no Sonnet spend to cut.

Monthly: **$122.73** (Apr) · **$142.66** (May) · **$71.50** (Jun) · **$20.06**
(Jul, partial) against a configured `budget_config.monthly_limit_usd` of **$150**.

By agent (lifetime), top three are 94% of spend:

| Agent | Calls | Cost | Share |
|---|---|---|---|
| cartographer | 122,112 | $221.45 | 62% |
| analyst | 74,880 | $63.05 | 17.7% |
| sentinel | 43,794 | $50.50 | 14.1% |

**76% of the entire bill is output tokens.** Haiku bills output at 5× input
($1/$5 per MTok), and these agents emit JSON with prose fields. Per-agent output
share: cartographer 81%, sentinel 82.5%, analyst 61%.

A cost-reduction track already ran and worked: sentinel went from 207 output
tokens/call and $25.55/mo to 36 and under $1/mo. Cartographer's cost per
*provider scored* roughly halved ($0.00144 → $0.00079); its rising
output-per-call (240 → 600) is the 5-at-a-time batching lever, not a regression.

---

## 4. Options for AI without an Anthropic API-key balance

Rates below were read from vendor docs on 2026-10-01. **Re-verify before
committing** — never answer pricing from memory.

### Cloudflare Workers AI — not wired at all
`env.AI` binding, no API key, no second vendor. Verified absent: no `[ai]`
block in `packages/averrow-worker/wrangler.toml`, no `env.AI` usage anywhere in
`src/`. **$0.011 per 1,000 Neurons; 10,000 Neurons/day free on both Free and
Paid plans**; Workers Paid is $5/mo minimum. Open models available without a
paid-only gate include `@cf/zai-org/glm-4.7-flash`,
`@cf/google/gemma-4-26b-a4b-it`, `@cf/nvidia/nemotron-3-120b-a12b`.

### AI Gateway Unified Billing — likely the highest-value single change
The worker **already** routes through `averrow-ai-gateway` (see `resolveBaseUrl`
in `lib/anthropic.ts`). Cloudflare allows prepaid credits on the Cloudflare bill
to pay for both Anthropic and Workers AI inference: **provider rates passed
through with no markup, plus a 5% fee on credit purchases.** One vendor, one
bill, one balance to keep funded — which is precisely the failure mode that cost
three months. This is a gateway config change, not an integration.

### Bedrock / Vertex AI — the credits angle
Claude is available on both, partner-operated with their own pricing. The reason
to care is not the rate: **AWS Activate / Google for Startups credits can pay
for Claude inference.**

### Other open-model hosts
Groq, Together, Fireworks, OpenRouter — cheaper per token than Haiku, but still
an API key and still per-token. Only worth it if Workers AI's catalog doesn't fit.

### What is NOT an option
- There are no model-specific credits. API credits are a single account balance
  covering every model; that is why the failure reads *"Your credit balance is
  too low to access the Anthropic API."*
- A Claude.ai Pro/Max subscription grants no API access and cannot power
  `callAnthropic`.

---

## 5. Levers already in the codebase but unexploited

| Lever | State |
|---|---|
| **Batch API** (Lever #6) — 50% off input *and* output | `lib/cartographer-batch.ts`, wired via dynamic import at `agents/cartographer.ts:240`. Merged **2026-07-19**, nine days after credit ran out, so it **has never billed a call.** Covers cartographer's provider scoring — the largest line item. |
| **Prompt caching** (`cacheSystem`) | Set at exactly one call site: `lib/agent-loop.ts:97` (campaign-hunter, 0% of spend). Low value here regardless: it discounts input only (24% of the bill), and Haiku's cache TTL is 5 minutes against cartographer's hourly cadence — cold every run. |
| **Conditional verbosity / batching** (Levers #1, #1b) | Already applied; see §3 for measured effect. |

---

## 6. Decisions awaiting the user

1. **Drop the `notifications.type` CHECK?** It duplicates `KNOWN_EVENT_KEYS`
   (`lib/notifications.ts:39`), which already derives from the shared registry,
   so `createNotification` validates in application code *before* the INSERT.
   A hand-maintained second copy of a list that already has one source of truth
   has now drifted **four times** (migrations 0207, 0215, 0265, 0272). Dropping
   it ends the class permanently.
2. **`idx_notifications_user` / `idx_notifications_created`** — last defined in
   migration 0107; the table has been rebuilt four times since without
   recreating them, so they have been **absent from prod since 0186/0207**.
   Restore, or formally accept their loss? (`idx_notifications_user(user_id,
   read_at)` is largely superseded now the schema uses `state`, not `read_at`.)
3. **`platform_ai_calls_failing` severity** — currently `high`. `critical` would
   auto-create an incident, which surfaces on the **public** `/status` page. One
   word in `lib/platform-templates.ts`.

---

## 7. Known defects — flagged, deliberately unfixed

| # | Defect | Notes |
|---|---|---|
| 1 | Five OSINT feeds (`mastodon`/`reddit`/`github`/`telegram`/`hibp`) + `lib/brand-scoring.ts` still filter `monitoring_status='active'` | They run against **359 brands instead of 1,864**. Latent bug, not policy — see `CLAUDE.md` §8. |
| 2 | Lookalike alerts have **no auto-triage path at all** | Spec §11.1. Raised twice, never resolved. Recommendation was a keep-only decider (Lane 3 may withhold or raise, never auto-dismiss). |
| 3 | `checkDomain` never queries AAAA | An IPv6-only squat reads as unregistered. Inert today (`verification_status` has zero readers); becomes a customer-visible false "down" the moment anything reads it. |
| 4 | A capped or failed Haiku call retries only on the row's next **transition** | For a stable row, possibly never. Fixing the dispatch opens a new spend surface. |
| 5 | An AI outage manufactures HIGH lookalike alerts | A Haiku throw leaves the level at MEDIUM, which the mail+web boost lifts. Deliberate: visible failure over silent miss, now counted on `agent_runs`. |
| 6 | Lookalike caps unmoved (`LOOKALIKE_BATCH_LIMIT` 50 etc.) | ~47-day re-check cadence over ~56,010 rows. Accepted interim state with three documented preconditions — see `lib/monitored-brands.ts`. |
| 7 | No migration creates `threat_briefings` | The table **does** exist in prod (created out-of-band) and `handlers/briefing.ts` INSERTs into it, so this is a fresh-environment reproducibility gap, not a live bug. |
| 8 | Analyst's optional correlation tables untested | social / dark-web / app-store / geopolitical phases are each individually `try`-wrapped, so their SQL is uncovered by `test/analyst-ai-counters.test.ts`. |

---

## 8. Recommendation for the follow-up session

Split the workload by what it actually needs, rather than restoring the Haiku
path as it was:

- **Classification and provider scoring** → Workers AI, or leave on rules.
  Three months of production data says the rules hold. Prove it with an eval
  over a labelled sample before committing either way (see the §2 caveat).
- **Work rules genuinely cannot do** — threat-actor narratives, cluster briefs,
  the Tier-3 alert judge — keep on Claude, paid through AI Gateway Unified
  Billing so it sits on the Cloudflare bill.
- **Turn on the Batch API path** that already exists and has never run.

Open models on Workers AI are not Haiku. For scoring against a confidence
threshold they are plausibly adequate; for Sonnet-tier narrative work they are
likely not. That is measurable, and worth measuring before moving anything a
customer reads.
