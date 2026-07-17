# Tenant Analyst UX — Research, Gap Analysis & Refactor Proposal (2026-06)

> Status: Complete. Current-state from a live walkthrough of prod (`org_id=1`, Acme
> Corp) via the `auditor`/tenant preview tokens; competitor research across 14 DRP /
> brand-protection vendors; human-in-the-loop UX literature; and a full code inventory
> of `averrow-tenant` + the tenant API. Sources in §8.

## 0. Framing

Averrow's thesis: **mostly autonomous remediation**, with the analyst as a
**supervisor / exception-handler**, not the primary worker. The tenant surface
must therefore do three jobs at once:

1. **Full-auto by default** — the agent mesh discovers, triages, drafts takedowns.
2. **Analyst visibility** — a real analyst can see what they want/need, drill in,
   and trust (or challenge) what the automation did.
3. **Human-in-the-loop when needed** — when an org wants a human to approve, work,
   or override, the UI must let them actually *do the work*.

The question this doc answers: what does a threat analyst expect to see/do in a
brand-protection / DRP platform, what does Averrow's tenant view give them today,
and how should the UI be refactored to serve all three jobs.

---

## 1. Current state — live walkthrough of the tenant view (prod, Acme Corp)

Tenant IA today (left nav): **Workspace** = Overview, Threats, Signals,
Notifications, Takedowns · **Modules** = Domain, Social, App Store, Dark Web,
Abuse Mailbox, Trademark, Threat-Actor · **Account** = Settings.

### 1.1 Overview (`/tenant`)
Executive dashboard. KPI tiles (Active Threats 21,095 · Open Signals 212 ·
Impersonations 40 · Exposure Score 62/100), takedown-authorization status, a
per-brand table (3 brands with threats/social/impersonations/exposure), a 7-day
threat trend, "Recent signals" preview, and the 7 module cards. **Read-only.**
Good situational awareness; no work happens here.

### 1.2 Threats (`/tenant/threats`)
Full threat table (21,095 rows). Columns: BRAND, TYPE, DOMAIN/URL, SEVERITY,
STATUS (Active/Down/Remediated), SOURCE (feed), EVIDENCE (VT/GSB badges), LAST
SEEN. Filters: brand, severity, type, status; free-text search; sortable columns;
pagination 50/page. Rows are expandable for "the evidence behind the verdict."
**Read-only.** No row selection, no bulk action, no "request takedown," no
triage/dismiss, no assignment, no notes, no export. STATUS is system-set; the
analyst cannot change it.

### 1.3 Signals (`/tenant/alerts`) — the closest thing to a triage queue
212 signals, stat tiles (Total/Critical/High/"Resolved-able" 20). Filters:
SEVERITY (All/Critical/High/Medium/Low) and **STATUS (All/New/Acknowledged/
Investigating/Resolved)**. Each signal card: severity, status badge, type, date,
brand, AI title + narrative, and **AI "Recommended Actions"** (expandable). Every
signal is "NEW."
**Critical gap:** the status lifecycle exists in the data model and as filter
chips, but there are **no controls to drive it** — no acknowledge, no
investigate, no resolve, no dismiss, no assign, no "do this recommended action"
button. Recommended actions are advisory prose, not executable. Pagination is
"coming soon" (shows 50 of 212). It looks like a queue but you cannot work it.

### 1.4 Takedowns (`/tenant/takedowns`)
Real lifecycle: stat tiles (Total 7 · In Flight 7 · Taken Down 0 · Failed/Expired
0), STATUS filter (DRAFT/SUBMITTED/PENDING RESPONSE/TAKEN DOWN/FAILED), MODULE
filter. 7 requests, each a link to a detail page (`/tenant/takedowns/:id`). Each
row: severity, status, module, type, identifier, target brand, provider, AI
description + **confidence %**, created date. Subtitle says "auto-submitted under
your signed authorization … response audit trail per request."
**Critical gap:** all 7 are stuck in **DRAFT** and there is **no queue-level
approve / submit / reject** control — the human-in-the-loop gate is implied but
not actionable from the list. (Detail page may have controls — pending inventory.)

### 1.5 Cross-cutting observations (current state)
- The tenant surface is a **sophisticated read-only intelligence dashboard** with
  the *skeleton* of analyst workflows (status lifecycles exist in the data for
  Signals and Takedowns) but almost **no actionability**.
- **Absent today:** triage actions (ack/investigate/resolve/dismiss), case /
  investigation objects, ownership/assignment, analyst notes & collaboration, an
  audit trail of *human* actions, approve/reject gates for automation, bulk
  actions, saved views, SLA/aging, export/reporting, and any "what did the
  automation do and why" transparency panel.
- **Automation transparency is one-directional:** the platform shows AI verdicts,
  narratives, recommended actions, and takedown confidence — but never *why* it
  auto-acted (or didn't), and gives the human no lever to confirm/override.
- Modules (Domain/Social/App-Store/Dark-Web/Abuse-Mailbox/Trademark/Threat-Actor)
  exist as nav items; per the Overview each reads "0 across 3 metrics this month"
  for Acme — depth pending inventory.

---

## 2. What a threat analyst expects (canonical) — from competitor research

Synthesized from ZeroFox, Group-IB DRP, Recorded Future Brand Intelligence, Axur,
and Bolster, plus SOAR/autonomous-SOC HITL literature. (Most vendor sites 403 the
fetcher; specifics below come from vendor support docs + open-source SOAR
integration schemas, which expose the *actual* field/status/action names, cross-checked
across sources. Full citations in §8.)

Every serious platform gives an analyst these, and the order matters:

1. **A triage queue you can work** — not just read. Universal columns/affordances:
   - **Severity AND confidence as two separate signals** (severity = how bad if
     real; confidence = how sure the automation is — orthogonal, never collapsed).
     RF uses a 0–99 Risk Score with bands; Axur a Clair-VLM impersonation score;
     ZeroFox a Risk Rating.
   - **Status lifecycle** with analyst-driven transitions. Observed vocabularies:
     RF `New→Unassigned/Assigned→Pending→(Dismiss|No-Action|Actionable)→Resolved`;
     ZeroFox `Open/Closed/Takedown:Requested/Accepted/Denied/Whitelisted` +
     `Reviewed`/`Escalated` flags; Group-IB `detected→under review→takedown
     initiated→removed`; Axur `in progress/completed/on hold/check required` +
     `resolution_reason`.
   - **Assignee / ownership** + **notes** + **tags** per item (RF, ZeroFox, Axur all
     first-class).
   - Filters, **bulk actions**, saved views per role, **SLA/aging timers**, and
     **pre-enrichment on arrival** (the alert lands already enriched).
2. **A rich detail "card" / investigation view** — RF's Intelligence Card is the
   reference: Overview/Risk (AI insight + **screenshot**, **triggered risk rules**
   with contributing scores, analyst notes), **DNS / Certificates / WHOIS** tabs,
   **References**, **Related Entities with one-click pivot**. Group-IB adds a visual
   **link-analysis graph** (domain/IP/cert/email nodes). Axur = screenshot+HTML+WHOIS
   triad. **MITRE ATT&CK** tagging is common on the actor/technique side.
3. **A takedown lifecycle surface** — states, evidence package, provider
   accept/deny responses, SLA, and a status/metrics dashboard (ZeroFox Disruption
   Activity Dashboard; RF PhishPortal; Group-IB status table; Axur audit history).
4. **Automation + human-in-the-loop, made legible** (see §5) — confidence-gated
   autonomy, an explicit **approve/reject gate** before enforcement (Group-IB
   analysts approve; RF `Actionable`/`No-Action`; ZeroFox `Reviewed`; Axur `check
   required`/`on hold`), **auto-handled vs needs-review** separation, and a
   **"show your work" reasoning trail** behind every automated verdict.
5. **Reporting/export + SIEM/SOAR push + watchlists** and **RBAC with assignment**
   (Axur's managers/experts/analysts/viewers is the clearest model).

### 2.1 Competitor snapshot

| Capability | ZeroFox | Recorded Future | Group-IB | Axur | Bolster |
|---|---|---|---|---|---|
| Automation posture | analyst-validated before queue | risk-score auto-prioritize | >90% auto-detect, analyst-approve | **86% auto, no human** | automation-first (75% TD <60s) |
| Severity + **confidence** | Risk Rating | **Risk Score 0–99** | risk score | Clair-VLM score | confidence |
| Triage actions (assign/notes/tags/status) | ✅ all | ✅ all | approve/reject | ✅ (tickets) | ✅ |
| Detail card (screenshot/WHOIS/DNS/cert/pivot) | screenshots + pivot cmds | ✅ Intelligence Card | ✅ + **Graph** | screenshot+HTML+WHOIS | ✅ |
| Approve/reject **gate** before takedown | `Reviewed` flag | `Actionable` | **explicit approve** | `check required` | confidence-gated |
| Auto-handled vs needs-review split | de-facto (`Reviewed=false`) | New/Unassigned | violations-to-approve | **`on hold`/`check required`** | yes |
| Takedown status dashboard + SLA | Disruption dashboard | PhishPortal | status table, <24h | audit history, ~9h | <60s–hrs |
| Case/investigation object | thin (alert = unit) | cases from playbook alerts | violation = case | Investigations panel | n/a |
| Audit trail (who/what/when) | notes/tags | analyst notes | status table | **full audit history** | yes |

**Takeaway:** the market splits along an axis Averrow sits squarely on — Axur/Bolster
(automation-first, human as exception-handler) vs ZeroFox/Group-IB (analyst-validates-
before-action). Averrow's "mostly autonomous + analyst supervises + HITL when the org
wants it" is exactly the Axur/Bolster end **with a configurable gate** — which is the
right target, but the *analyst surface to supervise it* is what's missing today.

### 2.2 Broader vendor set + highest-fidelity references

Also reviewed: **Netcraft, Doppel, BrandShield, Bolster, Darktrace, Cyberint/Check Point
ERM, Fortra PhishLabs, CloudSEK XVigil, Mimecast, Memcyco**. The most useful *verbatim*
schemas (from open SOAR-integration source, the reliable signal behind the 403'd vendor
sites):
- **Netcraft = gold-standard takedown model.** 10-state lifecycle: `Unverified ·
  Inactive(Monitoring) · Verified · Contacted Hosting · Contacted Upstream · Contacted
  Police · Monitoring · Resolved · Stale · Invalid` (Resolved = "offline 7 consecutive
  days"). The **escalation ladder is encoded in the status** (host→upstream→police),
  plus per-takedown **notes**, an **`escalate`** action, a **`false_positive` override**,
  a **`managed`** boolean, and explicit **aging timestamps** (date_submitted,
  date_first_actioned, date_escalated, first/final_resolved, first/final_outage).
- **Doppel = most explicit HITL.** Classifies `malicious / benign / ambiguous` with
  confidence; **above threshold → auto-enforce, low/conflicting → human review queue**;
  every auto-takedown carries an **AI-generated justification**; analyst overrides are
  **logged and fed back into the model**. Its case primitive is a visual **Threat Graph
  of campaigns**.
- **BrandShield** = true **case management** with **AI.ClusterX** grouping similar
  threats into clusters an analyst actions together, and **legally-aligned evidence
  packages**; HITL gate sits at **enforcement, not detection**.
- **Darktrace** = the clearest "earn trust then hand over" UX: a **Human-Confirmation
  Mode** (AI recommends, analyst applies) that graduates to **Autonomous Mode** (AI
  acts), scoped by guardrails — the exact model for Averrow's Automation Policy (§5.5).
- **Cyberint** canonical filter facets (category · severity · status · **confidence** ·
  use-case · threat-actor) and **closure-with-reason** gate; **ZeroFox** canonical queue
  columns (ID · Rule · Type · Timestamp · Entity · Risk Rating · Severity · URL · Source
  · Status · Notes · Tags).

**Industry SLA defaults** worth adopting for §5: Critical ≤15 min, High ≤1 h, Medium
≤4 h, Low ≤24 h.

---

## 3. The deltas — tenant view vs. what analysts expect

The critical, repeated finding: **most of the backend already exists; the gap is UI.**
"Backend?" column = does an endpoint/data model already support this.

| # | Expected analyst capability | Averrow tenant today | Backend exists? | Severity of gap |
|---|---|---|---|---|
| 1 | **Act on a signal** (ack/investigate/resolve/FP) | Status filters exist; **no action controls** | ✅ `PATCH /api/orgs/:orgId/alerts/:alertId` (Analyst+) — just unwired in UI | **Critical** |
| 2 | **Confidence as a signal** distinct from severity | Not surfaced (scores exist in data: impersonation %, takedown confidence) | ✅ data has it | High |
| 3 | **Auto-handled vs needs-review split** | Absent — everything in one undifferentiated list | ⚠️ partial (alert-triage auto-dismiss, AI judge run) | **Critical** (this is the whole "full-auto + HITL" story) |
| 4 | **Approve/reject gate** for takedowns | 7 drafts stuck, **no approve/submit/reject** | ✅ authorization scope has `high_risk_requires_per_takedown_approval`; takedown PATCH exists | **Critical** |
| 5 | **"Show your work" reasoning trail** behind AI verdicts | Shows verdict + narrative + recommended actions, never *why it (didn't) auto-act* + confidence + evidence-at-decision | ⚠️ `ai_assessment`, `alert-triage` reasons, enrichment snapshot exist | **Critical** |
| 6 | **Executable** recommended actions | Prose only ("Request takedown of…") — not buttons | ✅ takedown create endpoint exists | High |
| 7 | **Case/investigation object** (link signals, timeline) | Absent — each signal independent | ❌ (campaigns exist server-side as an anchor) | Medium |
| 8 | **Assignment / ownership** | Absent | ⚠️ org roles exist; no per-item assignee | Medium |
| 9 | **Analyst notes / collaboration** | Absent in UI | ✅ `notes`/`resolution_notes` accepted by triage endpoint | Medium |
| 10 | **Tenant-facing audit trail** (human + automation) | Absent | ✅ audit events logged server-side | Medium |
| 11 | **SLA / aging timers** | Absent | ⚠️ authorization scope has `auto_followup_breached_sla_hours` | Medium |
| 12 | **Bulk actions** | Absent | — | Medium |
| 13 | **Detail card**: WHOIS/DNS/cert tabs, pivoting, MITRE | Evidence drawer (VT/GSB badges) only; no pivot/WHOIS tabs | ⚠️ enrichment data exists | High |
| 14 | **Saved views / watchlists / suppression rules** | Absent in UI | ✅ `PATCH …/monitoring-config` (keywords, excluded domains, severity filter, auto-ack) | Medium |
| 15 | **Full pagination** on Signals | "coming soon" (50 of 212) | — | Low (but visible) |
| 16 | **Reporting / export** | Absent | — | Low |
| 17 | **Automation-policy visibility** (how much autonomy) | Buried in takedown-authorization sign flow | ✅ scope: modules, escalation mode, high-risk approval, SLA, max/month | High |

**Headline:** of the 4 Critical gaps, three (#1, #4, #5) are **wiring existing endpoints
into the UI**, and one (#3) is an **information-architecture re-frame**. This is a
high-leverage, mostly-frontend opportunity — Averrow built the autonomous engine and a
strong read-only intelligence layer; the **analyst supervision cockpit** on top is the
missing piece.

---

## 4. The model: full-auto → analyst view → human-in-the-loop

The HITL literature and the automation-first vendors converge on one model. Adopt it
explicitly (it also resolves your "full auto yet analysts view then human in the loop"
framing into something buildable).

### 4.1 Four automation levels, set **per action × per threat-type**

| Level | When | UX | Averrow mapping (mostly already exists) |
|---|---|---|---|
| **L1 Auto-handle** (act, inform after) | high-confidence, reversible, low blast-radius | lands in **Auto-handled stream**, reversible | auto-dismiss benign alerts (`alert-triage.ts`), auto-submit takedowns under signed authorization |
| **L2 Recommend + confirm** (act on 1-tap approval) | medium-confidence / moderate impact | pre-filled recommendation, one-click **Approve** | medium-confidence takedown drafts |
| **L3 Require-approval** (human decides) | irreversible / high blast-radius / legal | **Needs-approval queue**, no default action | `high_risk_requires_per_takedown_approval` gate |
| **L4 Manual / novel** | low confidence / no precedent | routed to human, full context, no recommendation | new pattern, AI judge `needs_human` |

The org dials these via an **Automation Policy** surface (today this is half-hidden in
the takedown-authorization sign flow — surface it as a first-class settings page).

### 4.2 The two-stream UI (the core move)

Split the analyst's world into two always-visible streams so they trust the automation
without losing visibility:

- **① "Needs you" queue** — the human's actual job: L3 approvals, L4 novel items,
  low-confidence escalations, SLA-at-risk items. Depth-visible, SLA-timed, assignable.
  *This becomes the analyst's home page.*
- **② "Auto-handled" activity stream** — what the automation did (auto-dismissed,
  auto-submitted, auto-resolved), each row one click from its **reasoning trail** and a
  **reverse/override** action. This is what builds calibrated trust and is currently 100%
  absent.

Every item carries an **automation-state badge** — `Auto-resolved` · `Auto-actioned
(reversible)` · `Awaiting approval` · `Escalated` · `Manual` — plus a **confidence**
indicator separate from severity.

### 4.3 This is mostly *surfacing* what Averrow already decides

The model above is not net-new logic — it's making existing backend decisions visible:
- **`alert-triage.ts`** already auto-dismisses benign alerts with a stamped reason in
  `resolution_notes` → that's the **L1 Auto-handle** stream; just show it + make the
  dismissal reversible.
- **`alert-ai-judge.ts`** already returns a Haiku **verdict + confidence + reasoning**
  and auto-dismisses only at `confidence ≥ AUTO_DISMISS_CONFIDENCE_FLOOR (90)`, leaving
  everything below in `new` for a human → that **is** the confidence-threshold gate
  (Doppel/Netcraft pattern); surface the verdict, confidence, and reasoning in the queue
  + a one-click override that feeds back.
- The **takedown-authorization scope** (`high_risk_requires_per_takedown_approval`,
  escalation mode, SLA, max/month) already encodes per-org automation levels → render it
  as the Darktrace-style **Human-Confirmation ↔ Autonomous** dial (§5.5).

So the design references to copy: **Doppel** (confidence-threshold + AI justification +
feedback loop), **Darktrace** (mode toggle with guardrails), **Netcraft** (takedown
lifecycle + `false_positive` override + aging), **Bolster** ("Dispute" one-click
override). Every one of these has a backend analogue already in Averrow.

---

## 5. Proposed tenant IA refactor

Reframe the left nav from "list of data types" to "the supervision workflow," keeping
all existing surfaces reachable.

```
WORKSPACE
  Console        ← NEW. Analyst home: ① Needs-you queue + ② Auto-handled stream + KPIs
  Signals        ← becomes a real triage queue (actions, assignee, confidence, SLA, bulk)
  Threats        ← keep as the evidence corpus; add "open in investigation" + pivot
  Takedowns      ← add the approve/reject queue + lifecycle + provider responses
  Investigations ← NEW (phase 2): case object linking signals/threats/takedowns
  Notifications
MODULES   (Domain · Social · App-Store · Dark-Web · Abuse-Mailbox · Trademark · Threat-Actor)
INTELLIGENCE
  Threat Actors  (exists under modules; promote)
ACCOUNT
  Automation Policy  ← NEW surface for the §4.1 levels (from takedown-auth scope)
  Audit Log          ← NEW tenant-facing who/what/when
  Settings / Members / Billing
```

### 5.1 Console (new analyst home)
- **① Needs-you queue**: items requiring a human — takedown drafts awaiting approval
  (L3), low-confidence/novel signals (L4), SLA-breaching items. Each row: severity +
  confidence, automation-state badge, age/SLA, assignee, one-click Approve/Reject/Assign.
- **② Auto-handled stream**: reverse-chronological feed of automation actions
  (auto-dismissed N benign, auto-submitted M takedowns, auto-resolved K) — each
  expandable to its reasoning trail + an Undo/Override.
- **KPI strip**: queue depth + trend, **automation rate / % auto-resolved**, MTTR,
  open SLA breaches, takedown success rate. (These are the metrics execs *and* analysts
  both want; today the Overview shows exposure but no automation/throughput metrics.)

### 5.2 Signals → triage queue (wire what exists)
- Per-signal **action bar**: Acknowledge · Investigate · Resolve · False-positive ·
  Dismiss → existing `PATCH …/alerts/:alertId` (Analyst+); Viewer stays read-only.
- Add **assignee**, **notes** (endpoint already takes `notes`), **tags**, **confidence
  column** (orthogonal to severity), **automation-state badge**, **SLA/aging**.
- **Bulk select** → assign/dismiss/resolve. **Saved views** (e.g. "Critical · unassigned
  · aging"). Finish **pagination**.
- Make **Recommended Actions executable** — "Request takedown" creates a draft via the
  existing endpoint; "Add to watchlist"/"Suppress like this" writes monitoring-config.

### 5.3 Signal/Threat detail → Intelligence Card
Tabbed card (mirror RF): **Overview/Risk** (AI verdict + **confidence** + **reasoning
trail**: which feeds, which rules, why auto-acted-or-not, screenshot, evidence-at-
decision snapshot) · **DNS/WHOIS/Certs** · **Related entities + pivot** (to the threat
table / campaign) · **Evidence** (VT/GSB/enrichment) · **Activity/Notes** (timeline +
analyst notes) · **Actions** (executable). This upgrades today's read-only evidence
drawer into a working investigation surface.

### 5.4 Takedowns → approval queue + lifecycle
- Surface **Approve / Reject** on `DRAFT` rows, honoring the authorization scope
  (auto-submit when within scope; require approval when
  `high_risk_requires_per_takedown_approval`). Today all 7 drafts are stranded with no
  control — this is the most visible HITL gap.
- Show **confidence**, **evidence package**, **provider accept/deny audit trail**, and
  **SLA/aging** per request (data already on the detail page).
- Reference model: **Netcraft's** lifecycle with the **escalation ladder encoded in
  status** (host → upstream → registrar/police), a **`false_positive` override**, a
  **`managed`** flag, and explicit aging timestamps. Averrow's current
  Draft/Submitted/Pending/Taken-down/Failed is a fine base — add the escalation states,
  a per-request override, and aging on top.

### 5.5 Automation Policy (new) + Audit Log (new)
- **Automation Policy**: expose the §4.1 levels per module/action — the takedown-auth
  scope (`modules`, escalation mode, high-risk approval, SLA, max/month) already *is*
  this; give it a real home so an org can dial autonomy up/down and *see* the current
  posture. This is the literal control for "full auto ↔ human-in-the-loop."
- **Audit Log**: tenant-facing chronological record of automation + human actions
  (server already logs these) — required for trust/defensibility.

### 5.6 Investigations / Cases (phase 2)
Optional case object: group related signals/threats/takedowns (anchor on the existing
server-side **campaign** concept), with timeline, assignee, status, linked indicators,
notes, and an immutable audit trail. Precedent: **BrandShield's AI.ClusterX** (action a
whole cluster at once), **Doppel's** campaign Threat Graph, **Group-IB's** link graph.
Most DRP vendors keep the alert as the unit and lean on notes/tags — so a full case
object is valuable but not day-one; clustering signals onto the existing `campaigns`
is the cheap 80%.

---

## 6. Phased roadmap (highest leverage first)

- **Phase 1 — "Make it workable" (mostly UI wiring, days–weeks):** signal action bar +
  notes + assignee (#1, #9, #8); takedown approve/reject queue (#4); confidence column
  + automation-state badges (#2); finish pagination (#15). Unlocks the analyst from
  read-only with near-zero backend work.
- **Phase 2 — "Make the automation legible" (the differentiator):** the **Console**
  with the two-stream Needs-you / Auto-handled split (#3) + reasoning trail (#5) +
  Automation Policy surface (#17) + Audit Log (#10). This is what makes "mostly
  autonomous with a human supervisor" real and trustworthy.
- **Phase 3 — "Deepen the investigation":** Intelligence-Card detail with WHOIS/DNS/
  pivot/MITRE (#13), saved views/watchlists/suppression (#14), SLA timers (#11), bulk
  actions (#12), reporting/export (#16), and the Investigations/Case object (#7).

---

## 7. One-paragraph answer to the brief

Today the tenant view is a polished **read-only intelligence dashboard** with the
*skeleton* of analyst workflows (status lifecycles for Signals and Takedowns live in the
data) but essentially **no actionability** — an analyst can see and filter but cannot
triage, approve, assign, note, or override anything, and the platform never shows what it
auto-handled or *why*. Against ZeroFox/RF/Group-IB/Axur/Bolster, the missing pieces are a
**workable triage queue**, an **approve/reject gate**, a **detail/investigation card**,
and — most importantly for Averrow's autonomous thesis — the **two-stream "auto-handled
vs needs-you" split with a reasoning trail and an explicit automation-policy dial**. The
encouraging part: Averrow already built the autonomous engine and most of the supporting
endpoints (alert triage, AI judge, takedown-authorization scope with a per-takedown
approval gate, confidence scores, monitoring config, audit logging) — so the analyst
supervision cockpit is largely **frontend on top of capabilities that already exist**.

---

## 8. Sources

**Competitors** (vendor sites largely 403 the fetcher; specifics from vendor support
docs + open-source SOAR integration schemas that expose real field/status/action names,
cross-checked):
- ZeroFox — demisto/content XSOAR integration README (alert status enum, columns,
  actions), xsoar.pan.dev; zerofox.com Dashboard / Disruption / OnWatch.
- Recorded Future — support.recordedfuture.com (Intelligence Cards, Alert Management
  status enum), xsoar.pan.dev, recordedfuture.com Brand Intelligence / PhishPortal.
- Group-IB — group-ib.com DRP product/blog, Graph; drp-secops-integration (UDM model).
- Axur — axur.com Technical Information / Takedown / Threat Hunting / Polaris; QRadar
  LEEF schema (ticket model).
- **Netcraft** — demisto/content Netcraft_V2 XSOAR README (verbatim 10-state takedown
  enum, field/aging schema, escalation ladder, false_positive/managed flags).
- **Doppel** — doppel.com platform / phishing-triage (confidence-threshold HITL, AI
  justification, Threat Graph campaigns).
- **BrandShield** — brandshield.com AI.ClusterX, online-threat-takedown (case mgmt,
  evidence packages).
- **Bolster** — bolster.ai domain-monitoring / submitting-takedown-requests ("Dispute"
  gate, Insights detail, automation-first metrics).
- **Darktrace** — darktrace.com Cyber AI Analyst / Autonomous Response (Human-
  Confirmation ↔ Autonomous mode toggle, guardrails).
- **Cyberint / Check Point ERM** — cyberint.com dashboard-reports / Forensic Canvas;
  demisto/content + Splunk SOAR connectors (verbatim alert/takedown enums, facets).
- **Fortra PhishLabs** — PhishLabs Case API + XSOAR IOC_DRP/EIR (case status + type
  enums, classification model). **CloudSEK XVigil**, **Mimecast BEP**, **Memcyco** —
  vendor pages + reviews (operating-model context).

**Human-in-the-loop / SOAR UX:** Tines, Torq, Prophet Security, UnderDefense, Dropzone,
Vectra, TheHive/StrangeBee audit logs, Cymulate/Anomali (alert fatigue), Sheridan-
Verplanck automation taxonomy (arxiv), NIST SP 800-82, arxiv HITL papers
(2602.13745, 2505.23397, 2501.10467), Security Boulevard / secure.com (explainability).

**Averrow current state:** live prod walkthrough (`org_id=1`) of `/tenant`, `/threats`,
`/alerts`, `/takedowns`; code inventory of `packages/averrow-tenant/src` +
`packages/averrow-worker/src/routes/tenant.ts` & handlers (endpoints in §3).

