# Spam Trap Assessment & Uplevel Plan (2026-09)

Follow-up to `SPAM_TRAP_DIAGNOSIS_2026-06.md`. Prompt: "hasn't hit anything in
two months." Everything below was checked against live prod D1
(`trust-radar-v2`) on 2026-09-27 unless it is marked as an inference.

## Verdict

The trap has two separate problems.

1. **Inbound mail stopped on 2026-07-17, and the alert meant to catch that
   could not be stored.** This is an outage, not low yield.
2. **Even when mail was flowing, the planted-seed design produced almost
   nothing.** Traffic came from a handful of static addresses. The 1,393
   auto-planted seeds have never received a single message.

## What the data shows

| Signal | Value |
|---|---|
| Captures, all time | 87 |
| Last capture | 2026-07-17 20:07:28 UTC (72 days ago) |
| Last abuse-mailbox message | 2026-07-17 20:07:26 UTC, 2 s earlier |
| DMARC aggregate reports, all time | **0** |
| Seeds planted | 1,470 (631 in the last 60 days; planter healthy) |
| Seeds that have *ever* caught mail | 8 |
| Auto-seeder (`employee`) seeds that ever caught mail | **0 of 1,393** |
| Honeypot page hits, last 30 days | 36,068, all on lrxradar.com, mostly `.env`/`wp-admin` scanners |
| Hits on `/admin-portal`, `/internal-staff`, `/team-directory`, `/staff-contacts` | **0, ever**, on any domain |
| Spam-trap freshness notifications | **0, ever** |

All 8 productive seeds are static, human-looking addresses on crawled pages:
`sp.trap02/04/07@trustradar.ca` (spider-trap block on public pages) and
`contact@ / info@ / sales@ / finance@lrxradar.com`.

## Root causes

### 1. Worker rename unbound Email Routing (prime suspect — needs a dashboard check)

On 2026-07-17 the Worker was renamed in place from `trust-radar` to
`averrow-worker` (commits `1b6fb542`, `9d99db9d`). Cloudflare's docs state:

> Renaming a Worker removes the binding between that Worker and any routes
> that point to it. After renaming, edit the affected rules to point at the
> renamed Worker.
> — developers.cloudflare.com/email-service/configuration/email-routing-addresses/

Captures and the abuse mailbox, which go through two different handlers, both
stopped within 2 seconds of each other that evening. Nothing has arrived
since. The `email()` handler has not changed since the rebrand. Email Routing
rules are not readable from this repo or its tooling, so this is **inferred**.
It fits the evidence and the documented behaviour; confirm it in the dashboard.

### 2. The freshness alert was built, and prod rejected every one it raised

After June, Flight Control gained a 14-day `platform_spam_trap_capture_stale`
guard and a 10-day `platform_spam_trap_seeding_stalled` guard. Neither key was
ever added to the `notifications.type` CHECK constraint. Each INSERT was
rejected and swallowed, so the alert has fired into the void since roughly
2026-07-31. `takedown_awaiting_approval` has the same defect. This is the
third occurrence of this drift class: 0207 and 0215 each re-synced it by hand.

### 3. The rebuild used to widen that CHECK wipes notification delivery history

`DROP TABLE notifications` runs an implicit DELETE, which fires
`notification_deliveries`' ON DELETE CASCADE. `defer_foreign_keys` does not
prevent this (verified against SQLite 3.45). Prod shows it happened: 0215
applied at 2026-06-15 14:46:48, and the oldest surviving delivery row is from
14:51:35 that day. The table has existed since 2026-05-04.

### 4. The seeds are where harvesters aren't

- **lrxradar.com hid its own bait.** The lrxradar catch-all returned before
  the roster-page routes, so its 346 planted seeds were never published. It is
  the one domain with real crawler traffic.
- **Nothing links to the bait pages.** They appear only as `Disallow` lines in
  robots.txt, and have received 0 hits in six months. The "Disallow as bait"
  theory did not hold. robots.txt also lists them with a trailing slash
  (`/admin-portal/`) that the routes don't match, so a crawler that does
  follow the Disallow list gets a different page.
- **averrow.com seeds cannot receive mail.** Per `EMAIL_ROUTING_RUNBOOK.md`,
  averrow.com MX stays on Google Workspace, which answers 550 NoSuchUser. Its
  352 seeds bounce, and a bounce tells a list validator to drop the address.
  The same applies to `dmarc_rua@averrow.com`, hence 0 DMARC reports.
- **Seeds became fingerprintable.** The 1,200-name pool is saturated, so the
  collision fallback `first.last.YYYYMMDD@` became the dominant shape. Most
  recent seeds look like `hannah.bennett.20260925@trustradar.ca`.

### 5. Structural: Cloudflare Email Routing filters the traffic a trap wants

Before any rule or Worker runs, Email Routing rejects mail that fails the
sender's DMARC policy and mail from IPs on real-time blocklists
(Cloudflare Email Lifecycle and Postmaster docs). Botnet spam and brand-spoof
phish are exactly that traffic. A trap behind Email Routing only ever sees
the authenticated, non-blocklisted residue. That is a hard ceiling on yield
no matter how well the seeds are placed.

## Fixed in this change

| Fix | Where |
|---|---|
| Widen the CHECK for the 3 missing keys; back up and restore `notification_deliveries` around the swap | `migrations/0265_notifications_resync_spam_trap_takedown.sql` |
| CI guard: registry ⊆ CHECK, and any later notifications rebuild must preserve deliveries | `test/notification-check-drift.test.ts` (fails without 0265, naming the 3 keys) |
| lrxradar.com serves its roster bait pages instead of swallowing them | `src/index.ts` |
| lrxradar's hidden link block links to `/team-directory` and `/staff-contacts` so link-following harvesters reach rotated seeds | `src/templates/honeypot-lrx.ts` |
| Collisions use real directory shapes (`flast`, `first.l`, `first_last`, …) instead of a date stamp, picked with one batched lookup per seed | `src/lib/auto-seeder-planter.ts` + tests |
| Runbook: correct Worker name; warn that renames unbind rules | `docs/EMAIL_ROUTING_RUNBOOK.md` |

Once 0265 applies, the capture-stale alert will fire on the next Flight
Control tick. That is correct: it has been true for ten weeks.

## Owner actions (dashboard — can't be done from the repo)

1. **Re-point Email Routing** on averrow.ca, trustradar.ca and lrxradar.com.
   Set each catch-all (`*@domain`) and each literal rule to *Send to Worker →
   averrow-worker*. Confirm the catch-all is **enabled**, not just present.
2. **Canary.** From an external mailbox, send to
   `canary-<random>@trustradar.ca` and to `phishing@averrow.ca`. The first
   should appear in `spam_trap_captures` and the second in
   `abuse_inbox_messages` within seconds.
3. **Read what's being rejected.** Email Routing → Activity log, or the
   `emailRoutingAdaptive` GraphQL dataset, lists every *Rejected* message with
   sender IP, envelope sender and auth result. That is capture-grade metadata
   the platform currently throws away.
4. **Stop planting on averrow.com** (`UPDATE seed_domains SET status='paused'
   WHERE domain='averrow.com'`), or move a subdomain of it to Email Routing.
   Point DMARC `rua` at `dmarc_rua@trustradar.ca`, the Worker-routed address
   the `email()` handler already dispatches to the DMARC parser (any other
   address falls through to the spam-trap handler).

## Uplevel roadmap (from external research)

Ranked by leverage for a small team on Cloudflare.

| # | Technique | Effort | Why |
|---|---|---|---|
| 1 | **Ingest Email Routing *Rejected* events** (GraphQL `emailRoutingAdaptive`) as low-fidelity captures: IP, envelope-from, SPF/DKIM/DMARC | S | Recovers the blocklisted and DMARC-failing traffic Cloudflare drops before the Worker. Probably the largest immediate volume gain. |
| 2 | **DMARC RUA on every protected brand domain** into the existing `dmarc_reports` pipeline | S | Direct "who is sending as this brand" signal. Use RUA only; Gmail and Microsoft don't send RUF forensic reports. |
| 3 | **A non-Cloudflare MX for dedicated trap domains** (small Postfix VPS or a mail-in service POSTing to the Worker) | M | Removes the RBL/DMARC pre-filter entirely, so full bodies arrive for botnet spam and spoof phish. |
| 4 | **Catch-all lookalike/typo domains of customer brands** (register defensively, route to the trap) | M | The Godai "doppelganger" study captured ~120k emails in 6 months from 30 domains. The yield is brand-relevant by construction. Store metadata and URLs; purge bodies (misdirected personal mail). |
| 5 | **Log every catch-all recipient local-part** and classify it as planted seed vs dictionary/DHA guess | S | Modern harvesting is largely directory-harvest attacks against catch-all domains. That traffic is already arriving when routing works; it just isn't labelled. |
| 6 | **Aged/expired-domain recycled traps**: buy domains with prior mail history, bounce everything for months, then accept | M–L | How the large trap networks (Spamhaus, Abusix) get volume. Slow to mature. |
| 7 | **External feeds**: OpenPhish community, abuse.ch; apply to APWG eCX (brand-tagged) and Spamhaus's trap-data exchange | S–M | Volume doesn't depend on self-capture at all. Check `feeds/` for overlap first. |
| 8 | **Seed where crawlers actually go**: plain-text `mailto:` on linked, crawled pages; per-page unique seeds; a GitHub commit-email seed | S | Only the static, human-looking addresses on lrxradar and the trustradar spider block ever caught anything. Project Honey Pot measured ~2.5 weeks from harvest to first spam. |

Sources: Cloudflare Email Service docs (email-lifecycle, postmaster,
email-routing-addresses, limits); Spamhaus spamtrap resource centre; Abusix
Guardian Intel overview; Godai Group *Doppelganger Domains* (2011); Szurdi et
al., IMC 2017; Project Honey Pot statistics; PowerDMARC on RUF deprecation;
APWG eCX; OpenPhish.

## Monitoring gaps still open

- The freshness guard alerts on capture age alone. A true pipeline canary
  would be a scheduled external send, with an alert if it isn't captured.
  That needs an outbound sender outside Cloudflare, since Email Routing
  can't receive mail the account itself sends. Not built here.
- `abuse_inbox_messages` silence goes unwatched unless the classifier alert
  covers it. It went quiet on the same day and nothing fired.
