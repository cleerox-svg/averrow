-- ─── Sanitized public copy for incident updates ──────────────────
--
-- The original incident_updates schema (migration 0132) had a single
-- `message` field plus a visibility flag. That conflated two
-- concerns: the operator's internal narration AND what shows on
-- the public /status page. The first backfill pass leaked internal
-- terminology (commit hashes, feed names, format details) onto the
-- customer-facing timeline.
--
-- This migration adds a separate `public_message` column. The
-- internal `message` stays as-is — operators can write whatever
-- detail they want. To surface anything publicly, the operator must
-- ALSO write a sanitized `public_message`. The public read path
-- (toPublicShape) requires BOTH visibility='public' AND
-- public_message NOT NULL — defense in depth so a stale visibility
-- flag can't leak the internal text.
--
-- Sanitization bar (per operator):
--   OK   — "Several threat ingest feeds were not receiving updates
--           for an extended period. Detection of new threats was
--           delayed during this window. Existing threat data,
--           alerting, and monitoring were unaffected."
--   NOT OK — "The Feodo C2 IP feed changed format upstream. Our
--            parser was updated to consume the new JSON shape and
--            ingestion resumed."
--
-- Rule of thumb: speak about generic systems ("threat ingest
-- pipeline", "monitoring component"), never about specific feeds,
-- formats, code paths, or commits.

ALTER TABLE incident_updates
  ADD COLUMN public_message TEXT
    CHECK (public_message IS NULL OR length(public_message) <= 1000);

-- ─── Rewrite incident-level public titles/details ─────────────────

UPDATE incidents
   SET public_title = 'Threat ingest pipeline degraded',
       public_details = 'Several threat ingest feeds were not receiving updates for an extended period. Detection of new threats was delayed during this window. Existing threat data, alerting, and monitoring were unaffected. Pipeline fully restored after the underlying parser issue was patched.'
 WHERE id = 'incident_apr29_ingest_blackout';

UPDATE incidents
   SET public_title = 'Monitoring component briefly paused',
       public_details = 'A monitoring component for new domain detection was briefly paused following an upstream service interruption. Service has been fully restored.'
 WHERE id = 'incident_apr27_ct_logs_paused';

UPDATE incidents
   SET public_title = 'Threat data source format change',
       public_details = 'A third-party threat data source updated its format. Our pipeline was adapted to the change and ingestion has resumed normally. Coverage from other sources was unaffected during the gap.'
 WHERE id = 'incident_may2_feodo_json_format';

UPDATE incidents
   SET public_title = 'Third-party data source retired',
       public_details = 'A third-party data source we previously consumed was retired by its publisher. We disabled the integration. Coverage from our other sources is unchanged.'
 WHERE id = 'incident_may3_c2_tracker_retired';

-- ─── Rewrite per-update public_message ───────────────────────────
-- Each timeline row gets a sanitized version. Status alone communicates
-- most of the lifecycle progression — the public_message just adds a
-- short generic note appropriate to the stage.

-- apr29 ingest blackout
UPDATE incident_updates
   SET public_message = 'Investigating an issue affecting the threat ingest pipeline. Detection of new threats may be delayed.'
 WHERE id = 'upd_apr29_blackout_1';
UPDATE incident_updates
   SET public_message = 'Root cause identified. Mitigation is in progress.'
 WHERE id = 'upd_apr29_blackout_2';
UPDATE incident_updates
   SET public_message = 'Mitigation deployed. Pipeline has resumed normal operation; monitoring for stability.'
 WHERE id = 'upd_apr29_blackout_3';
UPDATE incident_updates
   SET public_message = 'Resolved. Pipeline is healthy and additional monitoring has been added to detect this class of issue earlier.'
 WHERE id = 'upd_apr29_blackout_4';

-- apr27 ct_logs paused
UPDATE incident_updates
   SET public_message = 'Investigating an issue affecting a monitoring component.'
 WHERE id = 'upd_apr27_ctlogs_1';
UPDATE incident_updates
   SET public_message = 'Upstream service has recovered. Component re-enabled and an automatic recovery path has been added.'
 WHERE id = 'upd_apr27_ctlogs_2';
UPDATE incident_updates
   SET public_message = 'Resolved. Component is operating normally.'
 WHERE id = 'upd_apr27_ctlogs_3';

-- may2 feodo (data source format change)
UPDATE incident_updates
   SET public_message = 'Investigating an issue with a third-party threat data source.'
 WHERE id = 'upd_may2_feodo_1';
UPDATE incident_updates
   SET public_message = 'Pipeline updated to handle the upstream change. Monitoring ingestion.'
 WHERE id = 'upd_may2_feodo_2';
UPDATE incident_updates
   SET public_message = 'Resolved. Ingestion from the source is back to normal cadence.'
 WHERE id = 'upd_may2_feodo_3';

-- may3 c2_tracker retired
UPDATE incident_updates
   SET public_message = 'Investigating an issue with a third-party data source.'
 WHERE id = 'upd_may3_c2_1';
UPDATE incident_updates
   SET public_message = 'Resolved. The third-party source was retired by its publisher; coverage continues from our other sources.'
 WHERE id = 'upd_may3_c2_2';
