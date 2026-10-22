-- 0309 — revoke OTX-inherited attributions that fail the 2026-10 policy.
--
-- Owner decision 2026-10-22: "Delete and clear the actor. I want real
-- numbers not inflated."
--
-- The Attributor's OTX actor inheritance (lib/cluster-attribution-inherit.ts)
-- wrote threat_attributions rows (source='nexus', id prefix
-- 'tat_otxinherit_', metadata.inherited = 1) and stamped
-- infrastructure_clusters.actor_id under the old single-member rule. Every
-- one of those rows predates the strict policy shipped in PR #1860 and fails
-- it. They inflate actor counts (Threat Actors, tenant actor module,
-- Observatory events/lenses, operations) and hide clusters from the
-- Attribution Backlog (actor_id IS NULL). Verified on prod 2026-10-22:
-- 11,047 rows, 95 clusters (17 live, 78 retired) whose only actor stamp came
-- from inheritance.
--
-- Identification:
--   rows     — source = 'nexus' AND id >= 'tat_otxinherit_'
--              AND id < 'tat_otxinherit`' AND metadata.inherited = 1
--              ('`' is the character after '_', so the id range is exactly
--              the prefix and is a PK range seek). The 194 May-2026
--              source='nexus' rows are outside the prefix and untouched.
--   clusters — actor_id set, an inherited row for that cluster
--              (source_pulse_id = cluster id) names the SAME actor, and no
--              source='manual' row exists for the cluster. Inheritance only
--              ever stamped actor_id (never attribution_attempted_at or any
--              other column — that stamp is the attributor's per-run
--              cooldown and stays), so only actor_id is backed up and
--              cleared.
--
-- Order matters: back up -> clear cluster stamps -> delete rows. The cluster
-- predicate reads the inherited rows, so it must run before the DELETE.
--
-- Additive only: three new tables. No existing column is dropped or
-- altered; infrastructure_clusters.status (prod CHECK) is never touched.
--
-- audit_log lives in the separate AUDIT_DB (migrations-audit/), which a
-- main-DB migration cannot write. The audit record for this revocation is
-- the summary row in attribution_revocation_runs (actor
-- 'system:migration_0309', counts taken from the backup tables).
--
-- Idempotent: CREATE IF NOT EXISTS, INSERT OR IGNORE on primary keys, and
-- every UPDATE/DELETE is gated on inherited rows still being present, so a
-- second application (or a CI retry after a partial apply) changes nothing.
-- On a fresh DB every statement matches zero rows and the summary row
-- records zero counts.
--
-- ── Restore recipe (run by hand against trust-radar-v2) ─────────────
--
--   INSERT OR IGNORE INTO threat_attributions
--     (id, threat_id, actor_id, source, source_pulse_id, source_pulse_name,
--      actor_name_raw, confidence, observed_at, metadata)
--   SELECT r.id, r.threat_id, r.actor_id, r.source, r.source_pulse_id,
--          r.source_pulse_name, r.actor_name_raw, r.confidence,
--          r.observed_at, r.metadata
--     FROM threat_attributions_revoked r
--    WHERE r.revoke_reason = 'otx_inheritance_policy_2026-10'
--      AND EXISTS (SELECT 1 FROM threats t WHERE t.id = r.threat_id);
--
--   UPDATE infrastructure_clusters
--      SET actor_id = (SELECT c.actor_id FROM cluster_actor_revocations c
--                       WHERE c.cluster_id = infrastructure_clusters.id)
--    WHERE actor_id IS NULL
--      AND id IN (SELECT cluster_id FROM cluster_actor_revocations
--                  WHERE revoke_reason = 'otx_inheritance_policy_2026-10');
--
-- (The threats EXISTS guard skips rows whose threat retention has since
-- removed — threat_attributions.threat_id is an enforced FK. The
-- actor_id IS NULL guard never overwrites a cluster attributed since.)

CREATE TABLE IF NOT EXISTS threat_attributions_revoked (
  id                 TEXT PRIMARY KEY,
  threat_id          TEXT NOT NULL,
  actor_id           TEXT,
  source             TEXT NOT NULL,
  source_pulse_id    TEXT,
  source_pulse_name  TEXT,
  actor_name_raw     TEXT,
  confidence         TEXT NOT NULL,
  observed_at        TEXT NOT NULL,
  metadata           TEXT,
  revoked_at         TEXT NOT NULL DEFAULT (datetime('now')),
  revoke_reason      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threat_attributions_revoked_reason
  ON threat_attributions_revoked(revoke_reason);

CREATE TABLE IF NOT EXISTS cluster_actor_revocations (
  cluster_id     TEXT PRIMARY KEY,
  actor_id       TEXT,
  revoked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  revoke_reason  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attribution_revocation_runs (
  revoke_reason          TEXT PRIMARY KEY,
  actor                  TEXT NOT NULL,
  revoked_at             TEXT NOT NULL DEFAULT (datetime('now')),
  attributions_revoked   INTEGER NOT NULL,
  clusters_cleared       INTEGER NOT NULL,
  live_clusters_cleared  INTEGER NOT NULL,
  details                TEXT
);

-- 1a. Back up the cluster stamps (needs the inherited rows — run first).
INSERT OR IGNORE INTO cluster_actor_revocations (cluster_id, actor_id, revoked_at, revoke_reason)
SELECT ic.id, ic.actor_id, datetime('now'), 'otx_inheritance_policy_2026-10'
  FROM infrastructure_clusters ic
 WHERE ic.actor_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM threat_attributions x
      WHERE x.source_pulse_id = ic.id
        AND x.actor_id = ic.actor_id
        AND x.id >= 'tat_otxinherit_' AND x.id < 'tat_otxinherit`'
   )
   AND NOT EXISTS (
     SELECT 1 FROM threat_attributions m
      WHERE m.source_pulse_id = ic.id
        AND m.source = 'manual'
   );

-- 1b. Back up the inherited attribution rows.
INSERT OR IGNORE INTO threat_attributions_revoked
  (id, threat_id, actor_id, source, source_pulse_id, source_pulse_name,
   actor_name_raw, confidence, observed_at, metadata, revoked_at, revoke_reason)
SELECT ta.id, ta.threat_id, ta.actor_id, ta.source, ta.source_pulse_id,
       ta.source_pulse_name, ta.actor_name_raw, ta.confidence, ta.observed_at,
       ta.metadata, datetime('now'), 'otx_inheritance_policy_2026-10'
  FROM threat_attributions ta
 WHERE ta.source = 'nexus'
   AND ta.id >= 'tat_otxinherit_' AND ta.id < 'tat_otxinherit`'
   AND json_extract(ta.metadata, '$.inherited') = 1;

-- 2. Clear the cluster stamps — only where the cluster still carries the
--    backed-up actor AND a backed-up inherited row for it is still present
--    (so a re-run, after step 3 removed them, matches nothing).
UPDATE infrastructure_clusters
   SET actor_id = NULL
 WHERE id IN (
         SELECT cluster_id FROM cluster_actor_revocations
          WHERE revoke_reason = 'otx_inheritance_policy_2026-10'
       )
   AND actor_id = (
         SELECT c.actor_id FROM cluster_actor_revocations c
          WHERE c.cluster_id = infrastructure_clusters.id
       )
   AND EXISTS (
         SELECT 1 FROM threat_attributions x
          WHERE x.source_pulse_id = infrastructure_clusters.id
            AND x.id >= 'tat_otxinherit_' AND x.id < 'tat_otxinherit`'
            AND x.id IN (
                  SELECT r.id FROM threat_attributions_revoked r
                   WHERE r.revoke_reason = 'otx_inheritance_policy_2026-10'
                )
       );

-- 3. Delete the inherited rows (backed-up ids only, re-checked against the
--    identification predicate).
DELETE FROM threat_attributions
 WHERE id IN (
         SELECT r.id FROM threat_attributions_revoked r
          WHERE r.revoke_reason = 'otx_inheritance_policy_2026-10'
       )
   AND source = 'nexus'
   AND id >= 'tat_otxinherit_' AND id < 'tat_otxinherit`';

-- 4. Audit summary (one row per revoke_reason; OR IGNORE keeps the first).
INSERT OR IGNORE INTO attribution_revocation_runs
  (revoke_reason, actor, revoked_at, attributions_revoked, clusters_cleared,
   live_clusters_cleared, details)
SELECT 'otx_inheritance_policy_2026-10',
       'system:migration_0309',
       datetime('now'),
       (SELECT COUNT(*) FROM threat_attributions_revoked
         WHERE revoke_reason = 'otx_inheritance_policy_2026-10'),
       (SELECT COUNT(*) FROM cluster_actor_revocations
         WHERE revoke_reason = 'otx_inheritance_policy_2026-10'),
       (SELECT COUNT(*) FROM cluster_actor_revocations c
          JOIN infrastructure_clusters ic ON ic.id = c.cluster_id
         WHERE c.revoke_reason = 'otx_inheritance_policy_2026-10'
           AND ic.retired_reason IS NULL),
       json_object(
         'migration', '0309_revoke_otx_inherited_attributions',
         'owner_decision', '2026-10-22',
         'policy', 'lib/cluster-attribution-inherit.ts decideInheritedActor (PR #1860)',
         'backup_tables', json_array('threat_attributions_revoked', 'cluster_actor_revocations')
       );
