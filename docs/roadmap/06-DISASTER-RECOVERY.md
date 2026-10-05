# Disaster Recovery Architecture

> **Status: aspirational, NOT implemented** (verified 2026-10-05: no backup bucket binding, no `0 4 * * *` cron, no DR panel). For the current policy, plan and gap register see `docs/security/BCDR_POLICY.md`, `docs/security/BCDR_PLAN.md` and `docs/security/BCDR_GAPS.md`.

## Current Risk Assessment
| Component | Status | Risk |
|-----------|--------|------|
| Cloudflare Workers | Global, active-active | Low |
| D1 Database | Single primary ENAM, no replication | Medium |
| KV Namespaces | Globally replicated | Low |
| R2 Storage | Automatic redundancy | Low |

## D1 Read Replication
Enable: CF Dashboard → D1 → trust-radar-v2 → Read Replication
Currently: disabled (confirmed via API)
Benefit: reads route to nearest replica globally

## Backup Strategy
Schedule: 0 4 * * * (4 AM UTC, nightly)
Process:
  1. D1 Export API → SQL dump
  2. Upload to R2: averrow-backups/yyyy-mm-dd/trust-radar-v2.sql.gz
  3. Write manifest to KV: backup:latest
  4. Purge per retention policy

Retention: 30 daily · 12 weekly · 12 monthly

## RTO/RPO Targets
| Scenario | RTO | RPO |
|----------|-----|-----|
| Worker failure | <30s (CF automatic) | 0 |
| D1 read failure | <60s (replica failover) | 0 |
| D1 write failure | <4h (restore from backup) | <4h |

## Super Admin DR Panel (/v2/admin/disaster-recovery)
- Replication lag + replica health
- Backup history (last 30)
- [Download Latest Backup] → signed R2 URL
- [Manual Failover] → future
