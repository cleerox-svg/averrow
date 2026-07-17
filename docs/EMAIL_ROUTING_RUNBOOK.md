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
| `*@averrow.ca` | Send to Worker → averrow |

Or individual rules (4):

| Pattern | Action |
|---|---|
| `abuse@averrow.ca` | Send to Worker → averrow |
| `phishing@averrow.ca` | Send to Worker → averrow |
| `report@averrow.ca` | Send to Worker → averrow |
| `security@averrow.ca` | Send to Worker → averrow |

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
