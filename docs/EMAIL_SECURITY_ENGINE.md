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

Queries `{domain}` for TXT records (`lib/doh.ts` `dohTxtLookupDetailed`, uncached) and keeps those that are SPF records (`v=spf1` followed by a space or the end). The record is parsed by `lib/spf-record.ts` (RFC 7208) and its include tree is walked by `lib/spf-walk.ts`.

**Parser** (`parseSpfRecord`, pure): mechanisms with qualifiers (`+` default, `-`, `~`, `?`) — `all`, `include`, `a`, `mx`, `ptr`, `exists`, `ip4`, `ip6` — plus the `redirect=` / `exp=` modifiers (unknown modifiers are ignored). Syntax errors (unknown mechanism, missing or forbidden argument, bad address or CIDR length, duplicate `redirect`/`exp`, malformed macro) are fixed strings that never echo record text. Terms after the first `all` are never evaluated (§5.1) and `redirect` is ignored when the record has an `all` (§6.1), so neither counts.

**Include-tree walk** (`walkSpfTree`): follows every evaluated `include:` and an applicable `redirect=` and counts, as a worst-case receiver evaluation would:
- DNS-querying terms (`include`, `a`, `mx`, `ptr`, `exists`, `redirect`) against the RFC 7208 §4.6.4 limit of 10 (`SPF_MAX_DNS_LOOKUPS`). A duplicate include counts per occurrence but is fetched once.
- Void lookups (an include / redirect target that is NXDOMAIN or has no TXT answers) against the limit of 2 (`SPF_MAX_VOID_LOOKUPS`). `a` / `mx` / `ptr` / `exists` are counted but not resolved, so the void count covers include / redirect targets only.
- Loops (a target already on the current include path, including the root), targets with no SPF record, targets with more than one SPF record, `ptr` use and syntax errors anywhere in the tree.

Hard bounds per walk — the amplification defence, since the records come from third-party DNS and the public endpoint takes attacker-chosen domains: the walk stops as soon as more than 10 lookups are proven (a receiver permerrors there too; the count is then reported as "at least N"), and since every followed target is itself a counted lookup a walk issues at most ~11 queries; `SPF_WALK_MAX_QUERIES` = 25 DoH queries (the root query is separate) is defence in depth. Also: `SPF_WALK_BUDGET_MS` = 4 s wall time (each query gets only what is left and is raced against it), `SPF_WALK_MAX_DEPTH` = 6 levels of nesting, `SPF_WALK_MAX_VISITS` = 60 record evaluations, `SPF_MAX_TERMS_PER_RECORD` = 100 terms parsed per record (`lib/spf-record.ts`; more → walk `unknown`, reason `term_cap`), names deduped, and no per-target work after any cap. A name is queried only if it is a valid public DNS name (`spfWalkName`: no macros, no IP literals, no malformed / over-long names, no `localhost`/`local`/`internal`/`corp`/`home`/`lan`/`arpa`/`test`/`invalid`/`example`/`onion`/`alt`/… TLDs).

**Honesty rule** (as in `lib/dnsbl-doh.ts`): a failed or timed-out lookup, a macro or invalid name, or a cap being reached makes the walk `unknown` — never pass, never fail. Counts are then lower bounds; a limit is reported exceeded only when the part that WAS read already exceeds it. A failed include is never counted as a void lookup or a missing record.

Extracted fields:
- `policy` — effective `all`: `-all`, `~all`, `?all`, `+all` (a bare `all` is `+all`); for a record without `all`, the `all` reached through its `redirect=` chain (null when none or not read)
- `includes` — count of evaluated `include:` mechanisms in the root record
- `tooManyLookups` — PROVEN more than 10 DNS lookups across the tree
- `lookupCount`, `voidLookups` — tree totals (lower bounds when `walkStatus = unknown`)
- `walkStatus` — `complete` | `unknown` | `no_record` | `not_walked` (multiple records: a permerror before any evaluation, so the tree is not walked) | `root_error` (see below).
- `findings` — `[{ code, names?, count?, atLeast? }]`; `names` are validated DNS names (≤ 5), `count` a number (`atLeast` = lower bound), never record text. Codes: `lookup_limit_exceeded`, `void_lookup_limit_exceeded`, `multiple_records` (at the domain), `include_multiple_records` (at an include target), `pass_all` (the effective root policy), `include_pass_all` (`+all` / bare `all` in a record reached through an include — recommendation only), `neutral_all`, `ptr_mechanism`, `syntax_error`, `include_loop`, `include_target_missing` (no SPF record, or the target does not exist — also the dangling-include / re-registration risk), `walk_incomplete`, `root_lookup_failed`.

**Root lookup failure.** When the domain's own TXT lookup fails, the SPF record was not read, so the scan never reports or stores "no SPF record". Brand scans (Cartographer, orchestrator, curator, the staff scan routes) pass `previousSpfLoader(db, brandId)`: it is called only on that failure and returns the SPF of the brand's latest scan whose SPF WAS checked (`spf_exists IS NOT NULL`), which is carried forward unchanged (same score) with the `root_lookup_failed` finding ("the result shown is from the previous scan"). With no such scan (first scan, public check, or the read failed) SPF is "not checked": `walkStatus = root_error`, `rootError`, 0 SPF points, the recommendation "Could not check the SPF record…" instead of "No SPF record found", stored with `spf_exists` NULL (never a confirmed 0), no grade-change alert from it (see below), and the public check does not cache it. Readers of `spf_exists` that treat it as a boolean (`/history` `protocols_passing`, the brand-threat correlator, the ops brand card) read NULL as not present.

Findings become recommendations on the scan result; there is no SPF alert type.

**Cost per caller.** The SPF branch adds at worst a 5 s root lookup + a 4 s walk (≤ 25 subrequests, in practice ≤ ~11) per scanned domain and runs in parallel with the DKIM probes. Cartographer Phase 3 (≤ 50 brands/run, budget-checked before each brand) adds ≤ ~1,300 subrequests against the 50,000 per-invocation limit (`wrangler.toml` `[limits]`); the orchestrator's first-scan pass (≤ 10 brands), the curator (≤ 100 brands in waves of 5, 25 s per-brand race), the admin scan-all (≤ 100) and the single-domain routes stay well inside it. The public scan keeps its 8 s wall-clock cap. The walk runs for every caller: making it opt-in or capping walks per run would grade the same DNS differently depending on which caller scanned it, which grade-change alerting would then report as a change.

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

**Rubric version.** `EMAIL_SCORE_RUBRIC_VERSION` (`src/email-security.ts`, currently 3; 1 = the pre-RFC 9989 rubric, stored as NULL; 2 = RFC 9989 DMARC; 3 = SPF include-tree walk) is stamped on every `email_security_scans` row as `score_rubric_version` (migration 0328). Grade-change detection compares two scans only when the previous scan was graded under the current version: the orchestrator's alert pass (`findEmailGradeChanges`, `lib/email-grade-change.ts`) requires `score_rubric_version = <current>` on the previous row, and Cartographer's band-crossing notification skips a previous scan with a different or NULL version (`isRubricOnlyGradeChange`). The first rescan after a rubric change therefore updates the stored grade silently instead of telling a customer their protection changed when their DNS did not. **Every future change to `calculateEmailSecurityScore` must bump the constant.**

**SPF uncertainty.** Two scans of unchanged DNS can grade differently when one SPF walk completed and the other ended `unknown` (an unreadable redirect target loses the policy credit; an include timeout can hide a >10 lookup count), or when the root lookup failed and SPF was not checked. Grade-change detection suppresses a pair ONLY when that uncertainty fully explains it (`isSpfUncertaintyOnlyGradeChange`, `lib/email-grade-change.ts`, used by both the orchestrator's `findEmailGradeChanges` and Cartographer):
1. Neither scan uncertain → never suppressed.
2. Both SPF checks ran → the root-record facts must be unchanged (`spf_exists`, the domain's own record text — which holds its `all` qualifier — and multiple records). Any root change is a real DNS change and always alerts (e.g. `v=spf1 include:<blackholed> +all`). The current scan is then re-scored with its walk-derived SPF part (lookup count / limit, loop, void lookups, tree findings, and the redirect-derived `all` when the record has none) held to the previous scan's.
3. One side not checked → the current scan is re-scored with the previous scan's whole SPF part.

It is suppressed only if that re-scored grade equals the previous grade, so a DMARC / DKIM / MX change that coincides with an SPF timeout still alerts. The rule needs the scorer, so it runs in JS: the SQL finds candidates (and returns the previous scan id), then two rows per candidate are read and compared.

### SPF (30 points max)

| Condition | Points |
|-----------|--------|
| Has SPF record | +10 |
| Hard fail (`-all`) | +15 |
| Soft fail (`~all`) | +10 |
| Neutral (`?all`) | +3 |
| Not over 10 DNS lookups | +5 |
| `+all` or a bare `all` (authorises every sender) | SPF scores 0 in total |
| Permerror: PROVEN more than 10 lookups across the include tree, a proven include loop, or more than one SPF record at the domain | only the +10 record credit (no policy points, no +5) |

Rubric 3. Scored permerrors are only the three above. Void lookups, `ptr`, syntax errors, include targets with no SPF record or with multiple SPF records, and `+all` inside an include are recommendations only (the void-lookup limit is a SHOULD in RFC 7208, a target's problem is the provider's to fix, and parser strictness should not move a grade). An unread include adds and removes nothing; a count that already exceeds 10 in the part that was read is proven and scored. An unreadable redirect target is the exception: the effective `all` is then unknown (null), which earns no policy credit, so it DOES lower the score (and grade-change alerting holds it to the previous scan, see above). A root lookup failure is carried forward or scored as not checked (see SPF Check).

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
- **SPF findings** (`spfFindingRecommendations`): over the lookup limit ("SPF needs N DNS lookups (limit 10)…", "at least N" when the walk stopped at the limit or was incomplete), void lookups over 2, multiple records, `+all`, `+all` in an included record, deprecated `ptr`, syntax error, include loop, include target with no SPF record / nonexistent (re-registration risk), include target with multiple records, "the SPF include tree could not be fully checked" for an unknown walk, "result shown is from the previous scan" for a carried root failure. A not-checked scan says "Could not check the SPF record" instead of "No SPF record found". Rows stored before migration 0332 carry only the boolean and keep the old "SPF record exceeds 10 DNS lookups." text.
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
- All SPF fields (exists, policy, includes count, too many lookups, raw record); since migration 0332 also `spf_lookup_count`, `spf_void_lookups`, `spf_walk_status` and `spf_findings` (JSON, codes and validated names only; `parseStoredSpfFindings` drops anything else on read). The brand report rebuilds its SPF recommendations from these columns.
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
   - `out_of_window` (checked first, no D1 read): the report's range END must lie within [now - 60 days, now + 2 days]; otherwise it is dropped, not moved to today (moving it would let a sender scatter or replay data).
   - `no_brand`: `brands.canonical_domain` equal to the policy domain or a parent.
   - `ineligible_brand`: the brand must be tier `monitored` or `customer` AND pass the platform's trusted-brand rule (`TRUSTED_BRAND_CANONICAL_SQL`, `lib/safeDomains.ts`: source not `public_assess` / `self_service` / `ai_attributed`, and tier `customer` or source `manual` / `curated` or Tranco rank <= 20000) AND not be, or sit under, a shared-hosting domain. Otherwise anyone could create a brand for a domain they control and publish our `rua`.
   - `unenrolled`: only the brand's CANONICAL domain's own `_dmarc` record counts (never a subdomain's) and it must name one of our addresses. Evidence, cheapest first: a `dmarc_enrollment` row verified within 30 days (`ENROLLMENT_REVERIFY_DAYS`), the latest posture scan (within 7 days, `verified_via='scan'`), or a live DoH lookup (`'live_dns'`, KV-cached 6h when positive, 30 min when negative). A resolver failure is not "no record": it is never cached, never refreshes `rua_verified_at`, and a lapsed enrollment is still honoured for that report; with no prior enrollment the report is dropped as `unenrolled`.
   - `rate_limited`: D1 counters in `dmarc_rate_counters` (migration 0329), one atomic batch, keyed on wall-clock UTC time (never the report's own dates) and split by provenance class so forged (unverified) mail cannot starve real reporters. Per brand per UTC day: 50 verified and 50 unverified (`DMARC_BRAND_DAILY_CAP`). All brands per UTC hour: 200 verified and 50 unverified (`DMARC_GLOBAL_HOURLY_CAP`); the global counter only advances while the brand is still within its cap. The attempt takes its slot before the dedup claim, so a duplicate resend also uses one. If the counter batch fails or returns no count the report is DENIED (fail closed).
   - Also counted: `duplicate`, `unparseable`, `error` (receiver threw). Full reason list: `no_brand`, `ineligible_brand`, `unenrolled`, `rate_limited`, `duplicate`, `unparseable`, `out_of_window`, `error`.
5. One atomic, retried batch: claim `(domain, reporter_org, report_id)` in `dmarc_report_seen` (a resent report changes nothing), upsert `dmarc_daily_stats` and insert `dmarc_reports` (`processed = 2`, `raw_xml` is no longer stored), both guarded on the claim. Per-source rows then go to `dmarc_report_records` (at most `MAX_STORED_RECORDS`: 1000 per verified report, 250 per unverified, failing first; `auth_json` keeps the evidence a later re-rollup needs).
6. `processed` finishes at 1 (complete) or 0 (records failed). A resend of a `processed = 0` report (or a stale `processed = 2` one, `processing_at` over 15 minutes old) with the same totals is not a duplicate: it deletes the partial records and completes the original row (stats are not re-counted).
7. Staff notification (verified reports only, so none while provenance is disabled) and the source rollup run after a complete report.

**Provenance** (`lib/dmarc-provenance.ts`). Aggregate reports are unauthenticated XML, so each stores `sender_domain`, `sender_auth` and `verified` on `dmarc_reports`. `verified = 1` only when ALL hold: the RFC 5322 From address is EXACTLY one of `KNOWN_RUA_REPORTERS` (a specific mailbox, currently `noreply-dmarc-support@google.com` and `dmarcreport@microsoft.com`, mapped to the domain it signs as; never a consumer mailbox domain); the TOPMOST plain `Authentication-Results` header has an authserv-id in `TRUSTED_AUTHSERV_IDS` (`ARC-Authentication-Results` is never trusted: an ARC set is sender-written until its seal is validated, which we do not do); and that header shows `dkim=pass` with `header.d`, or `dmarc=pass` with `header.from`, exactly equal to the reporter's signing domain.

**Disabled by default.** `TRUSTED_AUTHSERV_IDS` ships EMPTY, so every report is `verified = 0` until an operator confirms the live header on real mail and adds the id (enablement procedure: `docs/EMAIL_ROUTING_RUNBOOK.md`). While off: no failure notification at all, no ipinfo lookups on the email path, and the source rollup still runs from threats / clusters / providers / ASN-DROP evidence. The robust fix (verify the DKIM signature ourselves with WebCrypto) is not built.

**What `verified` gates.** Notification: a verified report with at least 100 messages and a fail rate over 10% raises one `email_security_change` notification, audience `team` (staff, never customers), severity `high`, text built only from the brand's canonical domain and computed numbers. ipinfo: only verified reports on the email path (so none while provenance is disabled), never reserved/private ranges, at most 50 per report and 150 per UTC wall-clock day across all DMARC rollups (`dmarc:geo_used:<date>` in KV). `dmarc_source_daily.verified_fail_messages` records how much failing volume came from verified reports.

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
(`processed` 0 or 1, `rolled_up_at` NULL, over 5 minutes old) is rolled up by
Navigator every tick (at most 3, from `dmarc_report_records`, no ipinfo). The catch-up first resets a `processed = 2` row whose `processing_at` is over 15 minutes old to 0 (dead worker), isolates each report in its own try/catch, and bumps `rollup_attempts` on every try; past 5 the report is stamped terminal (`rolled_up_at` set, `process_error` gains `rollup_abandoned`) and leaves the queue.
Read via `GET /api/dmarc-reports/:brandId/spoof-sources`;
onboarding state via `/setup` (see `docs/API_REFERENCE.md`).

**Limits of the signal.** RUA only shows mail using the brand's exact
header-from domain, from receivers that send reports; lookalike-domain mail
never appears.

**Retention** (`lib/dmarc-retention.ts`, EVERY Navigator tick, no hour gate; bounded batches, a backlog continues on the next tick): `dmarc_report_records` and `dmarc_reports` 180 days by `received_at`, `dmarc_source_daily` 180 days by report date, `dmarc_report_seen` 63 days (a report is accepted while its end date is within 60 days back / 2 forward, so the dedup key must outlive that), `dmarc_rate_counters` windows older than 2 days. `dmarc_daily_stats` and `dmarc_enrollment` are not swept.

**Geo for stored source IPs** (`lib/dmarc-record-geo.ts`, Cartographer Phase 4, 10 IPs per cycle): resolved IPs get country/org/ASN/lat/lng from ipinfo; private, bogon, CGNAT, documentation ranges and IPv6 are marked `PRIV`; a failed lookup is marked `XX` (the platform's unknown-country sentinel), so no IP pins the queue. An IP not attempted (budget spent) stays queued.

**Migration 0329** creates `dmarc_report_records` (a no-op in prod, which has it
out of band), `dmarc_report_seen`, `dmarc_source_daily`, `dmarc_enrollment`, `dmarc_rate_counters` and
the indexes, and ADDs columns: `dmarc_report_records.auth_json`;
`dmarc_reports.sender_domain`, `sender_auth`, `verified`, `claim_id`,
`rolled_up_at`, `processing_at`, `rollup_attempts`. It also creates `dmarc_rate_counters`. The ADD COLUMNs make it non-re-appliable.
