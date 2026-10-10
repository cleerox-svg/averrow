-- Migration 0289: index the threat → takedown link
-- (GET /api/intel/identity-threats/detections/:threatId, IdP drill-down).
--
-- Additive only. takedown_requests links back to a threat via
-- (source_type = 'threat', source_id = threats.id). The only source_id
-- index (idx_takedown_requests_alert_source, 0275) is partial on
-- source_type = 'alert', so a per-threat lookup was a full table scan.
-- Same partial shape for the threat lane.
CREATE INDEX IF NOT EXISTS idx_takedown_requests_threat_source
  ON takedown_requests (source_id)
  WHERE source_type = 'threat';
