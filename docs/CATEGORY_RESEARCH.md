# CATEGORY_RESEARCH.md — Averrow positioning + competitive landscape

## Status

Working draft. Built incrementally per the planning session 2026-04-30.
External research will be folded in as it lands (operator may
contribute findings from other AI platforms; vendor names omitted
throughout per project policy).

---

## 1. Problem statement

> How can companies determine their brand's exposure online?

Companies invest years building a brand — name, logo, domains,
likeness, customer trust. Online attackers exploit that brand to
phish customers, host malware on lookalike domains, run social
impersonation campaigns, sell counterfeit goods, leak credentials
on dark-web forums, and submit malicious app-store listings.

The questions a brand-protection operator actually needs answered:

- **Who** is impersonating, attacking, or diminishing the brand?
- **What** resources are being abused (domains, logos, names, social
  handles, employee identities)?
- **Where** is the abuse hosted (provider, jurisdiction)?
- **How** does the campaign tie to other attacks (same actor, same
  tooling, same pivot pattern)?
- **What's next** — what infrastructure are they prepping?

Most platforms answer the first half. Averrow's positioning is the
second half: tying signal to threat actors, tracking pivots,
fingerprinting MO + tooling, surfacing geopolitical and provider-
abuse context, and acting on it automatically.

---

## 2. Category baseline — table stakes

Every credible brand-protection / digital-risk-protection platform
in this category ships some combination of the following. These
are not differentiators — they're the price of entry.

### 2.1 Detection surfaces

- **Lookalike / typosquat domain monitoring** — registrar feeds,
  passive DNS, certificate transparency.
- **Phishing URL detection** — Google Safe Browsing, PhishTank,
  abuse.ch, OpenPhish, internal scanners.
- **Email authentication posture** — DMARC / SPF / DKIM / MX /
  BIMI / VMC scoring per monitored domain.
- **Social media impersonation** — fake accounts, profile
  imitation, trademark abuse on the major platforms.
- **App-store impersonation** — counterfeit apps on iOS / Google
  Play / third-party stores.
- **Dark-web mention monitoring** — breach exposure, credential
  dumps, forum chatter mentioning the brand or executives.
- **Mobile / SDK abuse** — rogue apps, sideloaded variants.

### 2.2 Operational pipeline

- **IOC enrichment** — IP geo, ASN, hosting-provider attribution,
  WHOIS, SSL cert details.
- **Threat scoring** — severity buckets, confidence scores.
- **Alert / notification system** — email, in-app, sometimes SMS
  or PagerDuty.
- **Takedown automation** — submission to registrars, hosting
  providers, social platforms, app stores.
- **Reporting / dashboards** — exposure trend, takedown SLA,
  brand-by-brand drilldown.
- **Multi-tenant org / RBAC** — for service providers and
  enterprises with sub-brands.

### 2.3 Intelligence layer

- **Threat-actor profiles** — named groups, TTPs, geographies.
- **Campaign correlation** — clustering threats that share IP /
  ASN / domain pattern.
- **Geopolitical event tagging** — campaigns linked to nation-
  state activity.
- **Industry sector benchmarking** — "how exposed are you vs your
  peers."

### 2.4 Onboarding (the friction every customer feels)

This is where every platform looks the same and every customer
groans. The standard onboarding:

- Customer manually enters every brand they want monitored.
- Customer uploads logo files, BIMI SVG, brand colors.
- Customer configures social handles per platform.
- Customer adds domains they own + variants they care about.
- Customer configures alert routing, severity thresholds, etc.
- Customer waits 24-72 hours for the platform to build a baseline.

By design this is sticky — once configured, switching costs are
high. By accident this is also the biggest competitive gap in
the category (covered in §3 + §8).

## 3. Where the category is weak

The baseline in §2 is well-served. Where the category collectively
falls short — and where Averrow's positioning bites:

### 3.1 Threat-actor attribution beyond "we saw a phish"

Most platforms surface a malicious URL with severity, source feed,
hosting provider, and a takedown button. Once takedown succeeds,
the row goes "resolved" and disappears from the dashboard. The
actual question — *who launched this and what else are they doing
right now* — is rarely surfaced, much less acted on.

Indicators that should bind a phish to an actor (and don't, in
most platforms):

- ASN reuse across campaigns weeks apart
- Registrar + name-server fingerprint
- TLS issuer + cert validity-window pattern
- Phish-kit fingerprints (HTML structure, asset hashes, login-form
  POST targets)
- Hosting-provider hop sequence over time
- Time-of-day / day-of-week signing patterns
- Telegram / Discord channel mentions of the same kit

Result: the same actor hits the same brand under a new domain a
week later, and the platform treats it as an unrelated event.

### 3.2 Pivot tracking when infrastructure moves

Threat actors rotate hosting providers, ASNs, registrars, and TLDs
constantly — often in response to takedowns. The category mostly
treats each new domain as a fresh detection. The pivot itself —
the fact that the actor *moved from provider A to provider B
within 48 hours of takedown* — is signal that other platforms
don't capture, score, or surface.

This matters because:

- Repeat pivots identify abuse-tolerant providers (a shaming /
  reporting opportunity)
- Pivot velocity is a leading indicator of actor sophistication
- Pivot patterns help predict the *next* infrastructure they'll
  use

### 3.3 MO + tooling fingerprinting

Beyond IOCs, the *how* of an attack — what kit, what automation,
what AI-generated content patterns — is barely tracked in the
category. Examples:

- Was the phish generated by an LLM (typical sentence rhythm,
  specific failure modes)?
- Is the kit one of the publicly-traded phishing-as-a-service
  bundles, or a custom build?
- Are the lookalike domains generated algorithmically (typo
  permutations) or hand-picked?
- Does the campaign use bulk-registered domains with sequential
  patterns?

Surfacing this lets defenders adapt detection rules for the
*style* of attack, not just the IOC list.

### 3.4 Cross-tenant / cross-brand pattern detection

Most platforms operate per-tenant in isolation. If three customers
in the same sector get hit by the same kit on the same day, no
single platform tells either of them *"this is part of a sector-
wide campaign — here are the other affected brands and the shared
infrastructure."* Multi-tenant platforms have the data to do this;
they don't surface it because the legal / privacy / contractual
implications are tricky.

### 3.5 Geopolitical context binding

Categorizing campaigns by adversary country / nation-state
cluster / sanctions implications is rare. Most platforms surface
"hosted in Russia" as a country tag and stop there. The richer
read — "this actor was active during X conflict, pivoted to Y
infrastructure during Z event, matches TTPs of group W" — is
expensive to maintain and most vendors don't.

### 3.6 Hosting-provider abuse scorecards

Some providers consistently host abuse, ignore takedown requests,
and re-register suspended customers. The category has hosting-
provider tags but rarely converts that into a *scorecard* the
operator can use to:

- Prioritize takedown channels (skip slow / unresponsive
  providers)
- Lobby providers with evidence
- Inform contract / partner decisions

### 3.7 AI-generated content detection

Phishing pages, lure emails, and fake social profiles are
increasingly LLM-generated. The category is largely still using
pre-AI heuristics (keyword matching, brand-asset comparison).
Detection rules that account for AI-generation artifacts (token
distribution, repeated phrasing patterns, generic structure) are
rare.

### 3.8 Onboarding friction

Per §2.4, every platform asks the customer to manually configure
their brand inventory before any monitoring starts. This is the
single biggest "I'm not in love with this product yet" moment in
the entire category. A platform that auto-builds the inventory
from a single domain (via DNS, BIMI, social discovery, app-store
search, dark-web mention scan) starts every customer relationship
ahead of competitors.

### 3.9 Action loop closure

Most platforms produce signals + dashboards and require humans to
take action. The category claims "automated takedowns" but
typically means "we file the abuse form for you" — humans still
review, prioritize, follow up, and close. Closing the loop —
takedown → measure → re-detect on pivot → re-takedown → escalate
provider → adjust detection rules — without operator involvement
is rare.

## 4. Common positioning angles in the space

When everyone ships the same baseline (§2), positioning is how
vendors signal their angle. The recurring patterns in this space:

### 4.1 "We monitor more places"

Surface count as the differentiator: "X surface web sources, Y
dark-web forums, Z app stores, W social platforms." Customer
appeal: completeness anxiety. Weakness: more sources without
better correlation = more noise. Doesn't answer "now what."

### 4.2 "We take down faster"

SLA-driven. "Average X-hour takedown." Customer appeal: clear
metric, easy procurement spreadsheet entry. Weakness: SLA is
median, tail is what hurts; takedowns are largely a function of
the host's responsiveness, not the platform's.

### 4.3 "We have analyst-led intelligence"

Human-in-the-loop curation. "Our research team profiles every
threat." Customer appeal: bespoke / premium feel. Weakness:
doesn't scale, and analysts mostly produce reports that get
filed and forgotten — not action loops.

### 4.4 "We're enterprise / managed service"

White-glove. "We onboard you, we manage your tenant, we deliver
weekly reports." Customer appeal: low operational burden.
Weakness: the value is the service relationship, not the
platform; the platform itself can be mediocre and the service
masks it.

### 4.5 "We integrate with your SIEM / SOAR"

Integration count + API quality as the differentiator. Customer
appeal: works with existing security stack. Weakness: integration
shifts the work to the customer's analysts; the platform doesn't
think harder.

### 4.6 "We use AI" (the post-2023 baseline angle)

Almost universal now. Vendors badge existing classification /
clustering / summarization with "AI-powered." Customer appeal:
modern, future-proof. Weakness: what specifically the AI does is
usually opaque and rarely changes outcomes. Mostly LLM-summarized
dashboards.

### 4.7 "We're affordable / SMB-friendly"

Price-led. Customer appeal: covers a market segment the
enterprise vendors won't touch profitably. Weakness: race-to-
the-bottom; data quality often suffers; AI usage gets capped to
control unit economics.

### 4.8 "We're vertical-specialized"

"We focus on financial services / government / healthcare brands."
Customer appeal: speaks the customer's language, knows their
threats. Weakness: scope limits TAM; the threat actors don't
respect the vertical boundary.

### 4.9 "We do takedowns AS the service"

Pure takedown shop, often white-labeled inside other vendors.
Customer appeal: simple SOW. Weakness: not a platform play;
detection is bought elsewhere or scraped.

---

### Where Averrow's positioning fits

Averrow combines angles that are usually mutually exclusive:

- **Auto-onboarded** (kills §2.4 friction → competes with managed-
  service angle on convenience without the headcount)
- **Threat-actor first** (§3.1, §3.2 — pivots, MO, kits — replaces
  the "more sources" angle with "deeper signal")
- **Action-loop closed** (§3.9 — auto-takedown → re-detect on
  pivot → re-takedown → escalate → adjust rules without the
  operator)
- **AI applied to correlation, not just summarization** (§3.3,
  §3.4, §3.5 — what the §4.6 angle promises but rarely delivers)

This combination is the genuine differentiator. §8 expands.

## 5. Customer pain points with existing platforms

Common operator complaints about platforms in this space. These
inform what Averrow should make obviously different.

### 5.1 Onboarding takes weeks, not minutes

Manual brand inventory entry, asset uploads, social handle config,
domain verification, contract / DPA reviews. Customer is paying
during the gap. By the time the platform is "live" the operator
has already lost confidence.

### 5.2 Alert fatigue with no clear "what to do"

Dashboards full of low-severity rows. No reason text. No
recommended action. Operator triage is "is this worth caring
about" first, "what do I do about it" second. Both questions
should be pre-answered.

### 5.3 Takedown follow-through is uneven

Submission is automated but hosting providers respond at very
different speeds. Some take 30 minutes, some take 3 weeks, some
never respond. The platform shows "submitted" status forever; the
operator has no way to see SLA-by-provider data when negotiating
or escalating.

### 5.4 The same threat actor keeps coming back and the platform doesn't notice

Takedown closes the row. Two days later the same actor is back on
a new domain, same hosting provider class, same kit. The
platform's dashboard treats this as fresh detections — the
operator's incident-response team is the only memory.

### 5.5 No prediction, only reaction

The platform tells the operator about threats that already exist.
It rarely tells them about infrastructure being prepared. Lookalike
domain registered Tuesday → no IP, no content, no signal → it
gets flagged Friday only after the phish goes live. The
prep-window opportunity is missed.

### 5.6 Reports designed for the buyer, not the user

Monthly executive reports with green / yellow / red dials. Useful
for the security director's QBR. Useless for the analyst trying
to figure out which campaign to focus on this morning.

### 5.7 Dashboard-as-product, not action-as-product

The platform produces views. Action requires the operator's
team. Customers paying for "automated brand protection" frequently
discover that "automated" means "we send the email when the
phish appears" — not "we run the workflow to closure."

### 5.8 AI is opaque

"AI-powered" appears on the website, in the sales deck, and on
the dashboard banner. What the AI actually does, when it ran,
what it concluded, what tokens it cost, why it picked one
threat over another — none of that is exposed. Trust is asked
for, not earned.

### 5.9 Multi-brand / multi-tenant gets complex fast

Service providers and large enterprises with sub-brands hit
hierarchy limits, RBAC limits, billing-attribution limits, alert-
routing limits. The platform was designed for one brand × one
team and bolted on multi-tenancy.

### 5.10 Switching cost is the moat, not value

The brand inventory, takedown evidence library, and integration
configuration become the lock-in. Customers stay because moving
costs are high, not because the platform earns daily love.

---

These pain points cluster into three classes that Averrow should
address head-on:

1. **Time-to-value** (5.1) — auto-onboard.
2. **Decision quality** (5.2, 5.6, 5.8) — every alert ships with
   reason + recommended action; AI work is exposed and traceable.
3. **Loop closure** (5.3, 5.4, 5.5, 5.7) — actor memory, pivot
   tracking, prep-window detection, takedown-to-closure
   automation.

## 6. AI in the category — claims vs reality

Almost every platform now claims to be "AI-powered." The reality
is more uneven. The recurring patterns:

### 6.1 What "AI" usually means in marketing copy

- **Classification**: is this URL a phish (binary or scored)?
- **Clustering**: group similar threats together
- **Summarization**: turn raw events into prose for the dashboard
- **Image similarity**: logo / favicon match scoring

These are real — but they were happening before LLMs, often with
classical ML. The post-2023 rebrand mostly involves swapping
existing models for LLM-based ones and putting "AI" on the label.

### 6.2 What's rarely shipped despite the claim

- **Cross-event narrative**: tying a phish, a typosquat, a social
  imitation, and a dark-web mention into one campaign-actor story
- **Predictive infrastructure detection**: spotting prep before
  the attack (cluster of newly-registered domains on the same ASN
  before content goes live)
- **AI-generated-content fingerprinting**: detecting when the
  attacker used an LLM to write the lure
- **MO inference**: figuring out the *style* of the attacker —
  how they pick infrastructure, how they sequence pivots, what
  tooling they prefer
- **Action recommendations grounded in the platform's actual
  data**: "for THIS threat actor, takedown via THIS channel
  worked X% of the time last quarter"

### 6.3 The opacity problem

When the platform says "AI flagged this as critical," operators
typically can't see:

- Which model was used
- What context was passed in
- What the model returned (often only a final score is stored)
- How much it cost
- How confident the model was

Trust depends on observability. The category collectively under-
invests in making AI work auditable.

### 6.4 Cost discipline is rare

LLM calls scale with volume. A platform with 100K daily threats
that runs every threat through Sonnet is spending ~thousands of
dollars per day. Most platforms either:

- Cap AI to severity tiers (cheap but biased toward critical)
- Cap AI to a sample (random gaps in coverage)
- Run cheaper models everywhere (lose quality)
- Eat the cost and pass it to the customer's bill

Few platforms expose budget state, throttle gracefully, or let
the customer trade cost for fidelity.

### 6.5 Where AI actually changes outcomes (vs decoration)

The high-leverage applications — the ones that move the needle
on operator outcomes — are not the dashboard banners:

- **Multi-signal correlation across 24-72h windows** (per-brand
  narrative): turns 50 separate dashboard rows into one "this
  is what's happening to your brand right now" paragraph
- **Predictive cluster scoring**: "infrastructure setup pattern
  matches a campaign that hit you 6 months ago — strike window
  predicted"
- **Action selection**: which takedown channel to use, ranked
  by historical success on this provider × actor pair
- **AI-generated content detection**: did the attacker use an LLM
  to write this?
- **Per-brand template-rendering**: AI writes the alert reason +
  recommended action grounded in the specific row, not a generic
  string

### 6.6 What Averrow does today

(Concrete — to feed §7's code-level map.)

- **Haiku for classification** (cheap, high volume) — sentinel,
  cartographer
- **Sonnet for narrative** (rare, high-leverage) — narrator,
  observer briefing
- **Cluster detection** — NEXUS algorithm, AI assists with
  naming + correlation context
- **Reason text + recommended action** — currently static
  templates per `intel_*` family (Q5 v1); AI narrator agent for
  digest envelopes is shipped
- **Cost guard + budget rollups** — AI work pauses when the
  monthly budget hits soft / hard / emergency thresholds. Visible
  in the platform-diagnostics endpoint.
- **Per-agent cost attribution** — every Haiku / Sonnet call is
  tagged to the agent that made it; budget ledger is queryable.

The cost-guard + observability piece is genuinely different from
the §6.3 / §6.4 norm in this space.

## 7. Averrow capabilities — code-level map

What Averrow actually has, grouped by the category dimensions
in §2 + §3. This is the inventory feeding §8's differentiator
selection. All references are to `packages/averrow-worker/src/`.

### 7.1 Detection surfaces

| Capability | How | Code |
|---|---|---|
| Phishing / malicious URL detection | Multi-feed ingestion: PhishTank, OpenPhish, abuse.ch, URLHaus, ThreatFox, OTX, CINS, SecLookup, GreyNoise, AbuseIPDB, Spamhaus DBL, GSB, VirusTotal | `feeds/*.ts` (40 feeds) |
| Lookalike / typosquat | `lookalike-scanner` agent — DNS/HTTP/MX + Haiku AI assessment of newly-registered candidates | `agents/lookalike-scanner.ts` |
| Certificate Transparency monitoring | CertStream Durable Object — live CT log subscription with brand-keyword matching | `lib/certstream.ts` |
| Social impersonation | `social_monitor` (Twitter/LinkedIn/Instagram/TikTok/GitHub/YouTube) + `social_discovery` (auto-find brand handles) + `social_ai_assessor` Haiku classifier | `agents/social*.ts` |
| App-store impersonation | `app_store_monitor` — iOS today, Google Play + 3rd-party planned | `agents/appStoreMonitor.ts` |
| Dark-web monitoring | `dark_web_monitor` — Pastebin today; Telegram / HIBP / Flare planned | `agents/darkWebMonitor.ts` |
| Email auth posture | DMARC / SPF / DKIM / MX / BIMI / VMC scoring per brand | `email-security.ts`, cartographer Phase 3 |
| Spam trap captures | Honeypot email addresses planted into harvester channels (secret-sauce, not surfaced) | `auto-seeder`, `spam-trap.ts` |
| Honeypot generation | `honeypot-generator` — renders complete trap websites (index + contact + team pages) | `agents/honeypot-generator.ts` |

### 7.2 Operational pipeline

| Capability | How | Code |
|---|---|---|
| IOC enrichment | Cartographer (geo / ASN / hosting provider, multi-phase) + Enricher (DNS, brand, sector) | `agents/cartographer.ts`, `cron/enricher.ts` |
| Threat scoring | Sentinel + Analyst + Strategist sequence | `agents/sentinel.ts`, `agents/analyst.ts`, `agents/strategist.ts` |
| Brand matching | Analyst — Haiku-powered brand-vs-domain matching | `agents/analyst.ts` |
| Auto-takedown | Sparrow scans URLs → auto-creates takedowns → Evidence Assembler builds provider-ready abuse reports → resolves providers | `agents/sparrow.ts`, `agents/evidence-assembler.ts` |
| Notifications | 4-state inbox, per-channel severity floors, group_key dedup, push action buttons, AI digest envelope | `lib/notifications.ts`, `agents/notification_narrator.ts` |
| Multi-tenant | Org / brand / user model with RBAC, audience routing, per-brand subscriptions | `migrations/0027_organizations*.sql`, `notification_subscriptions` |
| Reporting / dashboards | Observatory (real-time threat globe), Brand Detail, Operations, Threat Actors, Intelligence views | `packages/averrow-ops/src/features/*` |
| Auto-onboard | One-domain → tenant ready: DNS / BIMI / social discovery / app-store search / dark-web baseline auto-built. (Architecturally present; UX polish pending.) | brand-enricher + social_discovery + lookalike-scanner pipeline |

### 7.3 Intelligence layer

| Capability | How | Code |
|---|---|---|
| Threat-actor profiles | `threat_actors` + `threat_actor_infrastructure` + `threat_actor_targets` tables; per-actor pages | `migrations/0063_threat_actors*.sql`, `handlers/threatActors.ts` |
| Campaign correlation | Strategist clusters threats by IP / ASN / subnet / temporal pattern → campaigns | `agents/strategist.ts` |
| Cluster detection | NEXUS — infrastructure correlation engine, scores accelerating clusters | `agents/nexus.ts` |
| Geopolitical campaign assessment | `geo_campaign_assessment` — 4-paragraph executive intel assessment of active geopolitical cyber campaign (Haiku, 1024-token prose) | `agents/geo-campaign-assessment.ts` |
| Trend analysis | Observer — daily / weekly intelligence synthesis with multi-signal narrative | `agents/observer.ts` |
| Per-brand narrative | Narrator — multi-signal correlation per brand (≥2 signal types) → coherent attack story → high-severity also creates alerts | `agents/narrator.ts` |
| Sector trend digests | Observer weekly intel + `intel_sector_trend` notification | `agents/observer.ts`, intel_templates |
| Predictive alerts | NEXUS accelerating cluster + brand confidence ≥70 → `intel_predictive` per affected brand | intel_templates + nexus emit |
| Chat copilot | Trustbot — interactive AI threat intelligence Q&A | `agents/trustbot.ts` |

### 7.4 Self-supervision (the genuinely-different layer)

| Capability | How | Code |
|---|---|---|
| Autonomous supervisor | Flight Control — every-tick tracking of agent health, backlogs, budget, feed status; auto-recovers stalled agents; auto-scales cartographer/analyst | `agents/flightControl.ts` |
| Cost guard | BudgetManager — soft / hard / emergency throttle thresholds against monthly token cap; per-agent + per-tier limits | `lib/budgetManager.ts` |
| Per-agent attribution | Every Haiku / Sonnet call tagged to the agent that made it; budget ledger queryable | `lib/budget-ledger.ts`, agent_runs.cost_usd |
| Circuit breaker | Per-agent consecutive-failure auto-pause + manual unpause; FC observes + reports | `lib/agentRunner.ts` circuit logic |
| Self-monitoring notifications | platform_* family — d1_budget, kv_budget, agent_stalled, feed_at_risk, cron_missed, briefing_silent, ai_spend_burst, etc. | `lib/platform-templates.ts` |
| Diagnostics endpoint | `/api/internal/platform-diagnostics` — full health snapshot: feeds, agents, D1 budget, AI spend, briefing pipeline, cron health, recent platform alerts, FC tick timings | `handlers/diagnostics.ts` |

### 7.5 Operations + scaling

| Capability | How | Code |
|---|---|---|
| Hourly orchestrator cron | Dispatches agent mesh (FC, Sentinel, Cartographer, Analyst, Strategist, Observer, NEXUS, etc.) | `cron/orchestrator.ts` |
| Sub-hourly Navigator | Every-5-min cache pre-warming + cube refresh + DNS resolution + light enrichment | `cron/navigator.ts` |
| OLAP cubes | threat_cube_geo / threat_cube_provider / threat_cube_brand — pre-aggregated for sub-50ms reads | `lib/cube-builder.ts` |
| Pre-computed columns | brands.threat_count, hosting_providers.active_threat_count, trend_7d/30d — avoid GROUP BY on hot paths | various |
| Read replicas | D1 Sessions API — read-heavy handlers route through `getReadSession` | `lib/db.ts` |
| KV cache pre-warm | 24 endpoints warmed every 5 min by Navigator | `cron/navigator.ts` |
| Workflows (durable) | NEXUS + Cartographer backfill run as Cloudflare Workflows (no CPU ceiling) | `wrangler.toml`, `workflows/*.ts` |

### 7.6 Notable absences (gaps in our own implementation)

Honest gaps to call out — these set the v3 / re-engineering
candidates in §9:

- **MO + tooling fingerprinting** (§3.3) — no kit-fingerprint
  detector yet
- **AI-generated content detection** (§3.7) — no LLM-output
  heuristic on phish lures yet
- **Hosting-provider abuse scorecard** (§3.6) — provider tagged
  per row, but no aggregated scorecard surface
- **Pivot tracking surface** (§3.2) — clusters detect
  acceleration; pivot pattern analysis (provider A → B in N hours
  after takedown) is not yet a first-class concept
- **Cross-tenant pattern surface** (§3.4) — `intel_cross_brand_pattern`
  type exists in registry but emit not wired
- **Threat-actor pivot surface** (§3.1) — `intel_threat_actor_surface`
  type exists; emit needs an INSERT path into
  threat_actor_infrastructure that the Sentinel update path
  doesn't yet provide
- **Action-loop closure** (§3.9) — Sparrow + evidence_assembler
  ship; the re-detection loop on pivot + automatic re-takedown is
  partially wired (NEXUS detects acceleration; auto-resubmit not
  fully closed)

These absences aren't disqualifiers — they're the strategic
build-list. §9 frames whether they're incremental or v3-shaped.

## 8. Genuine differentiators — the "so what" answers

The home page needs to answer "so what makes Averrow different
from everything else in this space." Five axes, each grounded in
a §7 capability and contrasted against a §3 / §4 / §5 weakness.
Vendor names omitted.

### 8.1 BETTER — closes the loop, not just the dashboard

**Other platforms** produce signals + dashboards; the operator's
team takes action. "Automated takedown" usually means "we file
the form for you" (§4.9, §5.7).

**Averrow** runs the full loop: detection → classification →
brand match → cluster → takedown evidence package → submission →
re-detect on pivot → re-takedown → escalate provider → adjust
detection rules. Operator approves and reviews; the platform
runs the workflow.

Backed by: `agents/sparrow.ts` + `agents/evidence-assembler.ts`
+ NEXUS pivot detection + `intel_*` recommended-action templates.

### 8.2 QUICKER — minutes-to-value, not weeks

**Other platforms** require manual brand inventory entry, asset
uploads, social handle config, domain verification across
multiple onboarding screens (§2.4, §5.1). Time-to-first-signal:
24-72 hours.

**Averrow** auto-builds the tenant from one domain. DNS/BIMI
lookup → social discovery (Mockingbird scout) → app-store search
→ lookalike scan → email auth scan → dark-web baseline → ready.
Time-to-first-signal: minutes. The customer's first session is
already populated with active threat intel for their brand.

Backed by: `agents/social-discovery.ts` + `lib/brand-enricher.ts`
+ `agents/app_store_monitor.ts` + lookalike-scanner +
email-security + dark_web_monitor on a brand-create trigger.

### 8.3 INTELLIGENTLY — answers "who is the actor", not just "what is the IOC"

**Other platforms** tag a phish with severity / hosting provider
/ IOC and treat each new domain as fresh detection (§3.1, §5.4).
Threat actor pages, where they exist, are essentially analyst
report wikis maintained by a research team — they don't update
from incoming detections.

**Averrow** ties each detection to a threat actor by ASN reuse,
TTL pattern, kit fingerprint, and pivot history. Threat-actor
pages update live as new infrastructure surfaces. Operator sees
"Acme is being targeted by [actor X] who pivoted from [provider
A] to [provider B] today" — not "you have a new phishing URL."

Backed by: NEXUS clustering + Strategist campaign correlation +
Sentinel ASN/country actor binding + threat_actor_targets table
+ planned MO/kit fingerprinting (§7.6).

### 8.4 CLEVER — predicts the next move

**Other platforms** are reactive. A domain registered Tuesday
sits dormant; the platform flags it Friday once content goes
live (§5.5).

**Averrow** scores accelerating clusters and predicts strike
windows. NEXUS detects the infrastructure prep — same ASN as
last month's campaign, same registrar pattern, same SSL issuer
sequence — and fires `intel_predictive` notifications before
content drops. Combined with geo_campaign_assessment, predictions
include geopolitical context: "infrastructure setup pattern
matches a campaign that hit you 6 months ago — strike window
predicted within 7 days."

Backed by: `agents/nexus.ts` accelerating-cluster scoring +
`agents/geo-campaign-assessment.ts` + `intel_predictive` template.

### 8.5 AGGRESSIVE — pivots when they pivot

**Other platforms** close a takedown row and forget. Same actor
back in 48 hours on new infrastructure → fresh row, no memory
(§3.2, §5.3, §5.4).

**Averrow** tracks pivots as first-class events. When the actor
moves provider A → B within N hours of takedown, Averrow:
- Records the pivot pattern against the actor profile
- Bumps the providers' abuse scorecard
- Auto-resubmits takedown to the new provider
- Surfaces "this actor pivoted N times this month" in the
  threat-actor view
- Compounds intel — repeat pivot patterns identify abuse-tolerant
  providers worth lobbying / contracting around

Backed by: NEXUS cluster lifecycle (active / dormant / pivoting)
+ pivot-detection events on agent_events bus + (planned) provider
abuse scorecard surface (§7.6 gap).

---

### 8.6 The supporting unfair advantages

Behind the five axes, the platform's foundations make them
*feasible* where competitors struggle:

- **Self-supervising agent mesh** — Flight Control auto-recovers
  stalls, scales, and reports. Vendors that depend on human SREs
  ship slower. (See §7.4.)
- **AI-cost discipline by design** — soft / hard / emergency
  throttle gradient with per-agent attribution. Vendors who
  budget AI per-customer can't apply LLMs to high-volume work
  without bleeding margin. (See §6.4 + §7.4.)
- **OLAP cubes + read replicas** — sub-50ms dashboard reads. Most
  competitor dashboards read raw event tables and feel slow at
  scale. (See §7.5.)
- **Static templates v1, AI narrative v2 path** — every alert
  ships with `reason_text` + `recommended_action` today.
  Narrator agent layered AI on top. Operators get answer-quality
  consistency at v1 and AI variance at v2 without throwing away
  v1. (See §6.5 + §7.3.)

### 8.7 What the home page says

Five plain-English statements, each anchored to one of the axes:

1. **From signal to closure.** We don't dashboard threats — we
   resolve them. (§8.1)
2. **One domain. Minutes. Done.** Your brand inventory builds
   itself. (§8.2)
3. **Beyond the URL.** Every detection ties to the actor behind
   it — and what they're doing right now. (§8.3)
4. **Sees the next move.** Infrastructure prep is a signal.
   We score it. (§8.4)
5. **Pivots when they pivot.** New domain, new provider, same
   takedown. (§8.5)

Each statement should link to a "show me" view on the live
platform that demonstrates the claim with the customer's own data
within 60 seconds.

## 9. Strategic implications — incremental vs v3 rewrite

The §8 differentiator claims are credible from §7's inventory.
The §7.6 gaps are the tension: do we ship the 5 axes by closing
the gaps incrementally, or do we use this as the trigger for a
v3 rewrite?

### 9.1 The case for incremental

The platform is well-architected for the next 18-24 months:
- Self-supervising agent mesh (FC) is the genuinely-different
  layer (§7.4); throwing it away is a mistake
- 40 feeds + multi-tenant + auto-onboard plumbing already exist
- D1 + read replicas + OLAP cubes scale to the foreseeable
  customer count
- The N0–N6 notifications work just landed — re-doing it would
  waste 25+ PRs of recent investment
- The agents/* registry pattern + agent_runs + cost-guard +
  budget-ledger framework supports "add a new agent" cheaply

The 5 axes can be delivered by closing 7 specific gaps
(§7.6 + 8 distillation):

| Gap | Owner | Effort |
|---|---|---|
| MO + tooling fingerprinting | new sync agent + Sentinel hook | 2-3 weeks |
| AI-content fingerprinting | new sync agent on Sentinel pass | 1-2 weeks |
| Provider abuse scorecard | new aggregation + UI surface | 1-2 weeks |
| Pivot tracking surface | NEXUS extension + new UI panel | 2 weeks |
| Cross-tenant intel emit | wire `intel_cross_brand_pattern` from Observer | 1 week |
| Threat-actor surface emit | wire INSERT path in Sentinel | 1 week |
| Action-loop closure (auto-resubmit) | Sparrow + NEXUS pivot integration | 2-3 weeks |
| **Total** | | **~10-13 weeks** |

Plus auto-onboard UX polish (1-2 weeks). All deliverable on the
existing v2 platform.

### 9.2 The case for v3

A from-scratch rewrite would be justified if any of:
- The data model can't carry the 5 axes (it can; §7 + §8 sit on
  it cleanly)
- The architecture has a hard limit at the next scale tier (D1 +
  Workflows scale; not the bottleneck)
- The UX is irrecoverable (the React /v2 restructure was Sessions
  R1–R10; design-system + features layout work)
- The legacy SPA at `/legacy` blocks customer adoption (it's
  archived; users don't see it unless they explicitly navigate)
- Sales / branding wants a clean break (real but solvable
  with positioning, not code)

None of those triggers are met. The platform's foundations are
ahead of the category.

### 9.3 What v3 would actually mean (parking ideas, not committing)

If a v3 happens later, the right shape — based on §3 weaknesses
and what the category will look like in 24+ months — would be:

- **Threat-actor as the primary entity, not the URL/IOC.** Today
  threats are the table, actors derived. A v3 schema centers
  actor profiles with detections as evidence rows. Nudges every
  feature to think "what does this tell us about the actor."
- **Pivot graph as a first-class surface.** Time-series of
  infrastructure moves per actor, scored, visualized as a graph
  not a table. Predictive scoring (§8.4) becomes an obvious
  output of the graph.
- **Outcome-driven dashboards.** Every dashboard view answers
  "what should I do today" — not "here's a count of things." Each
  row has a primary action button.
- **Multi-tenant baked in deeper.** Cross-tenant intel
  (§3.4 / §8.3) becomes a default capability with proper
  contractual + privacy guardrails — not a future feature.
- **AI-on-correlation as the default.** Static templates
  (§6.6 v1) become the fallback; AI narrative becomes the
  primary content path with cost-guard letting customers tune
  fidelity vs spend.

Each of these is achievable as a v2 evolution. v3 would be a
greenfield rewrite to *avoid carrying v1+v2 baggage* — the
question is whether that baggage is heavy enough to justify the
cost.

### 9.4 Recommendation

**Incremental, with a v3 holding pattern.** Ship the 5 axes by
closing the 7 gaps over Q3-Q4. In parallel, treat each closed
gap as a v3-shaped slice — meaning: design it so it could be
lifted into a v3 schema later without a rewrite of the integration
glue. That gives optionality without paying the rewrite cost
upfront.

If during that quarter the platform hits a foundational
limit (data-model contortion, scaling cliff, UX gridlock) that
incremental can't reach, the v3 trigger fires and we revisit.

### 9.5 Open strategic questions for the operator

These are decisions external research + product instinct should
answer; not for me to call:

1. **Auto-onboard scope** — start at "one domain → tenant ready"
   (already feasible) or aim for "one URL → tenant ready" (asks
   us to invert from brand-keyed to detection-keyed)?
2. **Multi-tenant intel sharing** — is cross-tenant pattern
   detection (§3.4 / §8.3) a paid tier upsell or a default
   capability? Affects schema + contracts.
3. **Pricing model** — is "we close the loop" sold per-takedown,
   per-actor-tracked, or per-brand? Affects what we instrument
   and bill on.
4. **Agency / channel partner play** — service providers who
   resell to their customers. Multi-tenant hierarchy + RBAC +
   billing-attribution decisions get heavier if so.
5. **Public-facing free tier** — does `/scan/<domain>` go big as
   the funnel? Affects how much trust-score / public assessment
   work belongs on the platform vs in a separate funnel project.

§10 lists open research tasks to inform these.

## 10. Appendix — open research tasks

External research that should land before P4 (positioning lock-in)
or P5 (home page). Operator can fold in findings from other AI
platforms; placeholders below are prompts for what to look at.

### 10.1 Public sources to comb

- Industry analyst reports on the brand-protection / digital-risk
  space (annual market summaries; vendor quadrants minus the
  vendor names — patterns, not labels)
- Customer review platforms — pain points + missing features
- Conference talks (RSA / Black Hat / FIRST) on threat-actor
  attribution and brand-impersonation campaigns
- Open-source phishing kit catalogs (PhishKit / phishstats /
  GitHub repos)
- Hosting provider abuse policy publications + takedown response
  data (publicly reported)

### 10.2 Cross-platform AI assistant prompts

Useful prompts to run against another AI platform to feed back
into this doc:

- "What features do leading brand-protection platforms ship in
  2025-2026 that didn't exist in 2023?"
- "What recurring complaints do operators voice about digital
  risk protection vendors on review platforms?"
- "How are vendors in the brand-protection space using LLMs in
  production today, beyond dashboard summarization?"
- "What are the foundational gaps in cross-tenant threat
  intelligence sharing and what regulatory / contractual
  constraints prevent solving them?"
- "What pricing models dominate the brand-protection space and
  what alternative models have been attempted?"

### 10.3 Code-level audits to run on this platform

Independent of external research:

- **Sentinel ASN→actor binding hit rate** — what % of detections
  actually bind to a known actor? Is the bind useful or noise?
- **NEXUS cluster lifecycle** — how often does a cluster
  transition active → pivoting → dormant, and does the pivot
  detection match what operators see?
- **Cost-guard activation history** — has the budget guard ever
  fired in the last 90 days? At what spend level? Was it the
  right call?
- **Auto-onboard latency** — for a brand-create event, how long
  until the first eligible threat lands? Compare to the §5.1
  weeks/days/hours/minutes target.
- **Takedown success rate by provider** — which providers honor
  abuse reports, which don't, what's the median time-to-takedown
  per provider tier?
- **Notification triage rate** — what % of `intel_*` notifications
  get marked `done` vs `snoozed` vs ignored? Done-rate is the
  proxy for "answered the so-what."

### 10.4 Customer interviews — questions to validate the §8 axes

Each axis should pass a 5-customer interview before going on the
home page. Suggested questions:

- **Loop closure (8.1)**: "When a takedown closes, who is
  responsible for re-checking that the actor doesn't come back
  on a new domain? What does that workflow look like today?"
- **Auto-onboard (8.2)**: "How long did onboarding take with
  your current platform? What did you have to provide manually?"
- **Threat-actor framing (8.3)**: "When you see a phishing URL,
  do you know who the attacker is? Does it matter to you?"
- **Predictive (8.4)**: "Have you ever spotted attacker
  infrastructure before content went live? How? Was the platform
  involved?"
- **Pivot (8.5)**: "Has the same actor come back on different
  infrastructure within days of a takedown? What did you do?
  Did the platform help?"

### 10.5 Anti-research — what to deliberately NOT chase

To stay disciplined:

- Don't add features purely because a competitor has them — only
  if they map to an operator pain point in §5
- Don't pursue "AI" claims that don't change outcomes
- Don't compete on integration count — depth > breadth in this
  space
- Don't ship the spam-trap secret-sauce as a marketing feature
  (it's intel, not a checkbox)
- Don't promise vertical specialization until the threat actors
  do (they don't)

---

*End of working draft. Next step per planning sequence: P3 stop +
reassess. Then P4 distillation (which axes get into the home page
copy + the ranked priority list of the §7.6 gaps to close). Then
P5 home-page wireframe.*
