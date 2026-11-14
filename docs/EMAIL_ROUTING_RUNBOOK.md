# Abuse-Mailbox Email Routing Runbook

How public abuse mailboxes (`abuse@`, `phishing@`, `report@`, `security@`) reach the Worker. Path: **averrow.ca** owns the public mailboxes, CF Email Routing forwards directly to the Worker, no Google Workspace in the loop.

## Architecture

```
External submitter
    │
    ▼  (sends mail to abuse@averrow.ca)
Cloudflare Email Routing MX for averrow.ca
    │
    ▼
averrow Worker  ───►  handleAbuseMailboxEmail()
    │
    ├─►  INSERT abuse_inbox_messages
    ├─►  sendAck() to original submitter (Resend, ~1-3s)
    ├─►  Cross-link to spam_trap_captures (covert spam trap)
    │
    ▼ (next hourly orchestrator tick, PR-AG)
runAbuseClassifierBackfill()
    ├─►  Haiku verdict (phishing/malware/spam/benign/ambiguous)
    ├─►  UPDATE classification + severity
    └─►  sendDetermination() to original submitter (Resend)
```

## Why averrow.ca and not averrow.com

`averrow.com` is on Google Workspace — its MX records point to Google's servers so your `claude.leroux@averrow.com` inbox keeps working. CF Email Routing can't co-exist with Workspace on the same zone (it requires owning the MX). So we use **averrow.ca**, which is owned + on Cloudflare but has no Workspace conflict.

The user-facing address on the marketing page becomes `abuse@averrow.ca` etc. — `averrow.com` apex remains on Workspace, untouched.

## Setup steps (~5 min, one-time)

### 1. Cloudflare — enable Email Routing on averrow.ca

CF Dashboard → averrow.ca zone → Email → Email Routing → Enable.

If a DNS-conflict warning appears, check whether averrow.ca has existing MX records (it shouldn't since it's not on Workspace). CF adds its own MX records to the zone.

Then add either a catch-all or individual routes. Catch-all is simplest:

| Pattern | Action |
|---|---|
| `*@averrow.ca` | Send to Worker → averrow-worker |

Or individual rules (4):

| Pattern | Action |
|---|---|
| `abuse@averrow.ca` | Send to Worker → averrow-worker |
| `phishing@averrow.ca` | Send to Worker → averrow-worker |
| `report@averrow.ca` | Send to Worker → averrow-worker |
| `security@averrow.ca` | Send to Worker → averrow-worker |

> ⚠ **Renaming the Worker silently unbinds every rule above.** Cloudflare:
> "Renaming a Worker removes the binding between that Worker and any routes
> that point to it." The in-place rename `trust-radar` → `averrow-worker` on
> 2026-07-17 is the prime suspect for inbound mail stopping that evening
> (last spam-trap capture and last abuse-mailbox message 2026-07-17 20:07 UTC,
> none since). After any rename, re-point the rules on **every** zone —
> averrow.ca, trustradar.ca, lrxradar.com — and send the canary in step 3.
> See `docs/SPAM_TRAP_ASSESSMENT_2026-09.md`.

### 2. Confirm migrations applied

```bash
wrangler d1 migrations list trust-radar-v2 --remote
# expect 0180_averrow_self_abuse_mailbox and 0182_averrow_ca_abuse_aliases applied
```

Migration 0180 seeded `abuse@/phishing@@averrow.ca` aliases into `org_abuse_aliases`. 0182 adds `report@/security@@averrow.ca` so all four bind to the `_averrow_platform` synthetic org.

### 3. Verify end-to-end

```bash
# Send a test
echo "test phishing for runbook" | mail -s "Runbook smoke test" phishing@averrow.ca

# Wait ~5 seconds for CF → Worker
wrangler d1 execute trust-radar-v2 --remote --command \
  "SELECT id, inbound_alias, original_subject, classification, ack_sent_at
   FROM abuse_inbox_messages
   WHERE inbound_alias = 'phishing@averrow.ca'
   ORDER BY received_at DESC LIMIT 1"
# expect: ack_sent_at populated (the responder fired)
```

You should also have an **ack email** in the original submitter's inbox within seconds.

Wait up to 1 hour for the orchestrator's hourly classifier cron tick — or trigger manually:

```bash
curl -X POST "https://averrow.com/api/admin/abuse-mailbox/run-classifier?limit=50" \
  -H "Authorization: Bearer $JWT"

wrangler d1 execute trust-radar-v2 --remote --command \
  "SELECT classification, severity, ai_assessment, determination_sent_at
   FROM abuse_inbox_messages ORDER BY received_at DESC LIMIT 1"
# expect: classification != 'pending', determination_sent_at populated
```

A **determination email** with the verdict arrives at the original submitter.

## DMARC aggregate reports (`dmarc_rua@averrow.ca`)

The same Email Routing setup carries DMARC aggregate (RUA) reports. The
address customers publish is `dmarc_rua@averrow.ca` (`DMARC_RUA_PRIMARY`,
`src/lib/dmarc-rua.ts`). It must be on averrow.ca: `averrow.com`'s MX is Google
Workspace, which answers 550, so `dmarc_rua@averrow.com` has never delivered a
report. `dmarc_rua@averrow.com` and `dmarc_rua@trustradar.ca` are still routed
to the receiver if mail ever reaches them. The `email()` handler matches the
recipient case-insensitively; before this, an averrow.ca RUA message fell
through to the spam trap.

Both steps below are manual and required before any report can arrive:

1. **External-destination authorization (RFC 7489 section 7.1).** Receivers
   will not send a customer's reports to an address outside the customer's
   domain unless this record exists. Publish in the averrow.ca zone:
   `TXT  *._report._dmarc.averrow.ca  =  v=DMARC1`
   (a wildcard authorizes every customer; the per-domain form is
   `<customer-domain>._report._dmarc.averrow.ca`, shown by `GET
   /api/dmarc-reports/:brandId/setup` as `authorization_record_name`).
2. **Routing rule.** In Email Routing for averrow.ca, confirm the rule for
   `dmarc_rua@averrow.ca` (or the `*@averrow.ca` catch-all) is
   "Send to Worker -> averrow-worker". Renaming the Worker unbinds it (see above).

A customer then publishes `rua=mailto:dmarc_rua@averrow.ca` in their
`_dmarc` TXT. Reports are stored only for brands whose `_dmarc` record names
our address (enrollment gate); other mail is dropped and counted.

**Canary test.**
1. Confirm the authorization record: `dig TXT test._report._dmarc.averrow.ca +short` returns `"v=DMARC1"`.
2. Pick a brand whose `_dmarc` names our address (or publish it on a test brand), then send a minimal aggregate report (plain XML, or gzip) to `dmarc_rua@averrow.ca` with `<policy_published><domain>` set to that brand's domain.
3. Check `GET /api/dmarc-reports/:brandId/setup` shows `enrolled: true`, and:
   ```bash
   wrangler d1 execute trust-radar-v2 --remote --command \
     "SELECT id, domain, reporter_org, total_messages, total_fail, received_at
      FROM dmarc_reports ORDER BY received_at DESC LIMIT 1"
   ```
4. Platform diagnostics `dmarc_ingest`: `reports_24h` rises on success. If the report is missing, `dropped_24h` says why (`no_brand`, `unenrolled`, `duplicate`, `unparseable`). If neither moves, mail never reached the Worker: check the routing rule. A resend of the same report counts `duplicate` and writes nothing.

## What this does to averrow.com

Nothing. Google Workspace keeps owning the MX records for averrow.com. Your `claude.leroux@averrow.com` Gmail inbox is unaffected. The previously-seeded `abuse@averrow.com` rows in `org_abuse_aliases` from migration 0180 are now dead aliases — they exist in DB but no mail can reach them (Workspace returns 550 NoSuchUser, the Worker never sees them). Harmless — they're idempotent placeholders.

## Marketing page

The `/report-abuse` page on averrow.com advertises the public mailboxes. After this setup, those mailto links must point at the **averrow.ca** versions. See the PR-AG marketing update — `packages/averrow-marketing/src/pages/report-abuse.astro`.

## Cosmetic notes

- `spam_trap_captures.spf_result / dkim_result / dmarc_result` reflect the original submitter's authentication. CF Email Routing's MX puts itself in the SPF path, so SPF results will sometimes show `softfail` for legitimate senders whose domain doesn't allow the CF MX in their SPF record. Don't gate alerting on a single auth-fail — the audit's planned correlation (PR-AC) and AI classifier carry the actual verdict.

- `forwarded_by_email` on each row = the original submitter (the person who sent the mail). The ack + determination emails go to this address.

## Adding more mailboxes later

To add e.g. `vulnerability@averrow.ca`:

1. Add the CF Email Routing rule (or rely on the catch-all)
2. Add to migration 018X seeding `vulnerability@averrow.ca` into `org_abuse_aliases`
3. Add `vulnerability` to `PLATFORM_ALIASES` in `src/index.ts` (the bare-prefix list that decides which local-parts route to the abuse-mailbox handler)

## Related

- `migrations/0180_averrow_self_abuse_mailbox.sql` — Averrow self-org + initial aliases (averrow.com rows are dead per the note above)
- `migrations/0182_averrow_ca_abuse_aliases.sql` — extended averrow.ca aliases
- `src/handlers/abuseMailboxEmail.ts` — Worker email entrypoint + ack send
- `src/lib/abuse-mailbox-classifier.ts` — AI classifier + determination send
- `src/cron/orchestrator.ts` — hourly classifier cron tick (PR-AG)
- `docs/SEED_DOMAINS_RUNBOOK.md` — sibling runbook for spam-trap honeypot expansion
