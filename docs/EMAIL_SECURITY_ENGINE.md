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
- `policy` — `none`, `quarantine`, or `reject`
- `pct` — Percentage of messages the policy applies to
- `rua` — Aggregate report URI (indicates reporting is configured)
- `ruf` — Forensic report URI

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

The composite score is out of 100 points, weighted as follows:

### DMARC (40 points max)

| Condition | Points |
|-----------|--------|
| Has DMARC record | +10 |
| Policy = `reject` | +20 |
| Policy = `quarantine` | +12 |
| Policy = `none` | +4 |
| Aggregate reporting (`rua`) configured | +5 |
| Reports sent to Averrow (`averrow.com` or legacy `trustradar.ca`) | +5 |

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

### MX (10 points max)

| Condition | Points |
|-----------|--------|
| Has MX records | +10 |

## Grading Scale

| Grade | Score Range |
|-------|------------|
| A+ | 90-100 |
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
