# External Intel Feeds for AI-Generated & AI-Amplified Threats — Research & Plan — September 2026

**Status:** Research and plan only. **Nothing in this document has been built.**
No source file, migration, or config was changed in producing it.

**Scope:** Survey external sources Averrow could ingest as a *new class of
signal* — feeds that help identify AI-generated threats and AI-amplified brand
threats — and turn that survey into a sequenced, costed plan with explicit
decision gates.

**Question this answers:** not "can we detect AI-written text?" (answered, and
answered *no*, in `docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md`) but "what
can we *ingest from outside* that we don't have today?"

**Confidence markers** used throughout, per the precedent set by the July doc's
§9: `[V]` corroborated by multiple independent sources · `[S]` single source ·
`[U]` vendor self-reported, unverified. Internal file/line claims were verified
directly against the tree and carry no marker.

> **Egress caveat — carries forward from July.** The external sweep behind this
> document ran under a proxy policy that blocked primary fetches (arxiv.org,
> vendor blogs, spec sites). Every external figure came from search-result
> summaries, not primary PDFs. §9 is the verification backlog. Apply the July
> doc's §2.3 standing guidance: **none of these numbers may enter product or
> marketing copy before primary verification.**

---

## 1. Executive summary

**The strategic finding: the highest-value new sources are not AI-detection
vendors. They are new *surfaces* where brands are now impersonated — surfaces
that didn't exist two years ago, and that no competitor was found monitoring.**

The instinct behind "ingest an AI-detection feed" leads almost entirely to dead
ends. Media-forensics vendors are priced and volumed for spot checks, not
pipelines (Reality Defender's free tier is 50 detections/month `[V]`). Open
-source AI-image detectors score **≈38% mean accuracy against 2024-era
generators** — worse than a coin flip, and *declining* with each generator
release year `[S]`. SynthID has no third-party detection API `[V]`. Text
detectors were already rejected in July on a length-floor argument that still
holds.

What *is* available, cheap, and unclaimed:

| # | Lane | Why it wins | Effort |
|---|---|---|---|
| 1 | **LLM answer-engine brand monitoring** — ask N models "where do I log in to $BRAND / what's their support number", diff against the brand's authorized assets | Reuses the `phantom_enumerator` agent almost unchanged. Netcraft: **34% of 131 hostnames returned for 50 brands were not brand-controlled**, ~30% takeover-ready `[V]` | S–M |
| 2 | **Registry brand-squatting** — MCP registries, npm/PyPI, Hugging Face | Same primitive as the lookalike scanner, pointed at registries instead of DNS. Free APIs. **No DRP competitor found covering it** | M |
| 3 | **AI-build artifacts in page source** — agent scaffolding left in cloned sites | Deterministic extension of `page-phishing-scorer.ts`, identical in shape to the shipped Wave 3 `anti_bot_wall` work. Netcraft-validated tell | S |
| 4 | **C2PA/IPTC marker byte-scan** on images of lookalike pages | Positive-only, zero vendor, ≤3 range-requests on an already-fetched page | S |

Lanes 1 and 2 are the strategically important ones: they are *new sellable
surface*, not incremental detection quality. "Someone published an `acme` MCP
server to three registries and an `acme-sdk` package to PyPI, and neither is
yours" is a sentence no competitor can currently say.

**Two corrections to existing docs surfaced during this work** (§10) — one of
them material: the July doc's deepfake non-goal cites a product boundary whose
other side **no longer exists**.

---

## 2. Relationship to prior work — what is settled and not reopened

`docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` (575 lines) is the governing
doctrine. Its conclusions stand and this plan does not re-litigate them:

| July conclusion | Status in tree | This plan |
|---|---|---|
| §3.1 Per-message AI-text detection — **REJECT** | Enforced in code (§3 below) | Upheld, with one narrow refinement (§2.1) |
| §3.2 Campaign polymorphism | Phase 1 shipped — migration `0257`, `lib/phishing-pattern-signals.ts` | Unblocked, not redesigned (§6, Lane 6) |
| §3.3 Phantom-squat watchlist | **Shipped** — migration `0258`, `agents/phantomEnumerator.ts` | **Reused as the engine for Lane 1** |
| §3.4 Velocity signatures | v1 shipped — migration `0259`, `weaponization_flag` | Untouched |
| §3.5 Cloaking-as-signal | **Shipped** — migration `0260`, `page_anti_bot_wall` | Used as the **template** for Lane 3 |

### 2.1 The one refinement to doctrine

July rejected AI-text detection on a length floor: detectors need ~120 words;
phishing lures run 30–80. **That reasoning is correct for lures and stays
correct.** It does not transfer to the AI-slop / fake-review / fake-news
surface, where the unit is a 600–2,000-word article and the floor is satisfied.

**Proposed narrowing:** from *"never use text detection"* to **"never use text
detection at lure length, and never per-message."** Site-level aggregate
scoring over long-form content is a different statistical problem. The
existence proof is NewsGuard's production system, which pairs human analysts
with Pangram automated detection over **3,749 AI content-farm sites, growing
300–500/month** `[V]`.

This refinement unlocks nothing in Tier 1 or 2 — it only matters if we later
build a slop/fake-review lane (§6, Lane 7). Recording it so the distinction
isn't lost.

---

## 3. The hard constraints any plan must respect

These are verified against the tree, and they shape every option below.

**3.1 `ai_generated_probability` is pinned to NULL by design — writing it is a
doctrine reversal, not a code change.**
`lib/phishing-pattern-signals.ts` enforces this at two levels: the type
`EvidenceOnly<T> = T & { ai_generated_probability?: null }` makes a numeric
assignment a `tsc` error, and `assertEvidenceOnly()` throws at runtime citing
"spec §0.2 rule 1". **Any proposal to ingest an external AI-detection score and
land it there must first amend the July doc.** It is not a backend ticket.

**3.2 `threats.threat_type` is a closed 10-value SQL CHECK.**
`migrations/0013:34-37`. SQLite cannot ALTER a CHECK, so a genuinely new
threat type needs a full table rebuild — colliding with `CLAUDE.md` §8's
additive-only rule. Escape hatches already used by the platform: the free-form
`technique` column (`0205:11`), mapping onto `impersonation`, or a side table.
**Every lane below uses a side table or an existing type. None proposes a
rebuild.**

**3.3 No page-HTML corpus is retained.**
`lib/page-fetch.ts` discards the body and stores only a SHA-256
(`page_content_hash`). Any content-analysis plan needs a storage decision
first. Lanes 3 and 4 are designed to work **in-band during the existing fetch**
specifically to avoid this.

**3.4 No Workers AI and no Browser Rendering binding exists.**
Verified: `wrangler.toml` has neither. This is the July doc's open §8 question
and it gates the semantic leg of campaign polymorphism (§6, Lane 6).

**3.5 Adding a cron is governed by a mandatory audit rule** (`CLAUDE.md` §6).
Prefer riding an existing tick, as `lookalike-page-analysis` does on
`22 * * * *`. Only Lane 2 plausibly justifies its own cron.

**3.6 Feed durability is a real, measured cost.**
`migrations/0252` retired six feeds in one pass: PhishTank now requires a
registered key, urlscan moved verdict-search behind a paid plan, Talos 403s
automated fetches, CryptoScamDB silently switched JSON→YAML, C2-Tracker's repo
was archived. **Six of ~46 ingest feeds died or were gated within a year.**
Any new source must be scored on durability and ToS, not just capability —
which is why §7 exists and why free, officially-documented APIs are ranked
above scrapes throughout.

---

## 4. Where a new signal class can land — verified patterns

Four existing landing patterns, in ascending schema cost:

| Pattern | Precedent | Cost | Fits |
|---|---|---|---|
| **Digest → `agent_outputs`** | `cisa_kev.ts`, `nvd_cve.ts`, `epss.ts` write insight digests, not `threats` — a CVE isn't an IOC | Lowest — no schema at all | Narrative/context sources (GTIG, incident DBs) |
| **Side table + classifier agent → escalate** | `social_mentions` (`0054`) → Watchdog → `threats` | Low–medium | **Lanes 1 and 2** |
| **Additive signal on an existing scorer** | `page_anti_bot_wall` (`0260`) → `page-phishing-scorer.ts` | Lowest with real signal value | **Lanes 3 and 4** |
| **New `alert_type` + triage rule + judge branch** | the four impersonation families in `lib/alert-triage.ts` | Medium — needs an `alerts` rebuild | Lane 1's output stage |

The digest pattern deserves emphasis: **a "feed" here need not produce IOCs.**
Three feeds already write narrative insights instead. That is the correct
landing for research sources like Google's GTIG tracker, which is prose with no
machine-readable export and should be treated as reading material, not data.

---

## 5. Source survey

Access key: **F** free/open · **K** free w/ key · **C** commercial · **X** no API

### 5.1 Worth ingesting

| # | Source | Provides | Access | Signal vs noise |
|---|---|---|---|---|
| 1 | [Official MCP Registry](https://registry.modelcontextprotocol.io/) | Server names/namespaces; `updated_since` cursor — a near-exact match for `feedRunner` incremental-pull semantics | **F** | **High.** ~1k rows, no noise |
| 2 | npm / PyPI registries | New publishes, names, metadata | **F** | **High** filtered to brand+permutation; very noisy raw |
| 3 | Hugging Face Hub API | Model/dataset/org names; deleted-author namespaces | **F/K** | **Med-high** — namespace reuse + typosquat |
| 4 | LLM answer-engine probing (self-generated) | Brand→URL/handle/phone answers across N models | **K** (own keys) | **Highest differentiation.** Non-deterministic — a *rate*, never a boolean |
| 5 | C2PA / IPTC markers in fetched page assets | `trainedAlgorithmicMedia`, JUMBF box, EXIF generator tags | **F**, in-band | **Positive-only**, zero marginal cost |
| 6 | Cloudflare Workers AI (EmbeddingGemma) | Embeddings for semantic clustering | **K** (binding) | Unblocks July §3.2's semantic leg |
| 7 | DynaPD (6k kits / 2,059 families, de-weaponized) | Kit corpus | **F**, research licence | **Validation corpus** — answers July §8 directly. Internal only |
| 8 | OECD.AI / AI Incident Database | AI incident records | **F** | Narrative enrichment only |

### 5.2 Real but blocked, deferred, or bad-access

| Source | Verdict |
|---|---|
| **NewsGuard AI Tracking Center** (3,749 slop sites `[V]`) | Excellent data, **hostile licensing** — an ad-placement licence, not a threat-intel-resale one (§7.1) |
| **Pangram** ($0.05/1k words `[S]`) | Credible at article length only. Relevant solely if Lane 7 happens |
| **Reality Defender / Hive / Sensity / Pindrop** | Wrong volume, wrong price, opaque FPR. See §5.3 |
| **Google Ads Transparency Center** | Real signal, **no official API** — any collection breaches ToS, including via a vendor (§7.2) |
| **Meta Ad Library API** | Official and free but coverage scope unconfirmed `[U]` — verify before planning |
| **Smithery.ai (3,500+ servers, 8% verified) / MCP.so (17,000+)** `[S]` | Best squat yield, worst ToS posture. Secondary to source #1 |

### 5.3 Explicit do-nots

- **Open-source AI-image detectors.** Best single model 75.0% mean accuracy,
  worst 37.5%, ensembles 78.0% — and **accuracy declines with generator release
  year: ~79% for 2020-era vs ≈38% for 2024-era** `[S]`. This is the image-domain
  analogue of July §3.1 and should be recorded beside it as a standing non-goal.
- **SynthID.** Detector is a gated upload portal, not an API `[V]`. The
  open-source SynthID-Text path detects only *your own* watermark with *your
  own* keys — useless against an adversary.
- **Per-message text detectors** (Originality / Copyleaks / GPTZero). July §3.1
  stands; vendor FPR claims contradict each other by two orders of magnitude
  (self-reported 0.03–0.24% vs an independent study's 7.2–9.24% for Originality)
  `[S]`.
- **Media-forensics vendors as a pipeline stage.** If executive deepfakes become
  must-ship, **partner rather than build** — the ZeroFox × Reality Defender
  pattern (§8). But see the boundary question in §10.1 first.
- **Scraping Google Ads Transparency Center**, directly or through a vendor.

---

## 6. Proposed lanes, ranked by value-to-effort

> Sizing is **indicative only** — no implementation spike has been run. Treat
> as relative ordering, not a commitment. Each lane names its landing pattern
> from §4 and its decision gate.

### Tier 1

**Lane 1 — LLM answer-engine brand monitoring.** *(largest differentiation)*

Ask N models, in plain user phrasing, where to log in / what the support number
is for a brand; diff the answer against that brand's authorized asset set
(brand domains, `official_handles`, `official_apps` — all already in schema).
Three outcome classes, each routing to plumbing that already exists:

- *Unregistered hostname* → feed the existing `phantom_domains` watchlist,
  already matched against NRD and CT flows.
- *Registered, not ours* → existing impersonation triage.
- *Wrong support number / wrong contact* → a new `answer_engine_poisoning`
  alert family, with a `decideAnswerEnginePoisoningTriage` beside the existing
  four and a dispatch case in `runAlertTriageBackfill`, per `CLAUDE.md` §8.

*Engine:* `agents/phantomEnumerator.ts` nearly unchanged — different prompt set,
different assertion. Bounded Haiku, per-brand, low cadence, manual trigger
first (the phantom agent's existing posture).
*Evidence:* Netcraft's 34%/131-hostnames study `[V]`; ZeroFox's LLM SEO-poisoning
research `[V]`; Microsoft's "AI Recommendation Poisoning" cataloguing **31
companies across 14 industries** `[S]`.
*Honest caveats:* model answers are non-deterministic and drift with versions,
so the output is a **rate over N samples**, never a boolean; results are
per-model, so "which assistants do we cover" is a product decision, not a
technical one; and the GEO-monitoring market tracks *visibility* — our angle is
*safety*, which is why it's differentiated.
*Gate:* §7.6 — ToS review of systematic probing before any customer-facing output.

**Lane 2 — Registry brand-squatting.**

MCP Registry first (free, documented, `updated_since` cursor, ~1k rows — fits
`lib/feedRunner.ts` with no new concepts), then npm/PyPI, then HF
namespace-reuse. Landing: side table + classifier, the `social_mentions` →
Watchdog pattern.

*Evidence:* Churilov 2026 — 199,845 responses across 5 frontier models; **127
hallucinated package names shared by all five; 53 still registerable** `[V]`.
Unit 42 model-namespace reuse: deleted author namespaces re-registerable and
served to existing code references `[V]`. HF typosquat study over 1.02M models
→ 1,574 squatting models, 10.4% harmful `[S]`.

*Note on scope:* July §3.3 dismissed slopsquatting as "out of Averrow's scope."
**That call should be revisited.** It is the same primitive we already run
(name permutation + registry diff + brand match), the harmed party is a company
(so it passes `LRX_PRODUCT_BOUNDARIES.md`'s one-line test cleanly), and it is
new sellable surface. Recommend reversing, with the decision recorded in the
July doc.

**Lane 3 — AI-build artifacts in page source.**

Deterministic markers in the existing `page-phishing-scorer.ts` signal idiom —
exactly the shape of the shipped Wave 3 anti-bot-wall work, zero AI spend, zero
new dependency:

- Leftover agent scaffolding: `TODO:` checklists, `PLACEHOLDER`,
  `YOUR_API_KEY_HERE`, lorem ipsum co-occurring with live brand assets
- Builder fingerprints: generator `<meta>` tags, AI site-builder framework and
  CDN defaults
- Refusal-text leakage: `As an AI language model`, `I cannot assist with`
- **Credential-sink mismatch**: form posts to Discord/Telegram webhooks —
  high-precision standalone
- Microsoft's Sept 2025 synthetic-code tells (already catalogued, July §3.5)

*Evidence:* Netcraft identified **100,000 AI-generated sites impersonating ~200
brands** and states it detects them by looking for code patterns suggesting AI
generation, **such as included to-do lists** `[V]`.
*Precision discipline:* individually weak-to-moderate. The *conjunction* of a
builder fingerprint + brand logo + credential form is strong. Keep them
additive under existing weight discipline — never a standalone verdict.

### Tier 2 — cheap, do alongside

**Lane 4 — C2PA / IPTC byte-scan on lookalike page images.** On a page already
above threshold, issue ≤3 HTTP Range requests for the first 64 KB of the
largest `<img>`/`og:image` assets and byte-scan for the IPTC
`DigitalSourceType` XMP string, a JUMBF/`c2pa` box marker, and generator EXIF
tags. A lookalike login page whose hero logo is self-declared
`trainedAlgorithmicMedia` is synthetic brand imagery by the generator's own
assertion.

**Positive-only, always.** Most authentic images carry no credentials, and
every major social platform strips manifests on upload `[V]` — so absence
proves nothing and must never gate a dismissal. Same discipline as §3.1.
Full cryptographic validation needs `c2pa-rs`/WASM and is too heavy for the
Worker CPU budget; presence-detection is the whole proposal.

**Lane 5 — Workers AI binding + EmbeddingGemma.** Closes July §8's open
embedding question and unblocks the semantic leg of campaign polymorphism —
the flagship item that is already half-built and currently stalled on exactly
this. Cheapest path to finishing existing work.

**Lane 6 — Phantom watchlist, path-level extension.** Unit 42: **49.7% of
hallucinated-URL errors are at the path level**, not the domain `[S]`; our lane
is domain-only. Attacker-unregisterable (the domain is brand-owned), but a real
brand-hygiene finding — users sent to 404s and then to SEO-poisoned
substitutes. Small schema addition to a shipped lane.

### Tier 3 — conditional

**Lane 7 — Long-form AI-slop / fake-review lane.** Only if we build that
surface; only at article length; only site-aggregate; never per-message.
Requires the §2.1 doctrine narrowing first. Pangram is the credible vendor;
NewsGuard's licensing likely blocks buying the finished list (§7.1).

**Lane 8 — Kit corpora for threshold validation.** DynaPD answers July §8's
"how many labeled campaigns exist" question directly. Internal validation only,
never customer-visible output (§7.4).

---

## 7. ToS and licensing landmines

We resell intelligence, so **derived-data rights matter more than access**.
Each item below is a gate, not a note.

1. **NewsGuard datastream — highest risk.** Licensed to brands and their ad
   agencies, distributed through pre-bid ad-tech segments. That is an
   **ad-placement licence, not a threat-intel-resale licence.** Re-exposing the
   site list inside a paid tenant is very likely outside the grant. Assume the
   default answer is no; negotiate an explicit redistribution clause first.
2. **Google Ads Transparency Center.** No official API means any collection
   breaches ToS — and **vendor indemnity cannot transfer a right the vendor
   never had.** Third-party GATC scrapers are legally equivalent to scraping it
   ourselves.
3. **Smithery / MCP.so.** Unmoderated community registries, unsettled terms.
   The official MCP Registry is the safe primary; check each secondary's terms
   individually.
4. **Phishing-kit corpora.** Research-use licences, and the archives contain
   live attacker artifacts and third-party victim data. Fine for internal
   threshold validation; **not** fine as a source of customer-visible content.
   DynaPD is explicitly de-weaponized; PhishingKitTracker is not.
5. **Detector-vendor output.** Most detector ToS restrict republishing scores as
   your own product output. A vendor verdict appearing in a tenant report is a
   *redistribution* question, not a usage one. Read the DPA before wiring;
   route through `appsec-reviewer` and legal.
6. **LLM provider ToS for Lane 1 probing.** Systematically querying a model to
   build a published dataset about its failure modes touches
   benchmarking/comparative-use clauses. Netcraft and Unit 42 both did this and
   published — good precedent, but precedent is not permission. Safest posture:
   publish **aggregate rates per brand**, never "model X said Y" as a
   customer-facing quote.
7. **npm / PyPI / Hugging Face.** Permissive for metadata reads; respect rate
   limits.

---

## 8. Competitive read

The July doc's §4 finding holds: "AI-generated attack detection" is baseline
category marketing and almost nobody publishes technique. Three 2026 updates:

- **Netcraft** remains the benchmark — publishes method, sample sizes, and a
  named detection tell. Match this standard.
- **ZeroFox × Reality Defender partnership (Jun 2026)** `[V]` is strategically
  instructive: they **bought** media forensics rather than building it. That is
  the same call §5.3 recommends here.
- **Bolster's "99.999% accuracy / eight LLM transformers"** is unchanged from
  July's assessment — on a class-imbalanced detection problem that is a
  statistics error or a marketing number, not a result.

**White space, still:** (1) no vendor publishes a confusion matrix for
AI-vs-human classification — given §3.1 and §5.3, that silence is informative
and **we should not break it either**; (2) **no vendor found monitoring
package/model/MCP registries as a brand surface**; (3) no vendor treats LLM
answer-engine output as a *security* surface. (2) and (3) are Lanes 2 and 1.

---

## 9. Verification backlog — before any number ships

Blocked by egress this session; fetch primaries from an unrestricted
environment before any figure becomes load-bearing or enters copy:

Netcraft's two blog posts (100k sites; 34%/131 hostnames) · Unit 42
phantom-squatting (especially the 49.7% path-level figure) · arXiv 2605.17062
(53 registerable names) · the 2026 open-source image-detector benchmark (the
75%/38% figures — **load-bearing for the §5.3 non-goal**) · any Google
"AI Content Detection API" announcement (the only thing that would change the
SynthID verdict) · Meta Ad Library coverage scope · Pangram's FPR methodology ·
NewsGuard datastream licence terms · C2PA 2.4 Soft Binding Resolution API.

Per July §2.3: treat all `$Bn`-loss, `1,633%`-growth and `85%-of-brands`-class
figures as vendor-press-release genre and **do not quote them**.

---

## 10. Doc corrections found along the way

**10.1 — Material. The July doc's deepfake non-goal cites a defunct boundary.**
`AI_PHISHING_DETECTION_RESEARCH_2026-07.md:496` defers deepfake/voice-clone
forensics to "the LRX product boundary, `LRX_PRODUCT_BOUNDARIES.md`". That file
exists (repo root, not `docs/`) — and states that **imprsn8 was decommissioned
on 2026-07-12**: package, Worker, and Cloudflare resources torn down. The
boundary's other side no longer exists.

Meanwhile Averrow has shipped `org_executives` (migration `0244`) and the
`executive_monitor` agent, which protects company executives — people acting
for a company, which passes the boundary doc's own person-vs-company
tie-breaker.

**This does not mean we should build deepfake detection.** §5.3's
volume/price/accuracy objections stand on their own merits and are sufficient
to defer it. But the *stated reason* in the July doc is now wrong, and a real
decision should replace an inherited one. **Owner: product, with
`docs-maintainer` to record the outcome.**

**10.2 — Minor.** `docs/THREAT_FEEDS.md:124` says per-feed eligibility is gated
by `feed_configs.interval_minutes`. **No such column exists** — verified absent
from every migration and from `src/`. Cadence comes from
`feed_configs.schedule_cron`, parsed as a poll *interval* by
`parseCronIntervalMs` (`lib/feedRunner.ts:965-1009`). Route to
`docs-maintainer`.

---

## 11. Open decisions — these need a human, not an engineer

| # | Decision | Why it's not an implementation detail |
|---|---|---|
| 1 | **Reverse July §3.3's "slopsquatting out of scope"?** | Gates Lane 2 entirely. Recommend yes (§6) |
| 2 | **Which assistants does Lane 1 cover, and at what cadence?** | Cost and customer-promise question. Per-model results don't generalize |
| 3 | **Does Lane 1's output surface to tenants at launch, or run internal-only until calibrated?** | July §2.3's credibility bar. Same question July §8 left open for polymorphism |
| 4 | **Add the Workers AI binding?** | New platform dependency + AI spend line. Unblocks existing stalled work (Lane 5) |
| 5 | **Ratify or retire the deepfake boundary** (§10.1) | Currently inherited from a decommissioned product |
| 6 | **Narrow the §2.1 text-detection doctrine?** | Only matters if Lane 7 is wanted. Cheap to defer |
| 7 | **Legal review budget for §7.1/§7.6** | Two lanes have licensing gates ahead of code |

---

## 12. Suggested sequencing

Nothing here is committed. If the plan is accepted, the natural order — small
independent increments, each shippable alone, per the `delivery-lead` pattern:

1. **Decisions 1, 4, 5** (§11) — cheap, unblock everything downstream.
2. **Lane 3** (AI-build artifacts) — smallest, purely deterministic, exercises
   no new dependency, and proves the signal shape before anything bigger.
3. **Lane 4** (C2PA/IPTC scan) — rides the same page-fetch change window.
4. **Lane 2** (MCP Registry only) — first genuinely new feed; validates the
   side-table pattern on ~1k clean rows before npm/PyPI volume.
5. **Lane 1** (answer-engine monitoring) — largest payoff, gated on decisions
   2, 3 and the §7.6 ToS review.
6. **Lane 5** (Workers AI) → unblocks the stalled polymorphism semantic leg.
7. Tier 3 only if a customer pulls it.

Per `CLAUDE.md` §1A, each lane runs the full pipeline —
`delivery-lead` → engineer (+ `threat-intel-analyst`) → `test-engineer` →
`qa-verifier` → `code-reviewer`/`appsec-reviewer` → ship — with
`docs-maintainer` picking up §10's corrections.

---

*Research and plan only — no implementation. Companion documents:
`docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` (governing doctrine),
`docs/THREAT_FEEDS.md` (current feed architecture),
`docs/IMPROVEMENT_PLAN_2026-07.md` S2.4 (deferred detection lanes).*
