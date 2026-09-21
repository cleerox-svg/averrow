# External Intel Feeds for AI-Generated & AI-Amplified Threats — Research & Plan — September 2026

**Status:** Research and plan only. **Nothing in this document has been built.**
No source file, migration, or config was changed in producing it.

**Decisions (2026-09-21):** four of the eight gates in §11 are settled — Lane 2
is in scope, the Workers AI binding is approved, the deepfake boundary's stated
reason is retired, and actor attribution proceeds via the **tier ladder in
§13.4** rather than the flat "no" an earlier draft proposed. §12's build order
is therefore live. Four gates remain open, all attached to Lane 1 or to
optional Tier-3 lanes.

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

> **Revalidated 2026-09-21 by direct probe** (see §5.1a). Egress opened partway
> since the original sweep, so sources 1, 2 and 6 were verified against the
> live APIs rather than search summaries. **Two claims did not survive.**

| # | Source | Provides | Access | Verified? | Signal vs noise |
|---|---|---|---|---|---|
| 1 | [Official MCP Registry](https://registry.modelcontextprotocol.io/) | Server names/namespaces; `updated_since` cursor | **F** | ✅ **contract confirmed, volume was wrong** | **High**, but see §5.1a — 33,765 servers, not ~1k |
| 2 | npm / PyPI registries | Existence checks on brand permutations | **F** | ✅ **confirmed, design corrected** | **High** via targeted `HEAD`; full-index ingestion infeasible |
| 3 | Hugging Face Hub API | Model/dataset/org names; deleted-author namespaces | **F/K** | ⚠️ **unverified** — 403 policy denial from this session | **Med-high** — namespace reuse + typosquat |
| 4 | LLM answer-engine probing (self-generated) | Brand→URL/handle/phone answers across N models | **K** (own keys) | n/a — self-generated | **Highest differentiation.** Non-deterministic — a *rate*, never a boolean |
| 5 | C2PA / IPTC markers in fetched page assets | `trainedAlgorithmicMedia`, JUMBF box, EXIF generator tags | **F**, in-band | ⚠️ **unverified** — spec site unreachable | **Positive-only**, zero marginal cost |
| 6 | Cloudflare Workers AI (EmbeddingGemma) | Embeddings for semantic clustering | **K** (binding) | ✅ **confirmed first-party** | Unblocks July §3.2's semantic leg — **512-token cap**, see §5.1a |
| 7 | DynaPD (6k kits / 2,059 families, de-weaponized) | Kit corpus | **F**, research licence | ⚠️ **unverified** — 403 | **Validation corpus** — answers July §8 directly. Internal only |
| 8 | OECD.AI / AI Incident Database | AI incident records | **F** | ⚠️ **unverified** — 403 | Narrative enrichment only |

### 5.1a Revalidation findings (2026-09-21)

**MCP Registry — volume was wrong by 34×.** Paginated to completion:
**33,765 unique servers across 109,986 rows** (1,100 pages at `limit=100`), not
"~1k". The claim that it "trivially fits `feedRunner`" — which is why it was
nominated as the gentle first feed — does not hold as stated.

What rescues it: `updated_since` **genuinely filters**, confirmed with a
control (a far-future timestamp returns 0 servers, while an unknown param is
silently ignored with a 200). Measured deltas: **24h = 655 unique servers /
11 pages; 7d = 3,739 unique / 75 pages.** So:

- Incremental pulls are comfortable and fit an existing tick.
- **The initial backfill of ~1,100 sequential requests cannot be one Worker
  invocation** and needs its own strategy (cursor checkpointed in KV, resumed
  across invocations — the `dns_queue` reconciler's cursor pattern is the
  in-house precedent).
- Two contract details the research got wrong: the cursor is **`nextCursor`**
  (camelCase, nested under `metadata`), and **~58% of rows are historical
  versions** — dedupe on `_meta…isLatest`, not on rows.

**npm / PyPI — the ingestion design was wrong, and the right one is cheaper.**
Full-index diffing is infeasible: PyPI's simple index is **895,450 projects /
43.9 MB**, npm's `/-/all` returns 404 and the replication `_changes` feed is
unreachable. But **targeted `HEAD` existence checks return 0 bytes with a clean
200/404** (`npm/express` → 200, `npm/reqeusts` → 404; same on PyPI). That is
exactly the lookalike scanner's "is this permutation registered?" primitive, so
Lane 2 gets *simpler*: generate permutations → check existence. No bulk ingest,
no index storage.

**EmbeddingGemma — confirmed, with a cap worth knowing.**
`@cf/google/embeddinggemma-300m`, 768 dims, cosine, Cloudflare-hosted, no
provider key. The research missed a **512 input-token limit**. Fine for the
flagship use (lures at 30–80 words ≈ 40–110 tokens); for long-form,
`@cf/qwen/qwen3-embedding-0.6b` offers 1,024 dims / 4,096 tokens.

**Still unverified.** Hugging Face, OECD.AI, DynaPD and the C2PA spec are all
403 policy denials from this session. Note the asymmetry: *our* inability to
reach Hugging Face says nothing about whether the Worker can reach it from
Cloudflare's network — that is an open question, not a negative finding. The
Netcraft 34% figure underpinning Lane 1 also remains unverified, which matters
because it is the headline number for the highest-ranked lane.

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

**npm/PyPI first** — targeted `HEAD` existence checks over brand permutations
(§5.1a: 0 bytes, clean 200/404, the lookalike scanner's own primitive) — then
the MCP Registry once its checkpointed backfill is designed, then HF
namespace-reuse. Landing: side table + classifier, the `social_mentions` →
Watchdog pattern.

**Ships with payload-sink extraction (attribution Tier 1, §13.4).** For every
confirmed squat, extract the network sink from its install/runtime payload —
webhook endpoint, bot API, or bare domain. The sink is an ordinary IOC: it
lands in `threats`, acquires an IP and cert through normal enrichment, and
bridges into NEXUS through machinery that already exists. That buys actor
attribution for the subset of squats that have a network payload, with **no
new axis, no new table, and no `threat_attributions.source` CHECK problem**.
Nothing extracts sinks today (verified — `lib/page-fetch.ts` has no webhook
extraction), so this is net-new capability.

*Evidence:* Churilov 2026 — 199,845 responses across 5 frontier models; **127
hallucinated package names shared by all five; 53 still registerable** `[V]`.
Unit 42 model-namespace reuse: deleted author namespaces re-registerable and
served to existing code references `[V]`. HF typosquat study over 1.02M models
→ 1,574 squatting models, 10.4% harmful `[S]`.

*Note on scope:* July §3.3 dismissed slopsquatting as "out of Averrow's scope."
**Reversed 2026-09-21** (§11 decision 1). It is the same primitive we already
run (name permutation + registry diff + brand match), the harmed party is a
company (so it passes `LRX_PRODUCT_BOUNDARIES.md`'s one-line test cleanly), and
it is new sellable surface. The reversal still needs recording in the July doc.

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

## 11. Decisions

Settled 2026-09-21 unless marked open.

| # | Decision | Status |
|---|---|---|
| 1 | **Reverse July §3.3's "slopsquatting out of scope"?** | ✅ **YES.** Lane 2 is in scope. Record the reversal in the July doc |
| 4 | **Add the Workers AI binding?** | ✅ **YES.** `@cf/google/embeddinggemma-300m`, no provider key; unblocks the stalled polymorphism semantic leg |
| 5 | **Ratify or retire the deepfake boundary** (§10.1) | ✅ **RETIRE the stated reason.** The imprsn8 boundary is defunct. Deferring deepfake detection still stands on §5.3's volume/price/accuracy grounds — but on those grounds, not an inherited one |
| 8 | **Do these signals ever carry actor attribution?** (§13.4) | ✅ **YES, via the tier ladder.** Tier 1 (payload-sink bridging) ships with Lane 2; Tier 2 (principal-identity axis) is designed for but gated on Tier 1's evidence. Not the flat "no" the first draft recommended |
| 2 | **Which assistants does Lane 1 cover, and at what cadence?** | ⬜ Open — decide when Lane 1 is specced |
| 3 | **Who pays for the `alert_type` presentation registry?** (§13.3) | ⬜ Open, but self-resolving: it is the same presentation work as Lane 3's `page_signals` renderer, so it lands there by default unless actively moved |
| 6 | **Narrow the §2.1 text-detection doctrine?** | ⬜ Open — only matters if Lane 7 is wanted. Cheap to defer |
| 7 | **Legal review budget for §7.1/§7.6** | ⬜ Open — decide with Lane 1 |

---

## 12. Suggested sequencing

Decisions 1, 4, 5 and 8 are settled (§11), so the build order below is live.
Small independent increments, each shippable alone, per the `delivery-lead`
pattern:

1. ~~Decisions 1, 4, 5~~ — **done 2026-09-21.**
2. **Lane 3** (AI-build artifacts) — smallest, purely deterministic, exercises
   no new dependency, and proves the signal shape before anything bigger.
   **Ship the `page_signals` renderer with it** (§13.5) — that retroactively
   surfaces the shipped-but-invisible Wave 3 work and builds the presentation
   primitive every later lane needs. Decision 3 (the `alert_type` registry)
   lands here by default.
3. **Lane 4** (C2PA/IPTC scan) — rides the same page-fetch change window.
4. **Lane 2**, in two steps — **npm/PyPI first** (targeted `HEAD` checks, no
   bulk ingest, per §5.1a), then the MCP Registry once its ~1,100-page
   checkpointed backfill is designed. This reverses the original order: the
   registry was nominated first on a "~1k clean rows" claim that proved wrong.
   **Payload-sink extraction (attribution Tier 1, §13.4) ships in this lane**,
   and the side-table schema is shaped so the Tier 2 principal axis drops in
   without rework.
5. **Lane 5** (Workers AI binding) — decision 4 is settled, and it unblocks the
   already-half-built polymorphism semantic leg. Independent of Lanes 1–4, so
   it can run in parallel with any of them.
6. **Lane 1** (answer-engine monitoring) — largest payoff, gated on the still
   -open decisions 2 and 7 (§7.6 ToS review).
7. **Attribution Tier 2** (principal-identity axis, §13.4) — only once Tier 1
   has shown that principal clustering finds multi-brand operators in real data.
8. Lanes 7–8 (§6 Tier 3 — the slop/fake-review lane and kit corpora) only if a
   customer pulls them.

Per `CLAUDE.md` §1A, each lane runs the full pipeline —
`delivery-lead` → engineer (+ `threat-intel-analyst`) → `test-engineer` →
`qa-verifier` → `code-reviewer`/`appsec-reviewer` → ship — with
`docs-maintainer` picking up §10's corrections.

---

## 13. Integration architecture — where these land, and how they're attributed

Added 2026-09-21. Every claim below was verified against the tree; file:line
citations are to the state of `master` at that date.

### 13.1 The structural fact everything follows from

Averrow has **two correlation axes**, and all four lanes land on the wrong
side of the one you would want:

- **Infrastructure axis** — `threats` → NEXUS clusters → Attributor →
  `threat_actors`. This is where "WHO" lives. Bridging requires a shared
  `ssl_cert_serial`, `ssl_san_hash` or `ip_address` on a `threats` row
  (`lib/cluster-components.ts:86-90` — `BRIDGE_KINDS` is exactly those three).
- **Everything else** — social, app-store, executive, dark-web. These produce
  alerts and stop. `agents/socialMonitor.ts`, `appStoreMonitor.ts` and
  `executiveMonitor.ts` all declare literally `reads: []`, `writes: []`.

A squatted package name and a model's answer have no cert serial, no SAN hash,
no IP. They are structurally in the second group.

**This is correct, not a gap.** `cluster-components.ts` explicitly refuses to
bridge on shared registrar or ASN, calling it the over-merge trap — gluing
separate operators together through a shared /24 or "GoDaddy". A shared npm
publisher account is exactly that shape. The honest framing: **these signals
are evidence of the same *intent*, not of the same *hosting operator*.**

### 13.2 The trap to avoid

There is a tempting move — write `infrastructure_clusters` rows for registry
squats, as the app-store and dark-web passes already do (`agents/nexus.ts:84-312`).
**Don't.** Those rows carry `asns: []` and `countries: []`, so they can never
pass the Attributor's footprint gate (`agents/attributor.ts:93-94`:
`asns.length >= 3` or `countries.length >= 4`). They can only match if a known
actor name happens to appear in the cluster name. In practice they are stamped
`attribution_attempted_at`, counted as `gated`, cooled down for 7 days, and
**accumulate in the admin Attribution Backlog as permanently unattributable
rows.** Copying that pattern imports a known defect.

### 13.3 Four verified blockers

| Blocker | Location | Impact |
|---|---|---|
| `threat_attributions.source` CHECK is `otx\|nexus\|manual\|news` | `migrations/0135:36-38` | Closed, un-ALTERable in SQLite. A `registry` / `answer_engine` attribution source needs a table rebuild or must masquerade as `manual` |
| `SOURCE_BASELINE[feed] ?? 50` | `lib/threatScoring.ts:45` | **Footgun.** Unregistered source + `impersonation` + brand hit = 50+5+10 = 65 → **`high` severity, silently.** A noisy new lane floods the queue at high severity by default |
| `alert_type` has no presentation registry | `features/alerts/Alerts.tsx:592-621`, platform regex at `:91-101` | Every alert renders through hardcoded social vocabulary ("Platform", "Handle Detected", "Impersonation Score"); platform is scraped from the title with a fixed substring list, falling back to "Social" |
| `threats.threat_type` closed CHECK | `migrations/0013:34-37` | Already known (§3.2) — forces side-table or the `technique` column |

### 13.4 Layer-by-layer integration

**Storage.** Lanes 1–2 use the `social_mentions` → Watchdog pattern
(`agents/watchdog.ts:83-159`): side table, classifier agent, escalate only
high-confidence rows to `threats`. **Do not copy Watchdog literally** — it does
a raw `INSERT INTO threats` with a random UUID (`:134`), bypassing `threatId()`
determinism, `calculateConfidence`, `calculateSeverity` and
`reclassifyThreatType`. It is both the precedent and the sloppy one. Lanes 3–4
need no new table: they are additive signals on the existing page scorer.

**Provenance.** The `*_checked` / `*_flagged` idiom is exactly right and is
already customer-facing (`handlers/tenantData.ts:420-424`). "We probed N
answer engines; M returned a non-brand asset" maps onto it cleanly, and it
enforces the discipline this plan already requires: **absence of a check is
never evidence of innocence** (`lib/alert-triage.ts:79-128`), which is the
same reason answer-engine output must be a rate over N samples, never a
boolean. Register every new source explicitly in `SOURCE_BASELINE` rather than
letting it fail open to 50.

**Actor attribution — a tier ladder, not a yes/no.** *(Revised 2026-09-21; an
earlier draft of this section recommended a flat "no for v1". That was too
blunt — see the distinction below.)*

The over-merge trap §13.1 cites is about **commodity** keys. "GoDaddy" or a /24
is shared by millions of unrelated customers. A *specific npm publisher
account* is not commodity — in discriminating power it is closer to a cert
serial. The codebase already implicitly agrees: `agents/nexus.ts:100-108`
clusters app-store listings by `GROUP BY store, dev_key HAVING brands >= 2 AND
rows_ >= 2`. That is principal-identity clustering, already shipped. Its
problem is not the idea but the **table** — writing into
`infrastructure_clusters` leaves it unable to bridge and unable to attribute,
so it dead-ends and pollutes the Attribution Backlog (§13.2).

| Tier | What it is | Cost | Verdict |
|---|---|---|---|
| **0** | Alerts only, dead-end | none | Superseded — this was the first draft's recommendation |
| **1** | **Payload-sink bridging.** Extract the network sink (webhook, bot API, domain) from a squat's payload; it enters `threats` as an ordinary IOC and bridges into NEXUS unchanged | small; no new table, no CHECK change | ✅ **Ships with Lane 2** |
| **2** | **Principal-identity axis.** A second correlation axis keyed on publisher / maintainer / org / namespace / developer account, in its own table, joined to the infra axis through shared sinks | new table + writer; the `threat_attributions.source` CHECK rebuild; its own admission gate | ✅ **Designed for, gated on Tier 1's evidence** |
| **3** | Point Haiku at these signals to guess actor names directly | cheap to try | ❌ **Never.** Reproduces the app-store/dark-web failure: 1,325 of 1,330 calls returned "unknown" in the audit that produced the current gate (`agents/attributor.ts:61-68`) |

**Why Tier 2 is tractable rather than speculative:**

- **`computeComponents` is a pure function** (`lib/cluster-components.ts:217-220`
  — takes `clusters`, `bridges`, `options`). The union-find core is reusable
  verbatim with a different bridge-kind set. This is parameterising an existing
  engine, not writing a new one.
- **The two axes join through sinks.** Registry-operator cluster —(shared sink
  domain)→ infrastructure cluster is an evidence-backed cross-surface pivot,
  and it is exactly the "who moves where" question the platform exists to
  answer. It would also give the currently-orphaned app-store and dark-web
  clusters a home that can actually attribute.

**Tier 2's three real costs**, none hidden: a new table and writer; the
`threat_attributions.source` CHECK rebuild (or an explicit decision to
masquerade as `manual`); and its own admission gate — the Attributor's is
ASN/country-shaped and would never fire here, so a principal gate would be
something like ≥2 brands across ≥2 registries.

**Sequencing rationale:** Tier 1 gets real attribution immediately on the
subset with a payload, proves the sink primitive, and defers the table rebuild
until there is evidence that principal clustering finds multi-brand operators
in Averrow's actual data. If it does, Tier 2 is a contained follow-on. If it
doesn't, nothing was spent on it.

**UI, cheapest to most expensive:**

1. A sixth `V3_TABS` entry on brand detail (`features/brands/BrandDetail.tsx:59-72`)
   — ~3 lines; the union type is derived from the array, so `?tab=` deep-linking
   works with no other change.
2. A tenant module, per the checklist in `docs/TENANT_DATA_FLOW.md` §4.
3. A new `alert_type` — needs a filter pill (`Alerts.tsx:1031-1053`) **plus** a
   per-type presentation registry that does not exist yet.
4. A new agent — three manual registries (`lib/agent-metadata.ts`,
   `components/brand/AgentIcon.tsx`, and a hardcoded `{x,y}` in
   `AgentNetworkView.tsx:89`), or it lands in the "meta" group with no icon.

### 13.5 The orphaned-signal risk

Two UI risks compound, and they are the reason UI work belongs *in* each lane
rather than after it:

- **`docs/TENANT_DATA_FLOW.md` exists because 17,605 threats rendered as empty
  module pages.** A brand with no registry squats is *legitimately* empty, so
  "checked and clean" must look different from "never ran".
- **Wave 3's `page_signals` and `page_anti_bot_wall` shipped with no renderer
  at all.** They are written by `scanners/lookalike-page-analysis.ts:89-91`,
  are absent from `hooks/useLookalikes.ts:4-16`, and that hook has **zero call
  sites** anywhere in `features/`. The only surface is an aggregate
  `wall_rate_pct` in diagnostics.

So the platform already has a pattern of backend signals landing and never
surfacing. `ScoreBreakdownCard.tsx` is the **only** weighted-evidence component
and has one call site; it is the pattern to clone.

### 13.6 Mockups

Proposed components are mocked in Averrow's real tokens (Plus Jakarta Sans /
IBM Plex Mono, `--bg-page`, `--amber`, the `--sev-*` ramp):
`SignalBreakdownCard`, `AnswerEngineProbeCard`, `RegistrySquatPanel`, the
alert-type registry before/after, the brand-detail tab placement, and the three
tenant empty states.

→ https://claude.ai/artifact/NbEwoJWjbiR2Lbu3g4EgJY
*(private artifact — the owner must share it before others can open the link)*

---

*Research and plan only — no implementation. Companion documents:
`docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` (governing doctrine),
`docs/THREAT_FEEDS.md` (current feed architecture),
`docs/IMPROVEMENT_PLAN_2026-07.md` S2.4 (deferred detection lanes).*
