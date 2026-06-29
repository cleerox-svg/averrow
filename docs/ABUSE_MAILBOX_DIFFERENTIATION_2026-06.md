# Abuse Mailbox — Competitive Differentiation & Positioning Assessment (2026-06)

Prompted by: "research competitor abuse mailboxes, ensure we differentiate."
Grounded in competitor web research + a 5-area code audit of the live
platform. This is a strategy/assessment doc, not a spec.

---

## TL;DR

1. **The inbox is table stakes.** The market does not sell "an abuse
   mailbox." ZeroFox explicitly treats abuse-mailbox ingestion as a
   *connector* that feeds takedown + internal visibility. The product is
   **what the inbox feeds**: takedowns, records in the customer's stack,
   and an auditable compliance trail.

2. **Averrow already owns the hardest differentiator — and isn't using
   it on the mailbox.** There is a **live, no-human-in-the-loop
   auto-takedown** path in production today (Sparrow Phase G, NetBeacon /
   GoDaddy / Google Web Risk / Resend, `TAKEDOWN_SEND_MODE='live'`). This
   is exactly what Netcraft (80–90% automated) and ZeroFox (2M+/yr) lead
   with. **But the abuse mailbox is not wired into it**, and
   typosquats/lookalikes are an orphan source that never auto-takes-down.

3. **The actual selling point the user named — "feed the customer's
   systems" — is the weakest area.** Webhooks + STIX export are real;
   every named SIEM/SOAR/ticketing connector (Splunk, Sentinel, QRadar,
   Jira, ServiceNow) is a credential-storage shell with **no delivery
   engine**.

So the differentiation work is mostly **wiring existing strengths
together + building the data-out layer**, not inventing takedown from
scratch.

---

## Market landscape (two camps; the gap between them is ours)

| Camp | Players | What they sell |
|---|---|---|
| **Internal phishing-report triage** | Cofense Triage, Proofpoint CLEAR, Microsoft, Abnormal | Employee "Report Phish" → `abuse@` → AI confidence score → **auto-quarantine from the customer's own mailboxes**. Inward-facing, email-security teams. |
| **External brand-abuse intake + takedown** | ZeroFox, Netcraft, Bolster, BrandShield | Protect the brand + its customers. Headline metric is **takedowns** (Netcraft 1.9h median, 80–90% no-human; ZeroFox 2M+/yr, 95%+). Abuse mailbox is one input among DMARC, web logs, beacons. |

Averrow's mailbox is a **customer-branded report-fraud inbox** (the
customer's customers + staff report to a branded alias) that triages AND
promotes to the threat pipeline AND can take down. It straddles both camps
— which is the differentiation, *if the loop is closed*.

Compliance angle (validated): GDPR/HIPAA/ISO 27001 demand demonstrable,
auditable incident records; SOAR vendors (Torq, Swimlane, QRadar SOAR)
lead with bidirectional **ticketing (Jira/ServiceNow) + audit trails**.
The user's Atlassian idea maps to a real buyer requirement.

---

## What Averrow already has (evidence-based)

### Auto-takedown — LIVE, the crown jewel (`agents/sparrow.ts`)
- Sparrow Phase G auto-drafts → resolves provider → **submits a real
  abuse report with no human**, for orgs on a signed `auto` policy.
  `wrangler.toml:301` `TAKEDOWN_SEND_MODE='live'`; NetBeacon/GoDaddy/Web
  Risk `auto_submit_enabled=1` (migration 0226).
- Layered consent: entitlement + signed authorization + monthly cap +
  per-provider gate + policy mode. Conservative default is `semi_auto`
  (auto LOW/MEDIUM only); customers can opt into full `auto`.
- Sources that auto-takedown today: malicious **URL scans**, **social**
  impersonations, **app-store** listings, confirmed **dark-web** mentions.
- Post-takedown verification + resurrection re-alerting (Phase F); SLA
  follow-ups (Phase H); full `takedown_submissions` audit trail.

### Data-out (`lib/stix.ts`, `lib/webhooks.ts`, `handlers/export.ts`)
- **Real:** STIX 2.1 bundle/indicator export (download-only), CSV export
  (staff-auth), broad REST API, **signed outbound webhooks** (HMAC-SHA256,
  SSRF-guarded, per-org event filter) wired to 5 producers.
- **Caveats:** webhooks are fire-and-forget (no retry/DLQ/delivery log);
  only 4 of 7 declared event types actually fire.

### Typosquat/lookalike (`scanners/lookalike-domains.ts`)
- Per-brand permutation generation (8 mutation classes) + 24h DNS/MX/HTTP
  re-check + Haiku threat-level + **auto-alert** on new registration.

### Abuse mailbox responses (`lib/abuse-mailbox-responder.ts`)
- Two automated emails: instant **ack** + **determination** (verdict-keyed
  copy table), Averrow-branded, RFC 8058 unsubscribe.

### Alias routing (`src/index.ts`, `org_abuse_aliases`)
- Inbound routed by local-part (`verify-*`/`report-*`/`abuse-*`/platform
  set) on Averrow-owned domains, bound to org by exact address match.

---

## Gap analysis — the user's wishlist vs reality

| Wishlist item | Status | Evidence / gap |
|---|---|---|
| **Auto-takedown of malicious URLs** | ✅ **Already live** | Sparrow Phase G; `TAKEDOWN_SEND_MODE='live'`. Under-leveraged in messaging. |
| **Auto-takedown of typosquats** | ❌ **Gap** | Lookalike pipeline only detects + alerts; never creates a takedown. Sparrow doesn't read `lookalike_domains` — orphan source. |
| **Report → takedown (close the loop)** | ❌ **Gap** | Abuse classifier promotes confirmed phishing to `threats`, but Sparrow auto-takedown reads `url_scan_results`, **not** `threats`. A reported+confirmed phish is **not** auto-taken-down. The headline loop is open. |
| **Send signal to SIEM / TIP** | 🟡 **Partial** | Webhooks + STIX download real; **no** Splunk/Sentinel/QRadar delivery code (marketing "Coming Soon"). No outbound TAXII server (the "STIX/TAXII — Live" card half-overclaims). |
| **Atlassian/Jira (+ServiceNow) ticketing for compliance record** | ❌ **Gap** | `org_integrations` stores encrypted Jira/ServiceNow creds but the "test" is a stub and **nothing reads it to deliver**. No ticket create/close, no compliance export. |
| **Branded alias domains** (customer subdomain or Averrow-branded) | ❌ **Gap** | Only Averrow-owned platform mailboxes exist. Per-tenant `verify-<tenant>@averrow.com` is documented but **never minted** (no provisioning code). No custom-domain/verification schema. Replies are hardcoded Averrow branding. |
| **Auto-responses for other things** | ❌ **Gap** | Only ack + determination, both hardcoded Averrow. No per-org templating/branding; no closure/escalation/human-handoff emails. |

---

## Prioritized roadmap (by leverage ÷ effort)

### Tier 1 — Close the loop (small wiring, huge story; leverages live auto-takedown)
1. **Report → takedown.** Bridge abuse-mailbox-confirmed phishing into
   Sparrow's auto-takedown (add abuse-promoted URLs as a Sparrow source,
   or route them through `url_scan_results`). Turns "we triage your
   reports" into "**we take them down, automatically**."
2. **Typosquat → takedown.** Wire HIGH/CRITICAL `lookalike_domains` into
   Sparrow (the orphan source). Directly delivers the user's
   "auto-takedown of typosquats."

*Why first: the takedown engine already exists and is live. These are
integration tasks, not new capabilities — the highest leverage on the
board.*

### Tier 2 — Data-out + compliance (the real product)
3. **Delivery engine on `org_integrations`** (it's a shell today). Start
   cheapest-first: **Splunk HEC** (an HTTP POST + token), then **Microsoft
   Sentinel** (Log Analytics ingestion), then **Jira/ServiceNow** ticket
   create-on-detection + close-on-resolution (the compliance record the
   user wants).
4. **Harden webhooks** (retry/backoff + delivery log/DLQ) — required to
   claim "delivered to your system" for compliance.
5. **Outbound TAXII server** so the "STIX/TAXII — Live" claim is true and
   customers can poll Averrow as a collection.

### Tier 3 — Branding & config
6. **Per-tenant alias provisioning** (mint `verify-<tenant>@averrow.com`)
   — the cheap branded option, schema is ready.
7. **Parameterize the responder** (per-org From/logo/footer + templated
   copy) — needed for branded replies and any new auto-response types.
8. **Customer custom domains** (`report.theirbrand.com`) — needs domain
   verification + MX delegation + new schema. Biggest lift; do last.

---

## Positioning shift

**From:** "A branded inbox that triages forwarded fraud reports with AI."
**To:** "Turn every fraud report into an automatic takedown, a record in
your SIEM/TIP, and an auditable compliance ticket — branded to you."

The inbox becomes the *intake*; the value props are **(1) closed-loop
auto-takedown, (2) data-out to the customer's stack, (3) compliance
trail.** This matches exactly how the market leaders position.

---

## Tenant + marketing alignment

- **Marketing reframe.** Lead with takedown + data-out + compliance, not
  the inbox. Add an "It feeds your stack" section (SIEM/TIP/ticketing) and
  a "From report to takedown" loop diagram. Honor the gap: only claim what
  ships (relabel "STIX/TAXII — Live" until the TAXII server exists).
- **Branded email-template visual (user request).** Replace the page's
  "Live Determination" data box with a **mockup of the branded
  determination email** — it reinforces "branded to you" and shows the
  real customer-facing artifact. (Note: per-org branding is a Tier-3 gap
  today; the mockup should depict the target experience, or stay
  Averrow-branded honestly until Tier 3 lands.)
- **Tenant module copy.** Emphasize "your reports feed your SIEM + trigger
  takedowns," not just the unified inbox. Surface the takedown + data-out
  status per report.

---

## Honesty / risk notes
- Don't market SIEM/SOAR/ticketing as available — they're credential
  shells. Market the **takedown automation** (real) and the **roadmap**.
- The open report→takedown loop is the most important gap: customers will
  reasonably assume a confirmed phish gets taken down. Closing Tier 1 #1
  should precede any "we take down what you report" marketing claim.
