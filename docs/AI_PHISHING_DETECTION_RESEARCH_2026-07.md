# Detecting AI-Generated Phishing & Attacks — Research Assessment — July 2026

**Scope:** Research-only assessment (no implementation) of how Averrow could
detect AI-generated phishing and attacks, and which techniques are worth
pursuing. Every candidate technique is evaluated against three axes: (1) what
the published evidence actually supports, (2) what data Averrow already
captures, and (3) the platform's cost doctrine ("SQL does correlation, AI does
narrative"; Haiku for classification; per-agent budgets via `lib/anthropic.ts`).

**Method:** Three parallel lenses, findings synthesized here:

1. Code-level inventory of Averrow's existing detection pipeline, content
   capture, and dormant AI-phishing plumbing (every claim traced to a file).
2. External state-of-the-art sweep (2024–2026): academic literature, vendor
   technical publications, threat-landscape reports.
3. Competitive/market sweep: what the ten nearest DRP competitors claim vs.
   what they demonstrably do.

**Relationship to prior docs:** This document **is** the research item listed
in `TECHNICAL_ROADMAP.md` (Emerging-tech priority 4: "AI-powered detection of
AI-generated phishing attacks — Research") and answers the gap named in
`docs/CATEGORY_RESEARCH.md` §3.7 ("AI-generated content detection"). It
supersedes the retired "AI DETECTOR" agent sketch in
`docs/archive/AVERROW_MASTER_PLAN_2026-03.md` (§ "AI DETECTOR", Haiku
per-email classification into `AI_TEMPLATED | AI_PERSONALIZED | AI_DEEPFAKE |
HUMAN_OPERATED`) — the evidence below argues that per-message design is the
wrong unit of detection. Companion context: `docs/IMPROVEMENT_PLAN_2026-07.md`
S2.4 (detection-depth lanes D2/D3/D6 referenced throughout).

**Source caveat:** the external sweep ran under an egress policy that blocked
most primary fetches (arxiv.org, vendor blogs). Numbers cited from external
sources came via search-result summaries and should be re-verified against
the primary PDFs before any of them becomes load-bearing (a follow-up list is
in §9). Internal file/line citations were verified directly.

---

## 1. Executive summary

**The headline finding is negative, and it is the most valuable one: do not
build per-message "was this text written by an AI?" detection.** Published
detectors need ~100–120+ words to work at all — phishing lures run 30–80 —
and their dominant false-positive mode is a documented ~61% FP rate against
non-native English writers (Liang et al. 2023, *Patterns*). Trivial attacker
config changes (sampling strategy, repetition penalty) defeat them (RAID, ACL
2024), watermarks don't survive paraphrase and adversaries use unwatermarked
open-weight models anyway, and C2PA-style provenance only binds honest
participants. Any per-message `ai_generated_probability` Averrow emitted
would be a liability: discriminatory FP profile, adversarially fragile, and
unpublishable methodology.

**What the evidence does support is moving the unit of detection from the
message to the campaign and the infrastructure.** Five techniques survive
scrutiny, in descending order of fit:

| # | Technique | Verdict | Cost profile | Fit with existing plumbing |
|---|---|---|---|---|
| 1 | **Campaign-level polymorphism ratio** — low lexical similarity + high semantic similarity + shared infrastructure + tight time window | Strongest defensible "AI at work" signal; needs in-house validation (no published benchmark exists) | SQL + hashing first; small-model calls only at cluster boundaries | `spam_trap_captures` bodies, `template_hash`/`sentence_structure_variance` columns already exist in `phishing_pattern_signals` |
| 2 | **Phantom-squat watchlist** — pre-enumerate the domains LLMs *hallucinate* for a brand, watch registration/CT for hits | Predictive (18–51 day lead per Unit 42), differentiated, cheap | One-time Haiku enumeration per brand + zero-cost matching | Lookalike scanner, CT monitor, NRD feed all exist |
| 3 | **Velocity & discontinuity signatures** — registration→cert→attack speed; abrupt fingerprint changes on aged infrastructure | Durable (domain *age* is now purchasable; the *discontinuity* isn't) | Pure SQL over data already captured | `domain_age_days` (0239), cert identity (0234), NEXUS infra-movement pivots (D5b) already live |
| 4 | **Cloaking-as-signal** — treat CAPTCHA/Turnstile/redirect walls seen by the page fetcher as first-class evidence | Fixes a live silent-false-negative today | Near-zero (extend existing parser) | `lib/page-fetch.ts` + `lib/page-phishing-scorer.ts` |
| 5 | **Campaign-scoped AI-generation assessment (Haiku judge)** — metadata/narrative only, never a triage gate | Viable *only* at campaign level with calibration discipline | Bounded Haiku, per-campaign not per-message | Alert AI-judge pattern (`lib/alert-ai-judge.ts`) is the template |

**The plumbing for all of this already half-exists and is dormant.** Migration
0023 created `phishing_pattern_signals` — with `ai_generated_probability`,
`template_hash`, `sentence_structure_variance`, `fluency_score` columns —
explicitly "for training data." It has never been written to. Two consumers
already read it: `src/brand-threat-correlator.ts` (+15 brand risk, an
"AI-generated content" technique tag) and `src/agents/analyst.ts:614-627`
(an "AI-Generated Threat Detected" insight at severity `high`), and the ops
UI label exists (`ScoreBreakdownCard.tsx`: `'AI-generated phishing'`). The
read queries contain three column-name bugs silently swallowed by `.catch()`
(§7.1), so even a writer wouldn't light them up today.

**Competitively, this is white space.** Every DRP peer markets "AI-generated
attack detection"; none publishes real technique for text, and none surfaces
a customer-visible AI-generation attribute on individual threats. A
*campaign-level* claim ("AI-polymorphic campaign", with a publishable
methodology) is both more honest and more defensible than the per-message
claim nobody can substantiate (§6).

---

## 2. Threat landscape: what actually changed (2024–2026)

### 2.1 Quality and targeting, not volume

The credible evidence says AI made phishing *cheaper, better-targeted, and
faster-iterating* — not more voluminous:

- APWG counted ~3.8M phishing attacks in 2025 vs ~3.76M in 2024 —
  essentially flat. Q1 2026: 971K, +13.8% QoQ. No volume explosion.
- FBI IC3 2025: of ~$3.05B in BEC losses, only ~$30M (~1%) carried a
  *confirmed* AI nexus (victim-reported; a floor, not a ceiling).
- Controlled human-subject studies are the alarming part:
  - Heiding et al. (arXiv 2412.00586): fully-AI-automated spear phishing
    matched human experts (54% vs 54% click-through, vs 12% control) at ~92%
    less effort.
  - Czybik et al., TU Berlin, USENIX Security 2026 (n=7,700 — the largest):
    LLM **personalization** ~triples click rate; **generic LLM text performs
    the same as generic human text**. Personalization cost ≈ $0.03/email.

That second result is the strategic pivot for detection design: **the
attacker's edge is automated per-target OSINT and personalization, not prose
quality.** "Does this read like an LLM wrote it?" chases the wrong variable.
The exploitable traces are *behavioral and volumetric* — scale, speed,
coordination — not stylistic.

### 2.2 LLM capability is now a phishing-kit feature

The Darcula/"Magic Cat" PhaaS suite auto-clones any brand site from a URL
(Puppeteer) and, since April 2025, uses generative AI to produce phishing
forms in any language and auto-translate existing kits. This is the
structural change that matters: LLM capability propagates to low-skill
operators through kits, so per-actor sophistication is no longer a useful
prior. Google GTIG and OpenAI's disruption reports both characterize
adversarial AI use as "evolution not revolution" — actors bolting AI onto
existing playbooks to move faster; GTIG's Nov 2025 tracker documents the
first runtime-LLM malware (PROMPTFLUX rewriting its own obfuscation hourly).

### 2.3 The base-rate credibility trap

Published "share of phishing that is AI-generated" estimates span two orders
of magnitude — IC3's ~1% (confirmed nexus) to Hoxhunt's 56% (undisclosed
"surface-level indicators" heuristic) to the endlessly recycled "82.6%"
(traced by our competitive sweep to KnowBe4's 2025 Phishing Threat Trends
Report, then re-cited by vendors as if it were their own telemetry; provenance
contested). The 1,200%+ "AI phishing surge" figures circulating in 2026
content-farm posts trace to vendor press releases with no methodology.

**Standing guidance for Averrow:** never quote these numbers in product or
marketing copy, and if Averrow ever emits an AI-generation metric to
customers, the methodology must be publishable — otherwise it inherits this
credibility problem. (Flagged for `content-strategist` awareness; the
platform currently makes no such claims.)

---

## 3. Technique assessments

Each technique is rated on signal quality (what the evidence supports),
false-positive risk, cost under the platform doctrine, and fit with data
Averrow already captures (inventory in §5).

### 3.1 Per-message machine-generated-text (MGT) detection — REJECT

The clearest negative result in the literature:

- **Length floor.** Statistical and fine-tuned detectors need ~120 words to
  approach their potential and ~200 to reliably detect strong models;
  confidence intervals are "too wide to be useful" under 100 words. Phishing
  lure bodies run 30–80 words — below the floor. Headline results
  (e.g. Binoculars' ">90% @ 0.01% FPR", ICML 2024) are document-scale and
  English-biased.
- **Discriminatory FP profile.** Liang et al. 2023 (*Patterns*): seven
  commercial GPT detectors averaged a **61.22% false-positive rate on
  TOEFL essays by non-native English speakers** (97.8% flagged by at least
  one detector) while near-perfect on native 8th-grade writing. Mechanism:
  non-native writing genuinely has lower perplexity/lexical variety.
  A perplexity-based "AI-written" score is functionally a
  non-native-speaker detector — unacceptable in a triage path, and
  *pre-inverted* versus the historical signal (bad grammar used to mean
  phish; now fluent-but-simple text trips the flag).
- **Adversarial fragility.** RAID (ACL 2024; 6M+ generations, 11 detectors):
  detection degrades under mere *config changes* (sampling strategy,
  repetition penalty), before any deliberate attack; paraphrase attacks cost
  8–15 F1.
- **Watermarking/provenance don't apply.** SynthID-class watermarks are
  scrubbable by paraphrase, absent from the open-weight models adversaries
  control, and physically uncarryable in short text. C2PA v2.3 added text
  manifests, but adversaries simply don't attach one — absence proves
  nothing. Provenance binds honest participants only.

**Verdict:** never build a per-message AI/not-AI verdict, and never let any
AI-generation estimate gate `lib/alert-triage.ts` dismissals or
`lib/alert-ai-judge.ts` auto-dismissals. The dormant
`phishing_pattern_signals.ai_generated_probability` column should only ever
be populated by campaign-level methods (§3.2/§3.6), not per-message scoring.

### 3.2 Campaign-level polymorphism analysis — STRONGEST FIT

If AI-generation is observable anywhere, it is in campaign *structure*: a
human operator cannot write 5,000 distinct-but-equivalent lures. The
discriminating combination is:

> **low lexical similarity + high semantic similarity + shared
> infrastructure + tight time window**

- Classic kit: high lexical + high semantic similarity (template reuse).
- Mail-merge: high lexical similarity with low-entropy variable slots.
- **LLM polymorphism: many unique surface texts, one intent, same
  infrastructure.** No human process produces this at volume.

Honest caveat: this exact ratio is *asserted but not benchmarked* anywhere in
the published literature — it is the logical synthesis of the clustering
work, and would need in-house validation on spam-trap/abuse-mailbox corpora
before any customer-facing claim.

Technique notes from the literature:

- **Lexical hashing (SimHash/MinHash) is necessary but insufficient.** These
  detect near-duplicates; genuine LLM rewrites share almost no shingles by
  construction. They still earn their keep by cheaply carving out the
  *templated* (non-AI) mass, leaving a residual for semantic comparison.
  `phishing_pattern_signals.template_hash` and `template_detected` are the
  natural landing columns.
- **Semantic similarity needs embeddings or a model.** Averrow currently has
  no embedding capability (no Workers AI binding, no embedding library —
  verified). Options, in cost order: (a) Workers AI embedding model behind a
  new binding, (b) Anthropic via the existing `lib/anthropic.ts` choke point
  used pairwise at cluster boundaries only, (c) deterministic proxies first
  (normalized intent keywords, structure skeletons) to defer the decision.
- **The right cost architecture is published** (TIBlender pattern, arXiv
  2606.04580): deterministic clustering does the heavy lifting; an LLM is
  invoked *only to split ambiguous over-merged clusters*. This maps exactly
  onto "SQL does correlation, AI does narrative" and a Haiku budget.
- **Calibration, not retraining, is the maintenance burden.** The most
  operationally useful external finding (Frontiers in Big Data 2026,
  cross-generator evaluation): under generator shift, AUC survives but
  thresholds collapse, and **recalibrating thresholds on a small labeled
  slice recovers ~86% of the gap**. Detector upkeep = a small labeled set +
  periodic threshold refresh, not model retraining. Cheap, and it fits a
  platform with human analysts in the loop.

**Data Averrow already holds for this:** `spam_trap_captures.body_preview` +
`raw_headers` + sender infra columns; `abuse_inbox_messages.raw_body`
(≤256KB) + `extracted_urls`; campaign groupings (`campaigns`,
`threats.campaign_id`, `infrastructure_clusters` + S2.4/D5a component IDs).
The unit "campaign with shared infrastructure" already exists — what's
missing is the text-variance measurement over its members.

### 3.3 Phantom-squat watchlist (AI-hallucinated domains) — HIGH VALUE, CHEAP

Unit 42 (June/July 2026, "phantom squatting"): LLMs *hallucinate* plausible
domains for a brand (913 brands, 685K prompts → 809K non-existent domains;
13K later independently flagged malicious; ~250K still unregistered), and —
critically — **different models independently hallucinate the same fake
domain for the same query**, because the names come from shared linguistic
priors. Observed lead time between "hallucination enumerable" and "adversary
registers it": **18–51 days**.

This inverts the usual posture: instead of detecting the attacker's LLM
output, exploit LLM determinism *against* the attacker by enumerating the
hallucination surface per brand **before registration**, then watching for
hits. It is also a defensible data asset (a per-brand phantom watchlist)
rather than a fragile classifier.

**Fit:** unusually good. Averrow already runs the three matchers the
watchlist needs: the NRD feed (`feeds/nrd_hagezi.ts`), CT monitoring
(CertStream Durable Object + `ct_certificates`), and the lookalike scanner
(`scanners/lookalike-domains.ts`, dnstwist permutations). A phantom
watchlist is one Haiku-tier enumeration pass per brand (bounded, cacheable,
refreshed rarely) plus zero-cost joins against feeds already flowing. Note
the adjacent supply-chain variant ("slopsquatting") is out of Averrow's scope.

### 3.4 Infrastructure velocity & discontinuity signatures — GOOD FIT, PURE SQL

AI-scaled operations leave volumetric/temporal traces:

- **Registration→weaponization velocity.** The standard hostile timeline is
  registration → Let's Encrypt cert within minutes → live lure within hours.
  Averrow captures the pieces (`threats.domain_created_at`/`domain_age_days`
  from migration 0239; CT issuance timestamps; `first_seen`) but does not
  currently compute the *deltas* between them as a signal.
- **Domain age is a depreciating feature.** Operators now buy aged domains
  with years of clean cert cadence specifically to defeat age/reputation
  scoring. The durable signal is the **discontinuity** — a stable multi-year
  fingerprint (ASN, cert issuer cadence, content) that abruptly changes.
  Averrow's S2.4/D5b infra-movement pivot (`lib/cluster-infra-movement.ts`:
  bridge-kind clusters gaining new IPs/ASNs/cert-serials vs their prior-run
  fingerprint → `pivot_detected` → Observer) is *already* discontinuity
  detection at cluster grain; the research direction is extending the same
  idea to single-domain grain (aged domain suddenly re-certed/re-hosted).
- **LLM-named domains defeat entropy-based DGA detection** by being
  semantically plausible. Averrow doesn't rely on character-entropy scoring
  (`RANDOM_DOMAIN_PATTERN` in `lib/threatScoring.ts` is a minor modifier),
  so exposure is low; noted so nobody builds new entropy heuristics.

### 3.5 Page-side signals — TWO CHEAP WINS, ONE DEFERRED LANE

- **Cloaking-as-signal (cheap win, fixes a live silent FN).** Industry
  reporting (Push Security 2025) puts custom-CAPTCHA/Cloudflare-Turnstile
  walls on essentially *every* current phishing page, precisely to blind
  crawlers. Averrow's `lib/page-fetch.ts` is a plain HTTP fetcher; a walled
  page returns a 200 with benign interstitial HTML and scores low — a
  **silent false negative** (verified: the scorer's only cloaking signal is
  `cloaking_redirect`, a meta-refresh/JS redirect to the real brand; no
  bot-wall detection exists). Detecting the wall itself (Turnstile/CAPTCHA
  markers, challenge scripts, redirect-wall patterns) is deterministic
  HTMLRewriter work, and *the presence of anti-bot cloaking on a
  newly-registered lookalike is itself strong evidence*. Should also be
  instrumented as a fetch-outcome rate so blind-spot growth is measurable.
- **AI-code artifacts in payloads (cheap win).** The best-documented public
  detection of an AI-obfuscated campaign (Microsoft, Sept 2025) keyed on
  *synthetic code artifacts*: verbose descriptive-plus-hex variable names,
  over-modular structure, formulaic obfuscation, business-jargon padding,
  SVG-disguised-as-PDF payloads ("not something a human would typically
  write… complexity, verbosity, and lack of practical utility"). Code tells
  are far more tractable than prose tells. Deterministic versions (SVG with
  script content, verbose-generated-obfuscation heuristics) could join
  `page-phishing-scorer.ts` signals and abuse-mailbox attachment handling.
- **Structural page fingerprinting (deferred lane, real payoff).** DOM-graph
  similarity decisively beats content hashing for kit clustering (92.5%
  accuracy vs MD5's F1≈0.40 in the cited homology work) and survives the
  cosmetic churn AI cloning produces; JS-capability clustering (browser APIs
  exercised) resists source obfuscation entirely. Both need richer capture
  than `page_content_hash` (SHA-256 of the raw HTML — verified exact-match
  only). This is the already-deferred D6/D2 territory
  (`IMPROVEMENT_PLAN_2026-07.md`): favicon hashing (D2) and any
  screenshot/visual lane (D6, needs a Browser Rendering binding) are
  prerequisites Averrow has consciously postponed. The research adds one
  nuance: when D6 is revisited, prefer DOM-structure/JS-capability
  fingerprints over visual hashes — they're cheaper than rendering and
  better evidenced.

### 3.6 LLM-as-judge — VIABLE FOR PHISHING, CAMPAIGN-ONLY FOR "AI-NESS"

Two distinct uses, opposite verdicts:

- **"Is this phishing?"** — well supported (>90% accuracy across GPT-4o /
  Claude Sonnet-class judges in recent evaluations) and Averrow already does
  it well within budget (`lib/abuse-mailbox-classifier.ts`, `lib/haiku.ts
  classifyThreat`, `lib/alert-ai-judge.ts`). One hardening note from the
  literature: **the email body is attacker-controlled input to the judge** —
  prompt-injection against classification prompts is demonstrated. Existing
  prompts should treat body text as data (delimiting, instruction to ignore
  embedded directives); worth an `appsec-reviewer` pass at build time.
- **"Was this AI-generated?"** — no strong published support at email length
  (inherits every §3.1 problem). The only defensible framing is
  **campaign-scoped**: given a cluster (N members, shared infra, measured
  lexical/semantic variance from §3.2), a Haiku judge assesses generation
  *mode* — the retired AI-DETECTOR taxonomy (`AI_TEMPLATED |
  AI_PERSONALIZED | HUMAN_OPERATED`, dropping `AI_DEEPFAKE` per the LRX
  boundary) is resurrectable *at this level* — with the verdict stored as
  enrichment metadata and narrative color, never as a triage gate. Per-model
  stylistic signatures (verb density, register differences between model
  families) may eventually support *generator attribution* per campaign,
  which is more useful to the actor-intelligence mission ("WHO") than a
  binary AI flag.
- **Prompt-injection payloads as a detection surface (emerging, cheap).**
  Attacks increasingly target the *victim's AI assistant* (injection strings
  in email bodies / landing pages; Microsoft ships inbound prompt-injection
  detection since 2025). Scanning captured bodies/pages for injection
  patterns is deterministic, novel in the DRP segment, and doubles as
  self-hardening for §3.6's own judges.

### 3.7 Agentic-attacker detection — NOTED, MOSTLY OUT OF REACH

Detecting LLM browsing agents interacting with infrastructure relies on TLS
fingerprints (JA3/JA4), deep browser/behavioral probes, or attestation
registries. JA3/JARM is already assessed infeasible on Cloudflare Workers
(S2.4/D3 — no raw handshake access), attestation registries only bind
cooperative agents, and Averrow is not an inline traffic vendor. No action
supported beyond tracking the space. Conversational/multi-turn social
engineering detection is likewise a different product surface (inline email
security) with scarce data; out of scope.

---

## 4. Competitive positioning findings

From the ten-vendor sweep (Netcraft, ZeroFox, Bolster, Doppel, Recorded
Future, BrandShield, Corsearch, Memcyco, Allure Security, PhishLabs/Fortra):

- **"AI-generated attack detection" is now baseline category marketing** —
  every vendor claims it; almost none publish technique. The only concrete,
  named integrations/technique disclosures found: ZeroFox × Reality Defender
  (deepfake *media* forensics — a different problem from text), Doppel's
  OpenAI-model foundation + campaign "Threat Graph" framing, and Microsoft's
  published AI-obfuscation case study (not a DRP competitor, but the
  reference for what real disclosure looks like). Bolster's "99.999%
  accuracy / eight LLM transformers" numbers ship with no methodology.
- **No vendor was found surfacing a customer-visible "AI-generated"
  attribute with confidence on individual threats.** Closest analogues:
  Bolster's "signature cataloging" of AI campaigns, Doppel's graph framing.
  White space — with the caveat that behind-login features can't be ruled
  out from public material.
- **No evidence anyone charges separately for it** — bundled positioning
  across the category.
- **Category vocabulary is unsettled**: "polymorphic phishing" (most
  precise, matches §3.2), "AI-generated/GenAI phishing" (umbrella),
  "agentic threats" (Netcraft's 2026 framing). If Averrow productizes §3.2,
  "AI-polymorphic campaign" as a *campaign* attribute is the honest,
  defensible framing — it claims what was measured (structure), not what
  can't be proven (per-message authorship). No public confusion matrix for
  AI-vs-human text exists from any vendor; given §3.1, that silence is
  informative.

---

## 5. What Averrow already has (verified inventory)

The raw material and half the plumbing exist today:

| Asset | State | Where |
|---|---|---|
| Phishing email bodies + headers | **Live** — spam trap (`body_preview`, `raw_headers`, `x_mailer`, auth results, sender IP/geo) and abuse mailbox (`raw_body` ≤256KB, `raw_headers`, `extracted_urls`) | `migrations/0022`, `0150`/`0184`; `src/spam-trap.ts`, `handlers` for abuse mailbox |
| Live lookalike page signals | **Live** — SSRF-hardened fetch, deterministic 0–100 score, signal keys + SHA-256 hash stored (HTML discarded; no bot-wall detection) | `lib/page-fetch.ts`, `lib/page-phishing-scorer.ts`, migration 0243 |
| Campaign/cluster grouping | **Live** — campaigns, NEXUS clusters + connected components, infra-movement pivots | `infrastructure_clusters`, `lib/cluster-components.ts`, `lib/cluster-infra-movement.ts` |
| Domain age / cert identity / CT stream | **Live** | migrations 0239, 0234, 0032; CertStream DO |
| AI-generation signals schema | **Dormant — never written** | `phishing_pattern_signals` (migration 0023) |
| AI-generation consumers | **Wired but starved** (see §7.1 bugs) | `src/brand-threat-correlator.ts`, `src/agents/analyst.ts:614-627`, ops `ScoreBreakdownCard.tsx` |
| Cheap classification infrastructure | **Live** — Haiku via single choke point, budgets, idempotency | `lib/anthropic.ts`, `lib/per-agent-budget.ts`, `lib/haiku.ts` |
| Embeddings / Workers AI / Browser Rendering | **Absent** (verified: no binding, no embedding usage anywhere) | — |

---

## 6. Recommendations (ranked; research conclusions, not commitments)

> **Implementation status (2026-07-31, wave W1.11):** Items 1 and 2 below are
> now IMPLEMENTED on `claude/ai-phishing-detection-research-2f1blu`. Item 1 —
> the three §7.1 dead-read bugs are fixed in `src/brand-threat-correlator.ts`
> (`classification`→`category`, `sender_email`→`from_address`,
> `ai_generated=1`→`ai_generated_probability >= AI_GENERATION_PROBABILITY_THRESHOLD`,
> the shared constant now living in `src/lib/phishing-signals.ts` and also
> consumed by `src/agents/pathfinder.ts`). Item 2 — the deterministic
> (zero-AI) phase-1 campaign-polymorphism pipeline is built: migration
> `0257_phishing_pattern_signals_phase1.sql`, pure core
> `src/lib/phishing-pattern-signals.ts`, D1 writer
> `src/lib/phishing-pattern-writer.ts`, and the two admin endpoints
> (`POST /api/admin/phishing-signals/backfill`, `/rollup` — see
> `docs/API_REFERENCE.md`). The writer is endpoint-dispatched only (no cron,
> no `agent_runs`/`agent_events`), matching the alert-triage backfill
> precedent. `ai_generated_probability` is still never written — see the
> nuance in `docs/PLATFORM_DATA_DEPENDENCIES.md` §9. Item 3 (phantom-squat
> watchlist) is queued as the Wave 2 follow-up — not started.

1. **Fix the three dead-read schema bugs** (§7.1) — trivial, and a
   prerequisite: without it, no future writer lights up the existing risk
   score, insight, and UI label. **IMPLEMENTED W1.11.**
2. **Campaign polymorphism measurement** (§3.2) — the flagship. Phase it:
   deterministic first (normalize → SimHash/MinHash → `template_hash` +
   lexical-variance stats per campaign, pure SQL + code, zero AI spend),
   validate the semantic-vs-lexical ratio on historical spam-trap/abuse
   corpora, and only then decide the embedding question. Writer populates
   `phishing_pattern_signals`; consumers already exist. **Phase 1
   (deterministic writer) IMPLEMENTED W1.11**; semantic/embedding decision
   still open (§8).
3. **Phantom-squat watchlist** (§3.3) — bounded Haiku enumeration per brand,
   joined against NRD/CT/lookalike flows already running. Predictive lead
   time, differentiated data asset, publishable methodology (Unit 42
   precedent).
4. **Cloaking-as-signal** (§3.5) — small deterministic extension to
   `page-fetch`/`page-phishing-scorer`; converts today's silent false
   negatives into evidence and gives an instrumented blind-spot rate.
5. **Velocity/discontinuity deltas** (§3.4) — pure SQL over captured
   timestamps (registration→cert→first_seen); extend the D5b discontinuity
   idea toward aged-domain repurposing.
6. **Campaign-scoped Haiku generation-mode judge** (§3.6) — only after (2)
   provides structure; metadata + narrative only; never a triage gate;
   threshold recalibration on a small labeled slice as the maintenance
   model. Prompt-injection hardening of all body-consuming judges rides
   along.
7. **Marketing guardrail** — no borrowed base-rate stats (82%/1,265%-class
   figures); any customer-facing AI-generation attribute must carry a
   publishable, campaign-level methodology ("AI-polymorphic campaign"), or
   not ship.

**Explicit non-goals:** per-message MGT detection or any AI-text-detector
dependency (§3.1); watermark/C2PA reliance; JA3/JARM (D3, infeasible);
deepfake/voice-clone media forensics (LRX product boundary,
`LRX_PRODUCT_BOUNDARIES.md`); inline/conversational email defense (different
product surface).

---

## 7. Platform findings surfaced by this research (report-only)

### 7.1 Dead-read bugs in the existing AI-phishing plumbing

**IMPLEMENTATION STATUS (2026-07-31, W1.11): FIXED.** All three bugs below
are corrected in `src/brand-threat-correlator.ts` on
`claude/ai-phishing-detection-research-2f1blu`. The `ai_generated_probability`
threshold comparison now reads the shared
`AI_GENERATION_PROBABILITY_THRESHOLD` constant (`src/lib/phishing-signals.ts`,
`>= 0.7`). Downstream, `analyst.ts`'s "AI-Generated Threat Detected" insight
and the `ai_phishing_detected` score row are now reachable by SQL — but the
count they read (`ai_generated_probability`) is still always 0 until a future
campaign-level judge writes it (phase-1 deliberately never does; see
`docs/PLATFORM_DATA_DEPENDENCIES.md` §9). Original research findings kept
below for the historical record.

Verified against migrations 0022/0023. In `src/brand-threat-correlator.ts`,
both relevant queries are wrapped in `.catch(() => ({count/total: 0}))` and
so have silently returned zeros since they shipped:

1. AI-phishing count query filters `pps.ai_generated = 1` — the column is
   `ai_generated_probability` (REAL). Would still fail after a writer exists.
2. Spam-trap stats query selects `SUM(CASE WHEN classification = 'phishing'
   …)` — the column on `spam_trap_captures` is `category`.
3. Same query counts `COUNT(DISTINCT sender_email)` — the column is
   `from_address`.

(`stc.spoofed_brand_id` is fine — it exists.) Downstream, `analyst.ts`'s
"AI-Generated Threat Detected" insight and the ops-UI
`ai_phishing_detected` score row can never fire. Not fixed in this
research branch per scope; first item in §6.

### 7.2 Lookalike page-analysis blind spot

`lib/page-fetch.ts` has no detection for anti-bot walls
(CAPTCHA/Turnstile/challenge interstitials). Given the industry consensus
that hostile pages now front-load these walls specifically against crawlers,
a growing fraction of the lookalike page-analysis lane's "clean" verdicts
are unmeasured false negatives. §6 item 4 addresses it; until then, treat
low `page_phishing_score` on active lookalikes as weak evidence.

---

## 8. Open questions for the eventual build

- **Validation corpus:** how many labeled campaigns (spam-trap + abuse
  mailbox) exist with ≥10 members? The polymorphism ratio needs a
  distribution study before thresholds are set.
- **Embedding provider decision** (only if deterministic proxies prove
  insufficient): Workers AI binding vs Anthropic-pairwise vs none.
- **Where does the campaign-level verdict live?** `campaigns` gains columns
  vs `phishing_pattern_signals` rows aggregated per campaign — schema
  decision for `backend-engineer` + `threat-intel-analyst` at build time.
- **Phantom watchlist storage/refresh cadence** and whether it merges into
  `lookalike_domains` or gets its own table.
- **Tenant-facing exposure:** does "AI-polymorphic campaign" surface to
  customers at launch, or run internal-only until the methodology is
  validated? (§2.3 credibility bar.)

## 9. External sources requiring primary verification

Egress policy blocked primary fetches during research; before any figure
above becomes load-bearing, verify: SoK on LLM-generated phishing (arXiv
2508.21457); Frontiers in Big Data 2026 cross-model calibration (~86%
recovery figure); TU Berlin USENIX Sec '26 (n=7,700, 3× personalization
uplift); Unit 42 phantom-squatting methodology (18–51 day window); Liang et
al. 2023 *Patterns* (61.22% FPR); RAID ACL 2024 degradation tables; Verizon
DBIR 2025 synthetic-text base rate; Microsoft "AI vs AI" case study (the one
source fetched in full).
