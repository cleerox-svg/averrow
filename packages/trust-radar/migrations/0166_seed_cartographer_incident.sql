-- 0166_seed_cartographer_incident.sql
-- Files the 2026-05-12 cartographer degradation as a public incident so
-- the status site reflects what operators saw on the Home banner. Fix
-- ships in the companion code change + migrations 0164/0165.
--
-- Deterministic id (`inc_2026_05_12_carto_degradation`) makes the
-- migration idempotent — re-running has no effect.

INSERT OR IGNORE INTO incidents (
  id,
  title,
  description,
  public_title,
  public_details,
  status,
  severity,
  visibility,
  affected_components,
  detected_at,
  source,
  created_at,
  updated_at
) VALUES (
  'inc_2026_05_12_carto_degradation',
  'Cartographer reaped repeatedly — agents category degraded',
  'Cartographer Phase 0 batches were overshooting the 105-min reaper ceiling. Navigator was terminating runs mid-flight, dropping the 6h agent success rate below the operational threshold. Root cause: per-tick batch was 2,500 threats (5 batches × 500); ~116 of 169 exhausted items were typosquat_scanner entries that almost never resolve to an IP and were being retried every tick. Mitigation: reduced batches to 3 + added upstream source_feed != typosquat_scanner filter + drained already-queued typosquats via migration 0164.',
  'Brief enrichment slowdown — no customer impact',
  'Our infrastructure enrichment service (Cartographer) experienced longer-than-normal run times on May 12, 2026, briefly dropping the Agents category status to Degraded. No customer-facing data was lost or delayed beyond a few hours. Mitigation is live and the queue is draining.',
  'monitoring',
  'medium',
  'public',
  json_array('agent:cartographer', 'category:agents'),
  datetime('now', '-2 hours'),
  'manual',
  datetime('now'),
  datetime('now')
);

-- Initial timeline entry, public, so /status renders the narrative.
INSERT OR IGNORE INTO incident_updates (
  id,
  incident_id,
  kind,
  status,
  message,
  public_message,
  visibility,
  event_type,
  created_at
) VALUES (
  'inc_upd_2026_05_12_carto_initial',
  'inc_2026_05_12_carto_degradation',
  'operator',
  'monitoring',
  'Cartographer per-tick batch reduced from 5×500 to 3×500. typosquat_scanner items now skipped upstream so they no longer clog the queue. 116 already-queued typosquats stamped as exhausted via migration 0164. Watching the Agents category recover to operational.',
  'Mitigation deployed. Background enrichment is catching up; Agents category will return to Operational within the next few status windows.',
  'public',
  'status_transition',
  datetime('now')
);
