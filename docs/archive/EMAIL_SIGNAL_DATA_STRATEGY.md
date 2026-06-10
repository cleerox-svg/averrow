> Archived 2026-06-10: executed — email security posture engine + DMARC receiver shipped; see docs/EMAIL_SECURITY_ENGINE.md.

# EMAIL SIGNAL DATA STRATEGY — Trust Radar

## The Goal
Get raw DMARC/SPF/DKIM failure data flowing into Trust Radar so we can show brands WHO is spoofing them and WHEN. This is the data Proofpoint/Mimecast won't sell — we build our own collection infrastructure.

---

## THREE DATA COLLECTION PATHS

### PATH 1: DNS Posture Scanning ← BUILD NOW (Phase 1)
**What**: Query DMARC/SPF/DKIM/MX records for all monitored brands
**Data you get**: Configuration posture — whether protections exist, policy strength
**What you DON'T get**: Actual failure/pass data, spoofing attempts
**Cost**: $0 (Cloudflare DoH)
**Status**: Claude Code prompt written (`EMAIL_SECURITY_POSTURE_BUILD.md`)

---

### PATH 2: DMARC Report Receiver ← BUILD NEXT (Phase 2)
**What**: Trust Radar becomes a DMARC aggregate report receiver
**Data you get**: THE GOLD MINE — every IP that sent email claiming to be a brand, whether it passed/failed SPF/DKIM, volume, source org
**How it works**:

1. Set up email receiving on trustradar.ca via Cloudflare Email Routing
2. Create a dedicated address: `dmarc_rua@trustradar.ca`
3. Brand adds `rua=mailto:dmarc_rua@trustradar.ca` to their DMARC DNS record
4. Every major email provider (Google, Microsoft, Yahoo, Apple) sends daily XML reports to that address
5. Our Worker receives the email, extracts the XML attachment, parses it, stores in D1
6. Dashboard shows: "Yesterday, 47 unique IPs sent 3,200 emails claiming to be apple.com. 2,800 passed SPF/DKIM. 400 FAILED — here are the source IPs, their geolocations, and ASNs."

**DMARC Aggregate Report XML contains**:
```xml
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>         <!-- Who sent the report -->
    <date_range><begin>1710547200</begin></date_range>
  </report_metadata>
  <record>
    <row>
      <source_ip>185.234.xx.xx</source_ip>  <!-- WHO sent mail as your domain -->
      <count>142</count>                      <!-- How many emails -->
      <policy_evaluated>
        <disposition>reject</disposition>     <!-- What happened to the emails -->
        <dkim>fail</dkim>                     <!-- DKIM result -->
        <spf>fail</spf>                       <!-- SPF result -->
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>apple.com</header_from>   <!-- The domain being spoofed -->
    </identifiers>
    <auth_results>
      <spf>
        <domain>evil-phisher.com</domain>    <!-- Actual sending domain -->
        <result>fail</result>
      </spf>
    </auth_results>
  </record>
</feedback>
```

**This is EXACTLY the data you want.** Source IPs of spoofers, fail counts, which email providers are seeing the spoofing, and the actual sending domains.

**Implementation plan**:
1. Enable Cloudflare Email Routing on trustradar.ca
2. Create Email Worker that receives DMARC reports
3. Parse XML (gzip/zip compressed) → extract records
4. Store in new `dmarc_reports` and `dmarc_report_records` tables
5. Geo-enrich source IPs (already have the enrichment pipeline)
6. Create "Email Intelligence" dashboard tab showing:
   - Spoofing attempts over time
   - Top spoofing source IPs/ASNs
   - Source geography heatmap
   - Which email providers are reporting
   - Pass/fail rates trending

**Onboarding flow**: On the brand detail page's Email Security card:
> "Want to see who's sending emails as your domain? Add this to your DMARC record:
> `rua=mailto:dmarc_rua@trustradar.ca`
> We'll start showing spoofing data within 24-48 hours."

**Cost**: $0 — Cloudflare Email Routing is free (25 routes), Email Workers included
**Dependency**: trustradar.ca domain (already purchased and on Cloudflare)

---

### PATH 3: Spam Trap Network ← BUILD PHASE 3
**What**: Operate honeypot email addresses that receive live phishing emails
**Data you get**: Real phishing emails in the wild — headers, Authentication-Results, URLs, payloads
**How it works**:

1. Create catch-all on trustradar.ca: `*@trustradar.ca` → Email Worker
2. Seed addresses across the internet:
   - Register on known data-leaking sites
   - Post on forums, paste sites, public directories
   - Create "contact@", "info@", "admin@", "billing@" variants for brand-like subdomains
   - Use Cloudflare Workers to serve pages with hidden email addresses (spider traps)
3. When spam/phishing arrives, the Email Worker:
   - Extracts `Authentication-Results` header (contains SPF/DKIM/DMARC pass/fail)
   - Extracts `From`, `Reply-To`, `Return-Path` (spoofed identities)
   - Extracts URLs from body (phishing links → cross-reference with URLhaus/PhishTank data)
   - Extracts attachments (malware → hash and check against MalwareBazaar)
   - Stores everything in `spam_trap_captures` table
   - Auto-creates threat records for domains being impersonated
   - If a captured phishing email targets a monitored brand → alert + notification

**Authentication-Results header example**:
```
Authentication-Results: mx.google.com;
  dkim=fail header.i=@apple.com header.s=default;
  spf=fail (google.com: domain of noreply@apple.com does not designate 185.234.xx.xx as permitted sender);
  dmarc=fail (p=QUARANTINE sp=QUARANTINE dis=QUARANTINE) header.from=apple.com
```

This single header tells you:
- apple.com is being spoofed
- DKIM failed (no valid signature)
- SPF failed (sending IP not authorized)
- DMARC failed (disposition: quarantine)
- The sending IP: 185.234.xx.xx

**Seeding strategy**:
- Phase 3a: Create generic traps (admin@, info@, support@ at trustradar.ca)
- Phase 3b: Create brand-specific traps (apple-support@trustradar.ca, etc.)
- Phase 3c: Seed addresses on paste sites and breach lists
- Phase 3d: Create web spider traps (hidden email addresses on public pages that only bots find)

**Volume expectation**: Start slow (maybe 10-50 emails/day), grow to hundreds as addresses propagate. Could take 2-4 weeks for traps to start getting traffic.

**Cost**: $0 — Cloudflare Email Routing + Email Workers

---

## DATABASE SCHEMA FOR PATHS 2 & 3

```sql
-- DMARC aggregate reports (Path 2)
CREATE TABLE dmarc_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER,
  domain TEXT NOT NULL,
  reporter_org TEXT,           -- google.com, microsoft.com, yahoo.com
  report_id TEXT,              -- unique report ID from XML
  date_begin TEXT,
  date_end TEXT,
  total_records INTEGER DEFAULT 0,
  total_pass INTEGER DEFAULT 0,
  total_fail INTEGER DEFAULT 0,
  raw_xml TEXT,                -- compressed original
  received_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (brand_id) REFERENCES brands(id)
);

CREATE TABLE dmarc_report_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  source_ip TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  disposition TEXT,            -- none/quarantine/reject
  dkim_result TEXT,            -- pass/fail
  spf_result TEXT,             -- pass/fail
  header_from TEXT,            -- domain being spoofed
  spf_domain TEXT,             -- actual sending domain
  dkim_domain TEXT,
  -- Geo (enriched later)
  country_code TEXT,
  city TEXT,
  lat REAL,
  lng REAL,
  asn TEXT,
  org TEXT,
  FOREIGN KEY (report_id) REFERENCES dmarc_reports(id)
);

-- Spam trap captures (Path 3)
CREATE TABLE spam_trap_captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trap_address TEXT NOT NULL,      -- which trap caught it
  from_address TEXT,
  from_domain TEXT,
  reply_to TEXT,
  return_path TEXT,
  subject TEXT,
  -- Authentication results
  spf_result TEXT,                 -- pass/fail/none
  dkim_result TEXT,
  dmarc_result TEXT,
  dmarc_disposition TEXT,
  sending_ip TEXT,
  -- Extracted IOCs
  urls_found TEXT,                 -- JSON array of URLs in body
  attachments TEXT,                -- JSON array: [{filename, hash, size}]
  -- Brand matching
  spoofed_brand_id INTEGER,        -- matched brand being impersonated
  spoofed_domain TEXT,
  -- Classification
  category TEXT,                   -- phishing/spam/malware/scam
  confidence INTEGER DEFAULT 50,
  -- Metadata
  raw_headers TEXT,
  captured_at TEXT DEFAULT (datetime('now')),
  threat_id INTEGER,               -- linked threat record if created
  FOREIGN KEY (spoofed_brand_id) REFERENCES brands(id)
);
```

---

## TIMELINE

| Phase | Feature | Effort | Dependencies |
|-------|---------|--------|-------------|
| 1 | DNS Posture Scanning | 1 session | None — Claude Code prompt ready |
| 2 | DMARC Report Receiver | 1-2 sessions | Cloudflare Email Routing on trustradar.ca |
| 3a | Basic Spam Traps | 1 session | Phase 2 (shared email infrastructure) |
| 3b | Brand-specific Traps | Ongoing | Phase 3a |
| 3c | Trap Seeding | Ongoing | Phase 3a |

---

## COMPETITIVE POSITIONING

**What Proofpoint/Mimecast have**: Data from millions of corporate mailboxes they protect. You can't compete with their volume.

**What Trust Radar has that they DON'T**:
1. **Outside-in perspective** — We see the attack surface from the internet's point of view, not from inside the castle
2. **Cross-brand correlation** — We monitor 519+ brands simultaneously. If one IP spoofs Apple AND Google AND Amazon, we see the campaign. Proofpoint only sees their own customers.
3. **Public threat intelligence** — 17 free feeds correlating with email signals. Proofpoint keeps their intel walled.
4. **DMARC-as-a-service for brands that CAN'T afford Proofpoint** — $65K+/year vs Trust Radar's monitoring
5. **Spam trap data is YOUR proprietary source** — nobody else has your exact trap network

**The pitch to brands**:
> "Proofpoint can tell you what landed in YOUR inbox.
> Trust Radar tells you what's happening to YOUR BRAND across the entire internet —
> who's phishing your customers, who's spoofing your email, and where the attacks come from."

---

## NEXT STEPS

1. ✅ Send `EMAIL_SECURITY_POSTURE_BUILD.md` to Claude Code (Phase 1)
2. After deploy: Enable Cloudflare Email Routing on trustradar.ca
3. Build DMARC report receiver Email Worker (Phase 2)
4. Build spam trap infrastructure (Phase 3)
5. Add "Email Intelligence" tab to analyst dashboard
