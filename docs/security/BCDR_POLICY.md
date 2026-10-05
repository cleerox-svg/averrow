# Business Continuity & Disaster Recovery Policy

**Status: DRAFT — pending owner approval. Internal; not for customer distribution.**

| Field | Value |
|---|---|
| Document | Averrow Business Continuity & Disaster Recovery (BCDR) Policy |
| Version | 0.1 (draft) |
| Policy owner / BCDR lead | [Name] |
| Backup BCDR lead | [Name] |
| Approved by | [Name] — approval date: ______ |
| Last reviewed | ______ |
| Next review due | 12 months after approval, or sooner per section 11 |
| Companion documents | `docs/security/BCDR_PLAN.md` (operational plan), `docs/security/BCDR_GAPS.md` (gap register) |

This policy states what **must** be true. It does not describe current capability. Where current capability falls short of a requirement, the shortfall is recorded in `docs/security/BCDR_GAPS.md` and the honest current state is in `docs/security/BCDR_PLAN.md` section 2. Nothing in this policy should be read as a claim that a requirement is already met.

**Control mapping (informational).**

| Topic | SOC 2 (Trust Services Criteria) | ISO/IEC 27001:2022 |
|---|---|---|
| Incident recovery and response plans | CC7.4, CC7.5 | A.5.29 (information security during disruption) |
| Continuity / ICT readiness | CC9.1, A1.3 | A.5.30 (ICT readiness for business continuity) |
| Backup and restore | A1.2, A1.3 | A.8.13 (information backup) |
| Redundancy | A1.2 | A.8.14 (redundancy of information processing facilities) |

---

## 1. Purpose

To ensure Averrow can continue, or restore within defined limits, the delivery of its threat-intelligence and brand-protection service after a disruption (bad release, data corruption, loss of a data store, vendor or platform outage, credential compromise, or loss of key personnel), while preserving the confidentiality and integrity of customer and platform data during the disruption and recovery.

## 2. Scope

**In scope.** The Averrow platform: the `averrow-worker` Cloudflare Worker (API, ops SPA, tenant SPA, marketing site, scheduled jobs, Workflows, Durable Objects, inbound email handling), its data stores (D1 databases, KV namespace, R2 buckets), the CI/CD path that deploys it (GitHub Actions), the third-party services it depends on, the secrets and keys it uses, and the people and accounts needed to operate it.

**Shared infrastructure note.** The Cloudflare account that hosts Averrow also hosts other LRX Enterprises products. An account-level event (suspension, billing lapse, credential compromise, regional or control-plane outage) affects all of them. This policy covers Averrow's dependence on that account; the other products' continuity is outside its scope but their concurrent impact must be considered in any account-level scenario.

**Out of scope.** Customer-side systems, and third-party services' own continuity programmes (covered only through vendor review, section 9).

## 3. Roles and responsibilities

| Role | Holder | Responsibilities |
|---|---|---|
| Policy owner / BCDR lead | [Name] | Owns this policy and the plan; approves RTO/RPO; declares a disaster; accountable for tests and reviews. |
| Backup BCDR lead | [Name] | Holds equivalent access and authority when the lead is unavailable; must be able to execute every playbook. |
| Incident commander (per incident) | BCDR lead or backup | Runs the incident, assigns severity, owns the incident log. |
| Engineering / platform operator | [Name] | Executes technical recovery steps; maintains backups, runbooks, and deploy pipeline. |
| Communications owner | [Name] | Status page updates and customer notices. |
| Executive sponsor | [Name] | Approves exceptions and funds remediation. |

Rules:
- Every role must have a named primary and a named alternate. A role with no alternate is a gap and must be recorded in the gap register.
- The BCDR lead and backup must each hold the access needed to execute the plan (section 8) without relying on the other.

## 4. Service tiers

All components are assigned to a tier. Tier drives recovery objectives, backup frequency and test scope. The authoritative inventory is in `docs/security/BCDR_PLAN.md` section 1.

| Tier | Definition | Examples |
|---|---|---|
| 1a | Customer-facing service availability | Worker (API, SPAs, status page, auth) |
| 1b | System-of-record data that cannot be regenerated | Primary D1 (`trust-radar-v2`), audit D1 (`trust-radar-v2-audit`) |
| 1c | Customer-supplied assets with a single copy | R2 `TRADEMARK_ASSETS` |
| 2 | Operationally important, degraded service tolerable for a day | Scheduled ingest/enrichment, Workflows, email delivery, KV state, R2 `NRD_ARCHIVE` |
| 3 | Rebuildable or best-effort | `geoip-db`, `trust-radar-dns-queue`, R2 `GEOIP_STAGING`, caches |

## 5. Recovery objectives

**Approved by owner 2026-10-05.** (The rest of this policy remains DRAFT pending review.) These objectives are to be revised after the first restore drill measures actual performance, and are internal targets, not commitments to customers.

**Honesty caveat: not currently achievable in full.** The Tier 1b RPO of 24 hours or less (off-platform backup basis) is not achievable until gap G1 is remediated (independent off-platform backup of the primary and audit databases), and the Tier 1c `TRADEMARK_ASSETS` 24h/24h target is not achievable until gap G8 is remediated (a second copy of the bucket). Until then only platform point-in-time recovery exists, untested. See `docs/security/BCDR_GAPS.md`.

| Tier / asset | RTO (time to restore) | RPO (maximum data loss) |
|---|---|---|
| 1a Service availability | 4 hours (bad deploy: 30 minutes via rollback, once rollback has been exercised) | n/a (stateless) |
| 1b System-of-record data | 24 hours | Within the platform point-in-time-recovery window: 5 minutes or less. Once an independent off-platform backup exists: 24 hours or less. |
| 1c `TRADEMARK_ASSETS` | 24 hours | 24 hours |
| 2 Operations (ingest, Workflows, email) | 24 hours | About 1 hour of ingest loss acceptable (feeds re-pull) |
| 2 `NRD_ARCHIVE` | 72 hours | 24 hours |
| 2 KV state | 24 hours | Best effort; revocation state (see section 6.5) must be reconstructable or conservatively reset |
| 3 Rebuildable | 72 hours to 7 days | Not applicable (rebuilt from source) |

An RTO or RPO that has never been demonstrated by a test must be labelled "unverified" in any report to management or auditors.

## 6. Backup and retention standards

6.1 **Primary and audit databases (Tier 1b)** must have, at a minimum: (a) platform point-in-time recovery enabled and its retention window documented; and (b) an independent, automated, periodic export stored outside the primary database's own recovery mechanism, in a separate bucket, with at least one additional copy held outside the Cloudflare account (to survive account-level loss). Export frequency must be sufficient to meet the Tier 1b RPO.

6.2 **R2 buckets holding sole copies (Tier 1c and `NRD_ARCHIVE`)** must have a second copy (versioning, replication, or periodic copy to a separate location) and must not be the only copy of the data.

6.3 **Rebuildable stores (Tier 3)** need not be backed up, provided the rebuild procedure is documented and tested at least once.

6.4 **Retention.** Backup retention periods must be defined, documented, and consistent with the data retention and deletion commitments in customer-facing documents (privacy notice, DPA). Backups must fall within a stated deletion horizon for deleted customer data. Until this is documented, no public statement may describe backup frequency or retention beyond what is verifiably implemented.

6.5 **KV state.** Security-relevant KV state (for example, session revocation markers) must either be reconstructable from a system of record or have a documented safe-default reset procedure that errs toward revoking access.

6.6 **Protection of backups.** Backups must be encrypted at rest, access-restricted to named roles, and access to them logged. Backup contents are customer and platform data and carry the same confidentiality obligations as production.

6.7 **Integrity.** Backups must be verified (completeness and restorability) at the frequency in section 10, not merely created.

## 7. Change, deploy and migration policy

7.1 Production changes must be deployed through the documented automated pipeline from the protected main branch. Manual deploys of any component must be documented, performed by an authorised person, and recorded.

7.2 **Migrations are roll-forward.** Database migrations must be additive and non-destructive by default (new tables, `ADD COLUMN`). Destructive changes (drop, rebuild, rewrite of existing data) require explicit owner approval and a recorded recovery point beforehand.

7.3 Before any migration is applied to a production database, a recovery point (point-in-time bookmark or export) must be captured and recorded with the change. Where the pipeline cannot do this automatically, the operator must do it manually.

7.4 Migration identifiers must be unique and ordered within the single authoritative migration directory per database. Stray or duplicate migration files must be resolved.

7.5 A previous Worker version must be restorable by rollback, and rollback must be exercised at least annually (section 10).

7.6 A deploy must be gated by automated checks appropriate to every component it ships.

## 8. Secrets and key escrow

8.1 Every secret and key required to operate or recover the platform must be inventoried by name (never by value) with its owner, location, and rotation procedure.

8.2 Keys whose loss makes data unrecoverable (for example, the key that encrypts stored integration configuration) must be escrowed: at least two independent, access-controlled copies held by different authorised people, outside the Cloudflare account, with escrow location and custodians recorded.

8.3 Account-recovery paths for the cloud provider, source repository, domain registrar, DNS, email provider and payment provider must be documented, tested, and held by at least two authorised people. No single individual may be the sole holder of recovery access to any Tier 1 dependency.

8.4 Recipients of critical alerts and escalations must include at least two people.

8.5 Secrets must never be written to documentation, tickets, logs or chat. Suspected compromise triggers rotation and the secret-compromise playbook.

8.6 The platform must retain at least two active holders of its highest administrative role.

## 9. Vendor and platform continuity

9.1 A vendor register must list each third-party service the platform depends on, its tier, the data it holds or processes, its contractual recovery commitments (SLA, backup, breach-notification), the platform's fallback if it is unavailable, and the date of last review.

9.2 For each Tier 1 or Tier 2 vendor, a documented degraded-mode or fallback behaviour must exist, or the absence must be accepted by the owner and recorded as an exception.

9.3 Concentration risk (a single vendor or account carrying multiple Tier 1 functions) must be assessed annually and any accepted risk recorded.

9.4 External monitoring: availability of the public service must be monitored from outside the platform being monitored, so that a platform-wide failure is detected independently of platform-internal alerting.

## 10. Testing requirements

| Test | Minimum frequency | Pass criteria | Evidence |
|---|---|---|---|
| Restore drill: restore Tier 1b data (primary and audit) from the independent backup into a non-production database; verify integrity and record elapsed time | Annually, and after any change to the backup mechanism | Restored data validated; elapsed time measured against RTO; RPO measured against backup age | Completed DR test log (Plan appendix A) |
| Point-in-time restore drill (platform feature) into a non-production target | Annually | As above | DR test log |
| Rollback drill: roll the Worker back to a prior version and forward again | Annually | Service healthy after each step; elapsed time recorded | DR test log |
| R2 sole-copy restore: recover a sample of objects from the second copy | Annually | Sample matches originals | DR test log |
| Tabletop exercise of one scenario from the plan (rotating) including key-person unavailability | Annually | Gaps and actions recorded | DR test log |
| Backup completeness check (automated job succeeded; size and age sane) | Continuous, with alert on failure | Alert fires on missed or failed backup | Monitoring record |

Test results must be logged using the template in the plan, with deviations and remediation actions tracked to closure. A test that fails or is not performed is an open gap, not a pass.

## 11. Review and maintenance

- The policy, plan and gap register must be reviewed at least annually and after: any Severity 1 or 2 incident, any restore actually performed, a material architecture change (new data store, new Tier 1 vendor, change of cloud provider or account structure), and a change of BCDR lead.
- Each review is recorded in the document control table with date and reviewer.
- After every Severity 1 or 2 incident a post-incident review must be completed within 10 business days (template in the plan), with actions entered in the gap register.

## 12. Exceptions

Any deviation from this policy must be requested in writing, state the risk and compensating controls, be approved by the executive sponsor, carry an expiry date (maximum 12 months), and be recorded in the gap register. Expired exceptions revert to open gaps.

## 13. Document control

| Version | Date | Author | Change | Approved by | Approval date |
|---|---|---|---|---|---|
| 0.1 | 2026-10-05 | [Name] | Initial draft | | |
