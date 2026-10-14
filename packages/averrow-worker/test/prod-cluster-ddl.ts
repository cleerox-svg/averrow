/**
 * Prod's real `infrastructure_clusters` DDL. The table was created outside
 * the repo's migrations (see migration 0136's header); 0136's CREATE TABLE IF
 * NOT EXISTS reproduces it for fresh DBs, and later migrations add columns.
 *
 * As of 2026-10-14, 0302's country_counts already applied. 0303 adds
 * `retired_reason TEXT` on top (PROD_CLUSTERS_COLUMNS includes it).
 */
export const PROD_CLUSTERS_DDL = `CREATE TABLE infrastructure_clusters (id TEXT PRIMARY KEY, cluster_name TEXT, asns TEXT NOT NULL, ip_ranges TEXT, countries TEXT, campaign_ids TEXT, brand_ids TEXT, attack_types TEXT, hosting_provider_ids TEXT, threat_count INTEGER DEFAULT 0, confidence_score INTEGER, ai_generated_probability INTEGER, ai_classification TEXT, pivot_from_cluster_id TEXT REFERENCES infrastructure_clusters(id), first_detected TEXT DEFAULT (datetime('now')), last_updated TEXT DEFAULT (datetime('now')), last_seen TEXT, status TEXT DEFAULT 'active' CHECK (status IN ('active','dormant','disrupted')), agent_notes TEXT, nexus_brief TEXT, actor_id TEXT REFERENCES threat_actors(id) ON DELETE SET NULL, attribution_attempted_at TEXT, attribution_dismissed_at TEXT, component_id TEXT, infra_fingerprint TEXT, infra_fingerprint_at TEXT, last_movement_pivot_at TEXT, country_counts TEXT)`;

/** Prod's column list after migration 0303 (DDL above + retired_reason), in order. */
export const PROD_CLUSTERS_COLUMNS: readonly string[] = [
  "id", "cluster_name", "asns", "ip_ranges", "countries", "campaign_ids", "brand_ids",
  "attack_types", "hosting_provider_ids", "threat_count", "confidence_score",
  "ai_generated_probability", "ai_classification", "pivot_from_cluster_id", "first_detected",
  "last_updated", "last_seen", "status", "agent_notes", "nexus_brief", "actor_id",
  "attribution_attempted_at", "attribution_dismissed_at", "component_id", "infra_fingerprint",
  "infra_fingerprint_at", "last_movement_pivot_at", "country_counts", "retired_reason",
];
