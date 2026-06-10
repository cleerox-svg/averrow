> Archived 2026-06-10: roadmap item shipped — spam-trap war room live (averrow-ops features/spam-trap).

# Spam Trap — Super Admin War Room

## Concept
Super admin only — not a customer feature.
SOC war room aesthetic: honeypot network, capture forensics,
threat actor profiling, campaign intelligence.

## Current State (as of Mar 28 2026)
- 64 seed addresses (lrxradar.com + averrow.com domains)
- 1 active seed campaign
- 2 captures:
  1. Monte Carlo Data (Amazon SES) — phishing, SPF: none
  2. Google Workspace billing (Google bounce) — phishing, SPF: none
- Full forensic schema: SPF/DKIM/DMARC, sending IP, URLs, attachments

## Four-Panel Layout

### Panel 1 — Honeypot Network
- 64 seed addresses in a grid/table
- Columns: address, domain, channel, brand_target, seeded_at, catches, status
- Color: green=active, amber=has catches, gray=inactive
- Stats strip: 64 seeds · 2 captures · 3.1% catch rate

### Panel 2 — Capture Forensics
- Each capture as a detailed evidence card
- Full header forensics: SPF/DKIM/DMARC, sending IP, X-Mailer, URLs
- AI analysis button: run Haiku to classify threat actor
- Monte Carlo: Amazon SES sender, SPF none — suspicious
- Google billing: Google bounce, SPF none — suspicious

### Panel 3 — Campaign Intelligence
- Seed Strategist agent recommendations surface here
- Campaign config: where addresses seeded, pace, targets
- Approve/reject seeding recommendations

### Panel 4 — Threat Actor Profiling
- Cluster captures by: sender IP range, email template, infrastructure
- Each cluster = potential threat actor profile
- Link to NEXUS clusters where IP overlaps

## Build Notes
- Build all 4 panels now — thin data panels show gracefully
- Data grows automatically as captures accumulate
- Long-term value: threat actor profiles from honeypot data
