# Lane 3 — AI-Build Artifacts & Covert Exfil Sinks — Implementation Spec

**Status:** **Phase 1 SHIPPED** (merged 2026-09-21, PR #1713 — migration `0264`,
eight signals computing and persisting in shadow mode, diagnostics instrumented,
99 new tests). Phases 2 and 3 are still proposal/design. See §9 for per-step
state and §11 for what Phase 2 is blocked on.
**Scope:** Extend the existing deterministic lookalike page scorer with two new
evidence classes (synthetic-build artifacts; covert credential-exfil sinks),
persist the resulting fired-signal set, and — for the first time — **render it
to an operator**.
**Parent:** `docs/AI_THREAT_INTEL_FEEDS_PLAN_2026-09.md` §6 Lane 3, §12 step 2.
**Doctrine:** `docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` §3.1 (per-message
MGT detection REJECTED) governs and is not reopened here.

This is an additive extension to a shipped, pure, deterministic scorer. No new
cron, no new agent, no AI call, no new dependency.

---

## 1. Why this lane, why now

Three reasons, in descending order of how much they justify the work.

**1. There is a live false negative in the scorer, today.**
`offdomain_form_exfil` (weight 45, the strongest single signal) reads **only**
`parsed.formActions` — verified at `lib/page-phishing-scorer.ts:174`. It cannot
see `fetch()`, `XMLHttpRequest`, or `sendBeacon`. Modern AI-generated kits
overwhelmingly exfiltrate from inline script, not a form action. Such a page
scores `credential_form` 30 → **MEDIUM**, and a Telegram-exfiltrating credential
harvester sits in the queue looking like a mild finding. This is the same shape
of silent FN that Wave 3's anti-bot-wall work fixed, and **it justifies the lane
on its own even if every AI-specific signal below is eventually retired.**

**2. The detection evidence is published and specific.** Netcraft identified
~100,000 AI-generated sites impersonating ~200 brands and states it detects them
by looking for code patterns suggesting AI generation, "such as included to-do
lists." That is a deterministic, implementable tell — not a model-scored one.

**3. The presentation layer has to exist anyway.** Wave 3's `page_signals` and
`page_anti_bot_wall` shipped with **no renderer at all**: `useLookalikes` has
zero call sites, and no `page_*` field appears anywhere in either SPA. Lane 3 is
the cheapest place to build the weighted-evidence component every later lane
needs, and doing so retroactively surfaces work already shipped.

---

## 2. The reframe: three classes, not one family

Lane 3 as originally written bundled five candidate families under one heading.
They measure different things and must not share rules.

| Class | Question it answers | Authority |
|---|---|---|
| **A — synthetic build** | "Was this page machine-built and shipped unreviewed?" | **Capped at 20 total. No floors. Never triage-visible.** |
| **B — exfil sink** | "Does this page ship credentials to a covert channel?" | Real weight, one floor, triage-visible (keep-only) |
| **C — payload structure** | "Does this page carry a malicious payload?" | Real weight, no floor |
| **M — metadata** | Grouping dimensions for clustering | **Weight 0.** Never scored |

**Why the split is load-bearing.** A Class A signal is a proxy for *disposable
mass production*, not for malice — a legitimate small business using an AI site
builder trips them. Give that family real weight and you have built an AI-ness
scorer wearing a phishing scorer's clothes, which is the §3.1 doctrine violation
arriving by the side door at page scope instead of message scope. Class B has
nothing to do with AI at all; it co-occurs with AI-built kits only because the
model writes the easiest exfil path it knows.

---

## 3. Architecture

### 3.1 Signal set

Existing anchors for weight calibration: `offdomain_form_exfil` 45,
`credential_form` 30, `anti_bot_wall` 20, `cloaking_redirect` 20,
`brand_asset_hotlink` 15, `favicon_clone` 12, `title_keyword_density` 10.
Escalation: 30 → MEDIUM, 60 → HIGH, `credentialHarvest` → CRITICAL.

| Key | Class | Weight | Floor | Triage | FP risk |
|---|---|---|---|---|---|
| `covert_exfil_sink` | B | **20** | **HIGH** | keep-only | very low |
| `form_relay_sink` | B | 10 | no | no | high alone, low with `credential_form` |
| `svg_script_payload` | C | 15 | no | no | very low |
| `llm_refusal_leakage` | A | 15 | no | no | low precision risk, **high decay risk** |
| `unrendered_template_token` | A | 12 | no | no | low |
| `default_scaffold_title` | A | 12 | no | no | low–moderate |
| `build_placeholder_text` | A | 8 | no | no | moderate |
| `agent_scaffold_comment` | A | 8 | no | no | **high if implemented naively** |

**Class A contribution is `Math.min(20, sum)`.** Individual weights express
relative confidence *within* the family; the cap expresses confidence *in* the
family. Both numbers are intentional — do not "fix" the fact that they sum past
the cap.

#### B1 `covert_exfil_sink` — 20, HIGH floor

Literal host+path prefixes in a `formActions` entry **or** a quoted string in
the already-captured 40 KB inline-script sample:
`discord.com/api/webhooks/`, `discordapp.com/api/webhooks/`,
`api.telegram.org/bot`, `hooks.slack.com/services/`. Plus two structural
variants: a form action whose host is a bare IP literal, and a target on
`*.ngrok.io` / `*.ngrok-free.app` / `*.trycloudflare.com` / `*.loca.lt`.

The script-literal leg is the point. Extract it exactly as
`extractJsRedirectTargets` already does (`lib/page-fetch.ts:321-353`) — marker
literal, then the next quoted segment — with markers `fetch(`, `.open(`,
`XMLHttpRequest`, `navigator.sendBeacon(`, `axios.post(`.

*FP analysis.* Near-zero, and this is the one place to say so without hedging:
reaching these endpoints from a browser page requires embedding the bot token or
webhook secret in client-side JavaScript. No legitimate production site does
this deliberately. Residual FP set is hobbyist Discord-ping widgets and CI
dashboards — none of which live on a registered lookalike of a monitored brand.

*Stacking with `offdomain_form_exfil` to 65 is deliberate*, not a double-count
bug: two distinct facts (off-domain, and a *named covert channel*). 65 → HIGH
for a form posting to a Telegram bot with no password field is correct — OTP,
card and SSN fields are `type=text`.

#### B2 `form_relay_sink` — 10, no floor

`docs.google.com/forms/` + `/formResponse`, `formspree.io`, `formsubmit.co`,
`getform.io`, `web3forms.com`, `staticforms.xyz`, `usebasin.com`, `herotofu.com`.

*Near-useless alone* — these are the default contact-form backend for a large
share of legitimate static sites. It earns 10 points only because in this
population it nearly always co-occurs with `credential_form`, and "legitimate
contact form" and "password input" do not co-occur. The additive math already
handles the asymmetry (10 alone = LOW; 10 + 30 = 40 → MEDIUM). **No gate needed.**

#### C1 `svg_script_payload` — 15, no floor

Either an inline `<svg>` subtree containing `<script>`, `<foreignObject>`, or an
`on*` attribute; **or** an `<a download="…">` whose `href` is a
`data:image/svg+xml` URI while the download filename ends `.pdf`/`.docx`/`.xlsx`.

The `on*` leg is a **real prefix test over the element's actual attributes**
(`Element.attributes: IterableIterator<string[]>` — HTMLRewriter does expose
them), not a closed list of guessed handler names. The handler set is
open-ended and vendor-extensible; a closed list silently misses `onmouseout`,
`onpointerdown`, `onwheel`, `oninput`, `onauxclick`, `oncopy`, `onscroll` and
more, on a weight-15 signal whose FP population is near zero.

Variant (b) has an FP population of approximately zero — a genuine PDF is not an
SVG.

#### A1 `llm_refusal_leakage` — 15

Case-insensitive literal scan over `title` + `bodyTextSample` + script sample:
`as an ai language model`, `as a large language model`, `i cannot assist with`,
`i can't assist with`, `i'm sorry, but i can't`, `i cannot create content that`,
`i'm unable to provide`, `my knowledge cutoff`, `i'm just an ai`.

*The problem is recall, not precision.* This is a smoking gun the operator fixes
in one pass, and builder tooling is adding output filtering. **Budget for
retiring it** (§6). Its real value is evidentiary — it is the sentence you put
in the takedown notice — which is why 15-capped-into-20 is right and 40 is wrong.

#### A2 `unrendered_template_token` — 12

In `bodyTextSample` **only** (rendered text, not attributes, not script):
`{{` … `}}`, `{%` … `%}`, or `${` … `}` within 64 chars, where the enclosed run
is an identifier (`[A-Za-z_][A-Za-z0-9_. ]*`, ≥3 chars). Best of the scaffolding
family because it is a *structural build failure*, not a string an author chose,
and harder to strip than a comment — the operator must notice the page is broken.

#### A3 `default_scaffold_title` — 12

Trimmed lowercased `title` **exactly equals or starts with** a short closed list:
`create next app`, `vite + react`, `vite app`, `react app`, `document`,
`untitled`, `untitled page`, `my site`, `my app`, `home page`, `nuxt app`,
`svelte app`, `astro`, `streamlit`, `index`, `replit`, `webpage`, `new project`,
`title`.

**Never substring.** Near-mutually-exclusive with `title_keyword_density` by
construction (a default title contains no brand name), so no double-count path.

> **Amended 2026-09-21 — this rule was internally inconsistent as first
> written.** It said "exact or prefix" and justified it with *"never substring,
> or 'document management portal' trips it"* — but **prefix matching trips that
> example too**, via the `document` entry. Code review caught it; Phase 1
> implemented the rule as specified and pinned the real behaviour in a test
> rather than papering over it.
>
> Other prefix-leg firings on legitimate sites: `title` → "Title Insurance
> Services of Ohio"; `index` → "Index of /pub"; `astro` → "Astrology Today";
> `home page` → "Home Page Design Co". §5.3 disqualifies any Class A signal
> firing above 2–3% on brand-canonical homepages, so the likely outcome is that
> A3 — one of the better-motivated signals — gets demoted for reasons that are
> an artifact of the *rule*, not of the *signal*.
>
> **Resolution, to apply before promotion (Phase 2):** split the list in two.
> **Exact-match only** for generic English words that occur naturally in real
> titles — `document`, `index`, `title`, `astro`, `home page`, `webpage`,
> `my site`, `my app`, `new project`, `untitled`. **Prefix-eligible** for
> scaffold-branded strings that no legitimate business title begins with —
> `create next app`, `vite + react`, `vite app`, `react app`, `nuxt app`,
> `svelte app`, `streamlit`, `replit`.
>
> Shadow mode makes this cheap to settle empirically rather than by argument:
> §5.3's negative control will show the actual firing rate of each leg against
> `brands.canonical_domain` before anything scores.

#### A4 `build_placeholder_text` — 8

Literal scan over `bodyTextSample` and comment text: `lorem ipsum`,
`dolor sit amet`, `your company name`, `your brand here`, `your api key`,
`your_api_key`, `api_key_here`, `replace_me`, `replace with your`,
`insert your`, `placeholder text`, `your-domain.com`, `example@example.com`,
`john@example.com`, `+1 (555) 123-4567`, `123-456-7890`.

**Text nodes and comments only — never `placeholder=` attributes**, where these
appear legitimately.

#### A5 `agent_scaffold_comment` — 8

Netcraft's literal stated tell, and the one needing sharpest discipline.
Requires a new bounded comment accumulator (§3.2). Fires when a **single
comment** contains any of: a markdown checkbox (`- [ ]`, `- [x]`, `* [ ]`);
**two or more** `todo:` / `fixme:`; two or more `step <digit>:` or
`<digit>. ` line-starts; or the literals `implementation plan`,
`remaining tasks`, `next steps:`.

> **A bare `TODO` substring match is disqualified.** `TODO` in HTML comments is
> one of the most common strings on the unminified web; implemented naively this
> fires on a large fraction of WordPress themes and is worse than nothing. **The
> structure is the signal; the word is not.**

#### M1 / M2 — metadata, weight 0

- **`page_generator`** — capture `<meta name="generator">`, truncate to 64
  chars, **do not score** (§8 item 5). Value is as a grouping dimension.
  Because it is a grouping dimension and nothing else, the charset is
  restricted **at capture**: `<`, `>`, `"`, `'`, backtick and control
  characters are dropped (`sanitizeGenerator`, `lib/page-fetch.ts`). §3.5
  plans to render this value and the likeliest sinks are not auto-escaping
  (CSV export, briefing email, the §5.5 takedown-notice template), so
  nothing of value is lost and a whole injection class goes with it.
- **`page_exfil_sink` / `page_exfil_sink_id`** — when B1/B2 fires, persist the
  matched sink **host** (bounded to 253 chars, the max legal DNS name, **at
  the extractor** so the bound travels with the value) and, for Telegram, the
  bot id from `api.telegram.org/bot<id>:<token>/`.

> **NEVER persist the full sink URL — here or anywhere.** A Discord webhook
> URL, and a Telegram `bot<id>:<token>` pair, are **live credentials**, not
> identifiers: anyone holding one can post to the attacker's channel (and for
> Telegram, read from it). Storing one turns `lookalike_domains` into a
> credential store for third-party channels and tips off the operator the
> moment it is used. Store the host and the non-secret leading id, nothing
> else. The extractor honours this today — `digitsAfterMarker`'s walk stops at
> the first non-digit, i.e. at the `:` (Telegram) or `/` (Discord) that begins
> the token, and the evidence literal is the matched **prefix**, never the
> reference. **The shared Lane 2 extractor below inherits this constraint and
> may not widen the walk past the token boundary.**

> **`page_exfil_sink_id` is the highest actor-intelligence artifact in this
> spec.** One Telegram bot serves many kits across many brands; it is a C2
> identifier in the ordinary IOC sense, published in client-side JavaScript by
> the operator. **This is the same primitive as Lane 2's attribution Tier 1**
> (plan §13.4) — a sink extracted from a page and a sink extracted from a
> package payload are the same kind of evidence and should share one extractor
> and one persistence shape. Design them together.

### 3.2 Extraction — `lib/page-fetch.ts`

**Hard constraint: no regex over attacker HTML.** The file's SSRF/ReDoS contract
(`:394-412`) uses bounded `.includes` and hand-rolled token walks. Every signal
above is implementable that way; the "regex shapes" in §3.1 are descriptive.
**A reviewer must reject any regex in this path.**

Accumulators are declared at `:361-374`, the HTMLRewriter chain at `:414-511`,
post-transform text scan at `:521-527`, return literal at `:529-539`.

**Three structural facts that shape the work:**

1. **`ParsedPageSignals` lives in the scorer** (`page-phishing-scorer.ts:27-51`),
   not the fetcher. Adding a field means editing the scorer file.
2. **There is no `comments()` handler anywhere.** HTML comments — the carrier
   for A5 and part of A4 — are currently *completely invisible*. This is a new
   handler plus a new bounded accumulator (`MAX_COMMENT_SAMPLE = 8_192`,
   following the `MAX_BODY_SAMPLE` idiom at `:313`). Register it via
   **`onDocument({ comments })`, not `.on('*', { comments })`** — `*` matches
   *elements*, so a comment with no open element ancestor (before
   `<!DOCTYPE html>`/`<html>`, or after `</html>`) is never delivered, and that
   prologue/epilogue is exactly where builder banner comments
   (`<!-- Generated by … -->`) sit. `onDocument` also costs nothing per
   element over up to 512 KB of hostile input.
3. **The raw body is live only between `fetchSuspectPage:613` and `:624`.**
   After that only sampled slices survive: 20 KB of `<body>` text, 40 KB of
   `<script>` text, 300 chars of title — and nothing from `<head>`, attributes,
   or comments. Every signal here is designed to work within the sampled slices
   plus the new comment accumulator. **No signal in this spec requires the full
   body**, which keeps the change out of `fetchSuspectPage` entirely.

### 3.3 Scoring — `lib/page-phishing-scorer.ts`

Module is **pure** — two pure imports, no `env`, no `fetch`, no `Date`. Keep it
that way.

- New weights into `SIGNAL_WEIGHTS` (`:89-107`). `PageSignalKey` is
  `keyof typeof SIGNAL_WEIGHTS` (`:109`), so the union widens automatically.
- New signal blocks slot between `:259` and `:261` — after the last signal,
  before the score sum — the same place `anti_bot_wall` was added.
- **Class A cap** applied to the Class A subtotal before the sum at `:261-263`.
- **`credentialHarvest` (`:265`) extends to:**
  `credential_form && (offdomain_form_exfil || covert_exfil_sink)`.

> **The sentence that gets this past `appsec-reviewer`:** widening
> `credentialHarvest` is safe *in the triage direction*. Its only triage
> consumer (`lib/alert-triage.ts:123`) reads `page_credential_harvest === 1` to
> return `{ action: 'keep' }`; `dismiss` is the fallthrough. Widening it
> therefore produces **more human review, never more dismissals.**

- **New HIGH floor for `covert_exfil_sink`** in `escalateThreatLevelForPage`
  (`:299-309`), inserted after the `credentialHarvest` branch and before
  `score >= 60`. The terminal monotonic guard at `:308` is untouched.

> **Gotcha:** the wall flag is derived *caller-side* in **two** places —
> `scanners/lookalike-page-analysis.ts:139` and
> `scanners/lookalike-domains.ts:285`. A new floor flag must be derived in
> **both**, or the inline live-scan path and the batch sweep will disagree.

#### The cap arithmetic — why 20 and not 25

| Scenario | Without Class A | With capped Class A |
|---|---|---|
| All five Class A fire, nothing else | 0 → LOW | 20 → **LOW** |
| Brand name in title only | 10 → LOW | 30 → MEDIUM |
| Hotlink + favicon + title | 37 → MEDIUM | 57 → **MEDIUM** |
| Credential form only | 30 → MEDIUM | 50 → MEDIUM |
| Credential + off-domain | CRITICAL | CRITICAL |

Two properties must hold: **Class A can never reach MEDIUM alone**, and **Class
A can never flip MEDIUM → HIGH.** At 25 the second breaks (37 + 25 = 62 → HIGH).
Hence 20.

### 3.4 Persistence — one migration

Next free number is `0264`+ (verify against the directory). Template is
`0260_lookalike_anti_bot_wall.sql`: prose rationale, explicit NULL semantics, an
indented per-column data dictionary, `ADD COLUMN` only, **no index** (low
cardinality, consumed by a cached diagnostics `GROUP BY`).

Columns on `lookalike_domains`:

| Column | Type | Purpose |
|---|---|---|
| `page_ai_signals` | TEXT | JSON array of fired Class A/B/C keys — **shadow mode**, §5 |
| `page_score_delta` | INTEGER | Would-be score contribution — **shadow mode**, §5 |
| `page_generator` | TEXT | M1 grouping dimension |
| `page_exfil_sink` | TEXT | M2 matched sink host |
| `page_exfil_sink_id` | TEXT | M2 bot/webhook id — the pivot key |
| `page_evidence` | TEXT | JSON: matched literal per firing, truncated 64 chars (§5.5) |

Written **only** in the success UPDATE (`lookalike-page-analysis.ts:92-104`).
The failure path (`:111-117`) deliberately preserves prior verdicts and must
leave every new column untouched.

### 3.5 UI — the part that does not exist yet

**Staff SPA: there is no mount point.** `useLookalikes`
(`hooks/useLookalikes.ts:26`) has **zero call sites**; the Risk tab's
`TyposquatsSection` (`BrandDetail.tsx:753`) reads `threats`, not
`lookalike_domains`. We are *creating* a surface.

- **Staff API needs no change.** `handleListLookalikes`
  (`handlers/lookalikeDomains.ts:85`) is already `SELECT *`, so every `page_*`
  column is already in the payload. Only the `LookalikeDomain` interface
  (`useLookalikes.ts:4-16`) must gain the fields.
- **Component: `SignalBreakdownCard`.** `ScoreBreakdownCard`
  (`features/leads/components/ScoreBreakdownCard.tsx`) is the only
  weighted-evidence component in the platform, has one call site, is
  lead-specific, and — critically — **expects `{key: weight}` while
  `page_signals` is an array of fired keys with no weights.** So this is a
  sibling, not a reuse: move both under `components/ui/`, share the row/badge
  presentation, and give the new one a `PageSignalKey → label` map plus the
  weight table.
- **Mount:** a new section in `RiskTab` (`BrandDetail.tsx:660-761`), alongside
  `TyposquatsSection` at `:753`.
- **Tenant** needs the SELECT widened — `tenantDomainModule.ts:267-269` is an
  explicit column list — plus both `LookalikeRow` interfaces
  (`tenantDomainModule.ts` server copy, `lib/domainModule.ts:47-63` client).
  Render target is precise: the existing "Signals" column inside
  `LookalikesSection` (`BrandDomainFindings.tsx:337`, columns at `:351-368`).
- **Empty states** must distinguish *never scanned* from *checked and clean*
  (plan §13.5). Mockups: https://claude.ai/artifact/NbEwoJWjbiR2Lbu3g4EgJY
  *(private — needs sharing before reviewers can open it)*.

**Alerts — the cheapest write-side change in the codebase.** The lookalike
scanner already has `phishing.signals` and `phishing.score` in scope at
`scanners/lookalike-domains.ts:281-288`, then discards them before `createAlert`
at `:318-326`. Widening that `details` object is a few lines and makes every
`lookalike_domain_active` alert carry its evidence.

---

## 4. Guardrails — non-negotiable

1. **No regex over attacker HTML.** Bounded `.includes` / token walks only.
2. **Positive-only.** No signal's absence means "human-authored" or "safe."
   Netcraft's 100,000 is a *found* set with unknown denominator.
3. **Never gate a dismissal.** These may raise a threat level, withhold a
   dismissal, or annotate. They may never dismiss, never lower a score, never
   enter `decideThreatAutoTriage`'s safe-path conditions, and never feed
   `alert-ai-judge`'s auto-dismiss path. Same standing as `weaponization_flag`
   and `page_anti_bot_wall`.
4. **Nothing here writes `phishing_pattern_signals.ai_generated_probability`.**
   It is pinned NULL at type and runtime level; writing it is a doctrine
   reversal, not a code change (plan §3.1).
5. **Class A never sets a floor and never enters triage.**
6. **Every percentage in diagnostics carries its raw `n`; no rate is acted on
   below n = 30.** The population ceiling is ~480 analyses/day (20/run, hourly,
   24 h per-domain cadence, `EXISTS (org_brands)` gate).
7. **No new cron.** Rides `22 * * * *` via the existing scanner, so the
   cron-audit rule stays untriggered.
8. **No page-HTML retention.** §5.5 captures bounded typed extracts instead.

---

## 5. Validation — shadow mode first

You cannot measure precision without labels. So measure what needs no labels,
manufacture the cheapest labels at the decision point, and report honest
intervals.

**5.1 Shadow mode for two full cadence cycles (~2 weeks).** Compute and persist
`page_ai_signals` + `page_score_delta`, but **do not** let them touch
`page_phishing_score`, `threat_level`, or `credentialHarvest`. Promote
signal-by-signal, not all at once. This is the single most important step — it
catches a "fires on 40% of pages" failure before an operator ever sees it.

**5.2 Positive control, free.** Rows already carrying
`page_phishing_score >= 60` or `credentialHarvest` are a high-confidence
malicious label set built by signals the new ones don't depend on. Report **lift
ratio** per signal: firing rate inside that set vs its complement. **Lift ≈ 1.0
means the signal measures builder popularity, not phishing → demote to
metadata.** This is the promotion gate out of shadow mode.

**5.3 Negative control, also free.** Run the identical path against a stratified
sample of `brands.canonical_domain` — known-legitimate sites, plenty on
WordPress/Wix/Webflow. **Any Class A signal firing on >2–3% of brand-canonical
homepages is disqualified as a scored signal.** Stratify toward the long tail of
the 9,652-brand catalog, not the enterprise head. *Honest caveat:* brand
homepages are not login pages, so this measures the builder-popularity FP mode
well and the unfinished-page FP mode poorly.

**5.4 One human adjudication round, N = 50, once.** ~2 analyst-hours. Report the
precision estimate **with its actual interval** — at N = 50 that is roughly ±14
points. Crude and honest beats precise and invented. Per July §2.3, this number
probably should not appear in customer-facing material at all.

**5.5 Capture evidence at fetch time.** Because only a SHA-256 is retained,
retrospective validation is impossible and every method above is forward-looking.
So during shadow mode persist the **matched literal, truncated to 64 chars**,
per firing (`page_evidence`). Without it an analyst adjudicating
"`llm_refusal_leakage` fired on acme-secure-login.com" has nothing to examine
and §5.4 is impossible. Keep it after promotion — it is also the takedown line.

**5.6 Schedule the decay re-measurement.** Every Class A signal is one minifier
pass from zero recall. Re-run §5.2 quarterly. **Retirement is the planned end
state for `agent_scaffold_comment` and `llm_refusal_leakage`** — name it here so
their eventual death is an outcome, not an incident.

---

## 6. Measurability

Extend the `page_analysis` block (`handlers/diagnostics.ts:391-444`,
`cachedValue` key `diag.page_analysis.cloaking.v2`, TTL 600 s — **bump the
version suffix on every response-shape change**, or a deploy keeps serving the
old shape out of KV for a whole TTL).

> **One pass, with a `LIMIT`.** The block reads `lookalike_domains` exactly
> once under `page_fetched_at IS NOT NULL` and aggregates everything
> (`fetched_ok`, `walls_observed`, `by_family`, and all of `ai_build` /
> `exfil` / `generator`) in the Worker. It carries an explicit row cap and
> sets `truncated` when the population exceeds it, so the block degrades
> **visibly** rather than silently under-reporting.

> **Do not add eight `LIKE '%"key"%'` scans** over the `page_signals` TEXT
> column — that is the dead-index full-scan failure class, multiplied by eight.
> Do one pass selecting `page_signals` where `page_fetched_at IS NOT NULL` and
> aggregate in the Worker, as the existing block already does.

| Field | Answers | Alarm |
|---|---|---|
| `ai_build.by_signal[]` | Is each signal alive? | **0.0% for 30 days → extractor broken or signal dead.** **>15% of fetched_ok → builder-popularity detector; demote** |
| `ai_build.class_a_cap_hits` | Does the cap bind? | ~0 → cap is theatre; high → family noisier than modelled |
| `ai_build.escalations_attributable` | **The one that matters** — escalations that would not have happened without Class A | Near-zero → Class A is decorative, make it metadata-only |
| `ai_build.persisted_delta_drift` | Rows whose stored `page_score_delta` disagrees with the delta recomputed from `page_ai_signals` | Non-zero → the weight table moved under stored rows; should decay on the 24 h re-analysis cadence, and a value that does not decay is a writer bug |

> **The counterfactual band model must mirror ALL FOUR branches of
> `escalateThreatLevelForPage`** — `credentialHarvest → CRITICAL`,
> `>= 60 → HIGH`, `>= 30 → MEDIUM`, and the bare-anti-bot-wall
> `→ MEDIUM` floor. Modelling only the two score thresholds counts a page
> that was *already* MEDIUM because of a wall as a Class A escalation Class A
> did not cause, and anti-bot walls are the most common finding on this
> population — so the error can dominate the very metric that decides Class A's
> promotion. `pageScoreBand` is exported and pinned against the real escalation
> function in `test/page-analysis-diag-band.test.ts`; keep them in lockstep.
| `exfil.by_sink_host[]` | Campaign mix | Actor intelligence, not health telemetry |
| `exfil.distinct_sink_ids` | Distinct sink ids ÷ firings | Far below 1.0 → one operator running many kits — **the clustering finding this lane exists to produce** |
| `generator.by_token[]` | Builder-mix baseline | Also permanently falsifies any future proposal to score the generator tag |
| `by_fetch_outcome[]` | **The current block's real gap** — `fetched_ok` has no denominator breakdown, so failures are invisible | See below |

> **`by_fetch_outcome[]` is last-pass only for rows that have NEVER succeeded —
> ever-succeeded otherwise.** Amended 2026-09-21; code review caught the
> overclaim in the original text. Outcome is inferred from
> `page_ai_signals IS NULL` plus `page_http_status`, and §3.4 deliberately has
> the failure path preserve prior verdicts. So once a row has ever been scored
> it reads `scored` forever: a lookalike analyzed successfully on day 1 that
> then sits behind a Cloudflare challenge returning 403 for thirty days keeps
> counting as `scored`, `not_scored_http_error` stays at 0, and its **stale**
> signal set keeps feeding `ai_build.*` firing rates.
>
> As written the field therefore closes the gap only for never-succeeded rows.
> Closing it properly needs a **per-pass marker** — a `page_last_outcome TEXT`
> column stamped by *both* branches — which is a schema change, so it is a
> Phase 2 item rather than a silent fix. Until then, read
> `ai_build.by_signal[]` as "rates over rows last *successfully* scored at some
> point", not "rates over rows fetched this cycle".

> **`oversize_declared` deserves its own watch.** `MAX_BYTES` is 512 KB with an
> early reject on declared `content-length`, and AI-builder output (inlined
> Tailwind, hydration payloads, base64 assets) is systematically fatter than
> hand-written kits. **This signal family may be structurally biased against the
> exact population it targets, and right now that bias is unmeasurable.** If
> `oversize_declared` turns out material, raising `MAX_BYTES` for this pass is a
> bigger recall win than any individual signal above.

Keep `ai_build.*` and `exfil.*` structurally separate in the JSON — different
classes, different authority. Collapsing them in diagnostics is the first step
toward collapsing them in the scorer.

---

## 7. Two defects found en route — one fixed, one re-scoped

**7.1 The test D1 mock dropped a bind. ✅ FIXED (Phase 1).**
`lookalike-page-analysis.ts` bound **six** values to the success UPDATE;
`test/lookalike-page-analysis.test.ts:61-62` destructured **five** —
`[status, score, signals, hash, id]`. `id` therefore received
`antiBotWallFamily`, the row lookup missed, and **the success-path write was a
silent no-op in tests.** Masked because the only test exercising
`runPageAnalysisForDomain` covered the *failure* path.

Now destructured at the real arity (12 after `0264`), with a success-path test
asserting each column lands on the right row, computing the expected
`PagePhishingResult` independently via the real `scorePagePhishing` rather than
against coincidental defaults. **Verified by mutation:** reintroducing the
5-arg destructure makes the new test fail with `page_fetched_at` null. A test
that cannot fail is worse than no test, so the mutation check — not the green
run — is the evidence.

**7.2 `test/` is never typechecked. ⬜ OPEN — re-scoped, deliberately not fixed
here.** `tsconfig.json` `include` is `["src/**/*.ts", "scripts/**/*.ts"]`, so a
fixture missing a required field on `PagePhishingResult` or `ParsedPageSignals`
compiles fine.

This spec originally framed it as "fix a couple of fixtures." **That was wrong.**
Adding `test/**/*.ts` surfaces **174 errors across 46 files**, none of them in
the Lane-3-relevant ones. Measured breakdown:

- **~59% `TS2532`/`TS18048` possibly-undefined** — `noUncheckedIndexedAccess`
  is on and working correctly; the test code simply predates a check that was
  never run against it. A discipline gap, not a `strict`-setting problem.
- **~22% `TS2741`/`TS2740`/`TS2739` missing properties** — fixtures that
  silently rotted when interfaces gained required fields (`AuthContext` gained
  `enrollOnly`; `AgentModule` gained six). **This is the same defect class as
  7.1**: a real interface changed and test fixtures kept compiling because
  nothing typechecked them.
- Remainder: vitest `Mock` typing friction, a `ResourceDecl` property rename,
  an `ArrayBuffer`/`SharedArrayBuffer` mismatch.

None is `src/` drift. It is a real latent problem and worth doing — as its own
scoped change across ~46 files, not bundled into a detection PR where it would
bury the diff. **Consequence to remember:** while this stays open, the `??`
fallbacks in `computeShadowPageSignals` are load-bearing, because legacy
fixtures can still hand it `undefined`.

Also note the **test HTMLRewriter shim** (`test/page-fetch-antibot-wall.test.ts`).
It originally supported only tag selectors plus the literal `"[class]"` and had
no `comments()` support. It has since been extended with `svg *` (a real
ancestor-stack descendant check), `onDocument({ comments })` document-wide
comment delivery, and `Element.attributes` as an `IterableIterator<[name,
value]>` mirroring the runtime — so A5, the prologue/epilogue comment coverage,
and the `on*` prefix walk are all exercised against fixture HTML.

---

## 8. What this deliberately does NOT do

In roughly the order these will be proposed in review:

1. **Any per-page "AI-written probability"** — perplexity, burstiness,
   sentence-length variance, em-dash density, LLM-slop vocabulary lists. This is
   §3.1 MGT detection re-entering at page scope, inheriting the Liang et al.
   ~61% FP profile against non-native-English authors — which at page scope makes
   it a detector of *legitimate non-English-first-language businesses*. **Hard
   reject.** Expect this to be proposed, because it is cheap.
2. **"Business-jargon padding"** — item 1 with a different name, notwithstanding
   that it appears in the Microsoft writeup (an analyst observation, not a
   production detector).
3. **Verbose-descriptive-plus-hex identifier morphology** — Webpack, CSS Modules
   and styled-components emit exactly this shape. FP mode is "any site built this
   decade."
4. **Over-modularization / import-graph heuristics** — needs an AST and a bundle
   crawl; we have neither and bundling destroys the structure anyway.
5. **Scoring the `meta generator` tag** — WordPress alone is ~43% of the web.
   Capture as metadata, score at zero, use for clustering.
6. **Ephemeral-host scoring** (`*.vercel.app`, `*.pages.dev`) — item 5 one step
   removed. A filter dimension, not evidence.
7. **Fetching linked JS bundles** — blows the SSRF allowlist, the 512 KB cap, the
   `text/html` contract and the 120 s run budget simultaneously. Design to the
   40 KB inline sample.
8. **Retaining page HTML "for later validation"** — §5.5 exists specifically to
   avoid needing it.

---

## 9. Implementation checklist

Per `CLAUDE.md` §1A each step runs the full pipeline. Owners in brackets.

**Phase 1 — shadow mode. ✅ COMPLETE (merged 2026-09-21, PR #1713).**
1. ✅ Migration `0264` (six columns, no index).
2. ✅ Comment accumulator + document-wide `onDocument({ comments })` +
   `MAX_COMMENT_SAMPLE`; script-literal sink extractor.
3. ✅ New `ParsedPageSignals` fields; eight signals + Class A cap, in a fenced
   shadow section with its own `SHADOW_SIGNAL_WEIGHTS` / `ShadowSignalKey`.
4. ✅ Six columns persisted in the success UPDATE only.
5. ✅ Defect 7.1 fixed (7.2 re-scoped — see §7); shim extended for
   `comments()`, `svg *` and `Element.attributes`.
6. ✅ Scorer + extraction + helper tests. 2276 → 2375 green.
7. ✅ Diagnostics `ai_build.*` / `exfil.*` / `generator.*` / `by_fetch_outcome[]`.

*Review round (code + appsec + qa-verify) also landed: the unbounded
`page_exfil_sink` column, the four-branch escalation band, the guarded shadow
call, `onDocument` comments, the real `on*` attribute walk, generator charset
restriction, one-pass diagnostics, and the versioned cache key.*

**Phase 2 — promotion. ⬜ BLOCKED — see §11 before starting.**
8. Remove the shadow flag **per signal, as each clears its §5.2/§5.3 gate** —
   not all at once. *[backend-engineer + threat-intel-analyst]*
9. `credentialHarvest` extension + `covert_exfil_sink` HIGH floor, **with the
   flag derived in both caller sites** (`lookalike-page-analysis.ts` and
   `lookalike-domains.ts` — they diverge silently if only one is updated).
   *[backend-engineer]*
10. Apply the §3.1 A3 two-tier list resolution before `default_scaffold_title`
    is promoted. *[threat-intel-analyst]*
11. `page_last_outcome` column so `by_fetch_outcome[]` is per-pass (§6).
    *[backend-engineer]*
12. `appsec-reviewer` pass on the triage-direction argument (§3.3) — **which
    requires §11.1 to be resolved first, or the argument is vacuous.**
    *[appsec-reviewer]*

**Phase 3 — surface. ⬜ Not started. Independent of Phase 2 — can run in
parallel**, since rendering shadow columns does not require promoting them.
13. `SignalBreakdownCard` under `components/ui/`; `LookalikeDomain` interface
    widened (the staff API is already `SELECT *`, so no handler change).
    *[frontend-engineer]*
14. Mount in `RiskTab`; empty states per §3.5 — *checked and clean* must not
    look like *never scanned*. *[frontend-engineer + design-reviewer]*
15. Tenant SELECT + both `LookalikeRow` interfaces + the "Signals" column.
    **Defang `page_exfil_sink` at every render site** — never a clickable link;
    an operator clicking it requests live attacker C2 from a corporate network.
    *[backend-engineer + frontend-engineer]*
16. Widen `lookalike_domain_active` alert `details` — the cheapest write-side
    change available, since `phishing.signals` and `phishing.score` are already
    in scope at the `createAlert` site and currently discarded.
    *[backend-engineer]*
17. Docs: `THREAT_FEEDS.md`, `API_REFERENCE.md` if endpoints change,
    `PLATFORM_DATA_DEPENDENCIES.md` §1, `CLAUDE.md` §10 diagnostics table.
    *[docs-maintainer]*

**Gate before each phase ships:** `npx tsc --noEmit` (worker + ops),
`pnpm check:resource-drift`, `pnpm test`, plus `qa-verifier` driving the flow
end-to-end. *[qa-verifier]*

---

## 10. Sequencing note

Phase 1 is independent of every other lane and can start immediately. Phase 3
builds the weighted-evidence component the whole plan depends on, so it should
not be deferred past this lane — deferring it is how `page_signals` became
invisible in the first place.

**Phase 2 cannot start on a schedule — it starts on evidence.** §5.1 requires
two full cadence cycles (~2 weeks) of shadow data before any signal is promoted,
and §5.2/§5.3 are per-signal gates, not a single go/no-go. The population
ceiling is ~480 analyses/day, so the practical constraint is data volume, not
engineering time. **Do not let "Phase 1 is done" read as "Phase 2 is ready."**

**Coordinate the sink extractor with Lane 2** (plan §13.4 Tier 1): a sink
extracted from a page and a sink extracted from a package payload are the same
evidence and should share one extractor and one persistence shape. Building them
twice is the avoidable mistake here.

---

## 11. What Phase 2 is blocked on

Added 2026-09-21 after the Phase 1 review round. Work these in order; 11.1 is
the one that changes an argument rather than a line of code.

### 11.1 `page_credential_harvest` has no producer — the triage-safety argument is currently vacuous

§3.3 justifies widening `credentialHarvest` with: *"its only triage consumer
(`lib/alert-triage.ts:123`) reads `page_credential_harvest === 1` to return
`{ action: 'keep' }`; `dismiss` is the fallthrough — so widening produces more
human review, never more dismissals."* That reasoning is sound **and currently
means nothing**, because the field is never populated.

Verified: `page_credential_harvest` appears in exactly three places across all
of `src/` — the optional field declaration (`alert-triage.ts:63`) and the guard
(`:123-124`). `loadThreatSnapshotForAlert` selects from `threats`, and neither
`lookalike-page-analysis.ts` nor `lookalike-domains.ts` ever writes it into a
triage snapshot. **The guard never fires either way.**

So Phase 2 as specified would ship a widened definition whose only claimed
safety property is unobservable. **Wire the producer first, re-review, and only
then make the §3.3 argument** — otherwise the `appsec-reviewer` sign-off in
step 12 is approving a property nobody can test.

### 11.2 The A3 rule needs its two-tier split before `default_scaffold_title` is promoted

§3.1 A3, amended. The prefix leg fires on legitimate titles ("Title Insurance
Services of Ohio", "Index of /pub"), and §5.3 would then demote a
well-motivated signal for a rule artifact. Split the list — exact-only for
generic English words, prefix-eligible for scaffold-branded strings — before
the gate is run, not after it fails.

### 11.3 `by_fetch_outcome[]` needs a per-pass marker before its rates are trusted

§6, amended. Until `page_last_outcome` exists, a row that succeeded once and has
403'd for a month still reads `scored` and still contributes its **stale** signal
set to `ai_build.by_signal[]`. Those are the rates §5.2's lift measurement
depends on. Land the column early in Phase 2 so the gate data is clean.

### 11.4 `oversize_declared` is still not individually visible

§6. `rejectedReason` is not persisted, so the outcome breakdown conflates
non-HTML with oversize. `MAX_BYTES` is 512 KB and AI-builder output is
systematically fatter than hand-written kits — **this signal family may be
structurally biased against the exact population it targets, and the bias
remains unmeasurable.** If it turns out material, raising `MAX_BYTES` for this
pass is a bigger recall win than any individual signal in §3.1. Splitting it
needs the same persisted-reason work as 11.3, so do them together.

### 11.5 Evasion is expected and must not be misread as a dead signal

Every bounded cap in §3.2 is evadable by padding: 32 decoy `fetch()` calls
before the real one defeats `covert_exfil_sink`; 64 one-character comments
exhaust `MAX_COMMENTS` before the real scaffold comment. These bounds are
required by the ReDoS contract and every signal here is positive-only, so the
consequence is **recall loss, not a safety inversion**.

It matters for interpretation: when §5.2's lift measurement shows a signal
at 0%, that is evidence of *either* death *or* evasion, and §5.6 says
`agent_scaffold_comment` and `llm_refusal_leakage` are expected to decay
anyway. Do not let an evaded signal be retired as a dead one without checking
`page_evidence` on the rows that did fire.
