# Email Security Posture Engine

The Email Security Posture Engine performs outside-in analysis of a domain's email authentication configuration. It checks SPF, DKIM, DMARC, and MX records via DNS-over-HTTPS and produces a composite score with a letter grade.

## Source Files

- **Engine:** `packages/averrow-worker/src/email-security.ts`
- **API Handlers:** `packages/averrow-worker/src/handlers/emailSecurity.ts`
- **Database Migration:** `packages/averrow-worker/migrations/0020_email_security_posture.sql`

## How It Works

The engine uses Cloudflare DNS-over-HTTPS (DoH) at `https://cloudflare-dns.com/dns-query` -- free, requires no API key, and works from within Cloudflare Workers. All DNS lookups use JSON wire format with a 5-second timeout.

### Scan Pipeline

1. Four DNS checks run in parallel via `Promise.all()`
2. Results are scored using a weighted algorithm
3. A letter grade is derived from the composite score
4. Recommendations are generated based on findings
5. Results are cached in KV (1-hour TTL) and optionally persisted to D1

## DNS Checks

### DMARC Check

Queries `_dmarc.{domain}` for TXT records containing `v=DMARC1`.

Extracted fields:
- `policy` — `none`, `quarantine`, or `reject`. A missing or invalid `p=` (a typo, free text) is stored as `none`, flagged `policyInvalid` (recommendation: "DMARC p= value is invalid — receivers treat it as none"), and scored as no enforcement (`lib/dmarc-record.ts` `policyForStorage` / `pInvalid`); free text from the record is never stored in the policy column
- `pct` — Percentage of messages the policy applies to (deprecated by RFC 9989; read only as the old spelling of testing mode)
- `rua` — Aggregate report URI (indicates reporting is configured)
- `ruf` — Forensic report URI
- `sp`, `np`, `t`, `psd` — RFC 9989 tags (migration 0328, columns `dmarc_sp/np/t/psd`); `psd` is stored, never scored

### SPF Check

Queries `{domain}` for TXT records containing `v=spf1`.

Extracted fields:
- `policy` — The `all` mechanism: `-all` (hard fail), `~all` (soft fail), `?all` (neutral), `+all` (pass all)
- `includes` — Count of `include:` mechanisms
- `tooManyLookups` — Whether total DNS lookups exceed 10 (includes + redirects + a + mx records)

### DKIM Check

Probes common DKIM selectors by querying `{selector}._domainkey.{domain}` for TXT records containing `v=DKIM1` or `p=`.

The engine checks 20+ common selectors in batches of 5:

```
google, default, selector1, selector2, k1, k2, k3,
smtp, mail, email, dkim, s1, s2, mandrill, amazonses, cm,
proofpoint, pp, pphosted, mimecast, mimecast20190104,
everlytickey1, turbo-smtp, zendesk1, zendesk2
```

Early termination: if selectors are found after checking at least 10, the scan stops to conserve resources.

### MX Check

Queries `{domain}` for MX records and identifies the email provider by matching against known MX hostnames:

| MX Pattern | Provider |
|------------|----------|
| `google.com` / `googlemail.com` | Google Workspace |
| `outlook.com` / `protection.outlook.com` | Microsoft 365 |
| `pphosted.com` | Proofpoint |
| `mimecast.com` | Mimecast |
| `barracudanetworks.com` | Barracuda |
| `messagelabs.com` | Symantec |
| `iphmx.com` | Cisco |
| `fireeyecloud.com` | FireEye/Trellix |
| `secureserver.net` | GoDaddy |
| `zoho.com` | Zoho |
| `mx.cloudflare.net` | Cloudflare |

## Scoring System

The composite score is a point total with a maximum of 95, weighted as
follows. (DMARC used to carry a further +5 when aggregate reports went to
an Averrow address; that bonus was removed in 2026-10 (G30) so the grade is
neutral and comparable. No grade band moved: a fully configured domain
scores 95, still A+, and only domains reporting to Averrow lost 5 points.)

### DMARC (35 points max)

| Condition | Points |
|-----------|--------|
| Has DMARC record | +10 |
| Policy = `reject` | +20 |
| Policy = `quarantine` | +12 |
| Policy = `none` | +4 |
| Aggregate reporting (`rua`) configured, any destination | +5 |
| Testing mode (`t=y`, or legacy `pct` < 100) | enforcing policy scores one level lower (reject earns 12, quarantine earns 4) |
| `np=none` (or `sp=none` with no `np`) under quarantine / reject | -5 |

**Rubric version.** `EMAIL_SCORE_RUBRIC_VERSION` (`src/email-security.ts`, currently 2; 1 = the pre-RFC 9989 rubric, stored as NULL) is stamped on every `email_security_scans` row as `score_rubric_version` (migration 0328). Grade-change detection compares two scans only when the previous scan was graded under the current version: the orchestrator's alert pass (`findEmailGradeChanges`, `lib/email-grade-change.ts`) requires `score_rubric_version = <current>` on the previous row, and Cartographer's band-crossing notification skips a previous scan with a different or NULL version (`isRubricOnlyGradeChange`). The first rescan after a rubric change therefore updates the stored grade silently instead of telling a customer their protection changed when their DNS did not. **Every future change to `calculateEmailSecurityScore` must bump the constant.**

### SPF (30 points max)

| Condition | Points |
|-----------|--------|
| Has SPF record | +10 |
| Hard fail (`-all`) | +15 |
| Soft fail (`~all`) | +10 |
| Neutral (`?all`) | +3 |
| Under 10 DNS lookups | +5 |

### DKIM (20 points max)

| Condition | Points |
|-----------|--------|
| At least one DKIM selector found | +20 |
| No selector found, but MX is an enterprise provider (Google Workspace, Microsoft 365, Proofpoint, Mimecast, Barracuda) | +10 |

### MX (10 points max)

| Condition | Points |
|-----------|--------|
| Has MX records | +10 |

## Grading Scale

| Grade | Score Range |
|-------|------------|
| A+ | 90-95 |
| A | 80-89 |
| B | 70-79 |
| C | 55-69 |
| D | 40-54 |
| F | 0-39 |

## Recommendations Engine

The engine generates actionable recommendations based on findings:

- **No DMARC:** "CRITICAL: No DMARC record found. Anyone can send emails pretending to be your domain."
- **DMARC none:** "WARNING: DMARC policy is set to 'none' -- spoofed emails are not being blocked."
- **DMARC quarantine:** "GOOD: DMARC quarantine is active. Consider upgrading to 'reject'."
- **No DMARC reporting:** "No DMARC aggregate reporting configured."
- **No SPF:** "CRITICAL: No SPF record found."
- **SPF soft fail:** "SPF soft-fail detected. Upgrade to '-all'."
- **SPF too many lookups:** "SPF record exceeds 10 DNS lookups."
- **No DKIM:** "No DKIM signing detected."
- **No MX:** "No MX records found."
- **All good:** "Excellent! This domain has strong email authentication configured."

## API Endpoints

### Authenticated Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/email-security/:brandId` | Get latest scan for a monitored brand |
| POST | `/api/email-security/scan/:brandId` | Trigger manual scan for a brand |
| GET | `/api/email-security/scan-all` | Scan all brands (admin, up to 100) |
| GET | `/api/email-security/stats` | Aggregate grade distribution stats |

### Public Endpoint

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/public/email-security/:domain` | Live scan for any domain (rate-limited) |

The public endpoint normalizes the input domain (strips protocol, path, `www.` prefix), checks KV cache first, and returns cached results if available. Fresh scans are cached for 1 hour. If the domain matches a monitored brand, results are also persisted to D1.

## Integration with Brand Exposure Score

Email security scores feed into the broader Brand Exposure Score. When a brand is scanned:

1. The `email_security_score` and `email_security_grade` fields on the `brands` table are updated
2. The Cartographer agent periodically triggers email security scans for monitored brands
3. The Brand Exposure Report incorporates email security grade alongside threat data

The stats endpoint provides aggregate views: grade distribution, DMARC policy distribution, average score, and the worst-protected brands (grades F/D/C).

## Database Schema

Results are stored in `email_security_scans` with full record details:

- All DMARC fields (exists, policy, pct, rua, ruf, raw record)
- All SPF fields (exists, policy, includes count, too many lookups, raw record)
- DKIM fields (exists, selectors found as JSON)
- MX fields (exists, providers as JSON)
- Composite score and grade
- Scan duration in milliseconds

## Hosted DMARC Aggregate Reporting (RUA sensor)

Separate from the outside-in scan above: a brand can publish
`rua=mailto:dmarc_rua@averrow.ca` and Averrow receives the aggregate reports
mailbox providers send. Setup and routing: `docs/EMAIL_ROUTING_RUNBOOK.md`.
The scan only reads the brand's `rua=` (and no longer scores it); the data
below comes from the report receiver.

**Address.** `DMARC_RUA_PRIMARY` = `dmarc_rua@averrow.ca` (`lib/dmarc-rua.ts`).
`averrow.com` cannot receive (its MX is Google Workspace, which answers 550).
`dmarc_rua@averrow.com` and `dmarc_rua@trustradar.ca` stay in
`DMARC_RUA_ADDRESSES`: still routed to the receiver and still recognised as
"reports to Averrow", but only zones on Cloudflare Email Routing deliver. The
`email()` handler in `src/index.ts` matches the recipient case-insensitively.

**Pipeline** (`dmarc-receiver.ts`, `handleDmarcEmail`; never rejects or bounces mail):
1. MIME to XML (zip / gzip / plain). Raw mail capped at 5 MB, decompressed XML at 10 MB (12 MB and 3 candidate attachments per email).
2. Parse (`lib/dmarc-aggregate-xml.ts`): RFC 7489 and RFC 9990 shapes, with caps on records and fields. `<auth_results>` (DKIM/SPF) are parsed. A report claiming more than the per-report message cap is scaled down proportionally.
3. Provenance (`lib/dmarc-provenance.ts`): see below. Sets `verified`.
4. Gates, in order, each a counted drop (hourly KV buckets surfaced as diagnostics `dmarc_ingest`):
   - `no_brand`: `brands.canonical_domain` equal to the policy domain or a parent.
   - `ineligible_brand`: the brand must be tier `monitored` or `customer`, have a `source` an anonymous user cannot create (not `public_assess` / `self_service` / `ai_attributed`), and not sit on a shared-hosting domain. Otherwise anyone could create a brand for a domain they control and publish our `rua`.
   - `unenrolled`: only the brand's CANONICAL domain's own `_dmarc` record counts (never a subdomain's) and it must name one of our addresses. Evidence, cheapest first: a `dmarc_enrollment` row verified within 30 days (`ENROLLMENT_REVERIFY_DAYS`), the latest posture scan (within 7 days, `verified_via='scan'`), or a live DoH lookup (`'live_dns'`, KV-cached 6h when positive, 30 min when negative). A resolver failure is not "no record": it is never cached, never refreshes `rua_verified_at`, and a lapsed enrollment is still honoured for that report; with no prior enrollment the report is dropped as `unenrolled`.
   - `rate_limited`: at most `DMARC_BRAND_DAILY_CAP` (50) stored reports per brand per UTC day, counted separately for verified and unverified reports (forged mail cannot starve real reporters), and at most `DMARC_GLOBAL_HOURLY_CAP` (500) per UTC hour across all brands. Keyed on wall-clock time, never the report's own dates. If KV is unreadable the report is allowed but the inline rollup and ipinfo are skipped (Navigator catches up).
   - Also counted: `duplicate`, `unparseable`, `error` (receiver threw).
5. One atomic, retried batch: claim `(domain, reporter_org, report_id)` in `dmarc_report_seen` (a resent report changes nothing), upsert `dmarc_daily_stats` and insert `dmarc_reports` (`processed = 2`, `raw_xml` is no longer stored), both guarded on the claim. Per-source rows then go to `dmarc_report_records` (at most 1000 per report, failing first; `auth_json` keeps the evidence a later re-rollup needs).
6. `processed` finishes at 1 (complete) or 0 (records failed). A resend of a `processed = 0` report is not a duplicate: it deletes the partial records and completes the original row (stats are not re-counted).
7. Staff notification and the source rollup run after a complete report.

**Provenance.** Aggregate reports are unauthenticated XML, so each stores `sender_domain`, `sender_auth` and `verified` on `dmarc_reports`. `verified = 1` only when the From organizational domain is in `KNOWN_RUA_REPORTER_ORG_DOMAINS` (Google, Microsoft/Outlook, Yahoo, Mail.ru; a tunable heuristic) AND the topmost `Authentication-Results` header (the one our own MTA added) has an authserv-id in `TRUSTED_AUTHSERV_IDS` and shows `dkim=pass` / `dmarc=pass` for that organization. Only the topmost header is read; anything below it came from the sender. **Unconfirmed assumption:** `TRUSTED_AUTHSERV_IDS` (`mx.cloudflare.net`) has not been checked against real inbound mail. Until it is, expect every report to be `verified = 0`, which is the safe direction: unverified reports are stored as metadata only, spend no ipinfo and never notify. Confirm with the canary in `docs/EMAIL_ROUTING_RUNBOOK.md`.

**What `verified` gates.** Notification: a verified report with at least 100 messages and a fail rate over 10% raises one `email_security_change` notification, audience `team` (staff, never customers), severity `high`, text built only from the brand's canonical domain and computed numbers. ipinfo: only verified reports on the email path, never reserved/private ranges, at most 50 per report and 150 per UTC wall-clock day across all DMARC rollups (`dmarc:geo_used:<date>` in KV). `dmarc_source_daily.verified_fail_messages` records how much failing volume came from verified reports.

**DMARC pass = aligned DKIM pass OR aligned SPF pass.** Before 2026-11-14 the
receiver required both, which over-counted `total_fail`,
`dmarc_daily_stats.failed` and the notification (existing rows keep the old
counts; `dmarc_report_records.dmarc_result` is NULL on them).

**Source classification** (`lib/dmarc-source-classify.ts`, pure) and rollup
(`lib/dmarc-source-rollup.ts`, table `dmarc_source_daily`, one row per brand x
UTC day x source IP, non-passing sources only, up to 200 per report):
`aligned_pass`, `forwarder_likely`, `unaligned_shared_esp`, `spoof_candidate`
(ranked in that order; the most suspicious class seen wins). Metadata only: it
never creates alerts or threats and never gates triage. The rollup resolves
ASN/country (ipinfo only for verified reports, daily cap), the hosting provider, a NEXUS cluster and
Spamhaus ASN-DROP listing. The rollup is atomic: every upsert and the report's
`rolled_up_at` stamp go in one batch guarded on `rolled_up_at IS NULL`, so a
second run changes nothing. A stored report whose rollup never landed
(`processed = 1`, `rolled_up_at` NULL, over 5 minutes old) is rolled up by
Navigator every tick (at most 3, from `dmarc_report_records`, no ipinfo).
Read via `GET /api/dmarc-reports/:brandId/spoof-sources`;
onboarding state via `/setup` (see `docs/API_REFERENCE.md`).

**Limits of the signal.** RUA only shows mail using the brand's exact
header-from domain, from receivers that send reports; lookalike-domain mail
never appears.

**Retention** (`lib/dmarc-retention.ts`, Navigator's UTC-hour-0 block): `dmarc_report_records` and `dmarc_reports` 180 days by `received_at`, `dmarc_source_daily` 180 days by report date, `dmarc_report_seen` 61 days (longer than the 60-day report-date window, so a dedup key outlives any day it could collide with). `dmarc_daily_stats` and `dmarc_enrollment` are not swept.

**Migration 0329** creates `dmarc_report_records` (a no-op in prod, which has it
out of band), `dmarc_report_seen`, `dmarc_source_daily`, `dmarc_enrollment` and
the indexes, and ADDs columns: `dmarc_report_records.auth_json`;
`dmarc_reports.sender_domain`, `sender_auth`, `verified`, `claim_id`,
`rolled_up_at`. The ADD COLUMNs make it non-re-appliable.
