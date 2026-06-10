> Archived 2026-06-10: point-in-time agent stats (2026-03-28); superseded by docs/AGENT_AUDIT.md; dark web monitor since built.

# AI Agent Assessment + Advancement Plan

## Current Performance Audit
| Agent | Success | Partial | Failed | Issue | Action |
|-------|---------|---------|--------|-------|--------|
| Sentinel | 729 | 0 | 0 | None | Expand CT sources |
| Analyst | 554 | 7 | 3 | 3 failures | Investigate |
| Cartographer | 43 | 56 | 0 | >50% partial | Fix partial |
| Observer | 80 | 0 | 0 | None | Add market feeds |
| Flight Control | 21 | 0 | 10 | Pre-fix | Monitor |
| NEXUS | 9 | 0 | 0 | None | Temporal clustering |
| Sparrow | 9 | 0 | 5 | Pre-fix | Verify post-fix |
| Strategist | 28 | 0 | 0 | None | Needs more data |
| Prospector | 0 | 18 | 11 | Broken | Full rebuild |
| Curator | New | — | — | — | Weekly hygiene |

## Cartographer Priority Investigation
56 partials on 99 runs — largest operational issue.
Likely: geo enrichment API timeouts or rate limits.
Fix: retry logic, timeout increase, batch size reduction.

## New Agents to Build

### Dark Web Monitor
Sources: Pastebin, Ghostbin, dark web forums (DarkOwl API)
Outputs: threat type 'dark_web_mention', brand alerts
Schedule: Every 6 hours
Value: Recorded Future charges $50K+/yr for this

### Takedown Success Tracker
Function: Monitor submitted takedowns for resolution
Method: DNS lookup + HTTP probe every 6 hours
Outputs: auto-update takedown status when target offline
Model: none (algorithmic)

### Customer Intelligence Agent
Function: Weekly brand protection report per tenant org
Schedule: Monday 8 AM
Model: claude-sonnet-4-20250514
Output: email/webhook branded report per org

### Email Threat Analyzer
Trigger: When Mimecast/Proofpoint feeds connected
Function: Classify inbound threats, extract IOCs
Model: claude-haiku-4-5

### Vulnerability Intelligence Agent
Sources: NVD, CISA KEV
Outputs: vulnerability alerts linked to brand records
Schedule: Daily
