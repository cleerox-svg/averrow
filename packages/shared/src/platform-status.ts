// Shared types for the platform-status rollup that backs the Home
// banner (Phase 2) and the public status page (Phase 3). Keep this
// file in sync with packages/averrow-worker/src/lib/platform-status.ts —
// changing one without the other is a typecheck error in the consumer.

export type CategoryStatus = "operational" | "degraded" | "outage";

export type CategoryKey = "feeds" | "agents" | "processing";

export interface DailyPoint {
  /** YYYY-MM-DD (UTC). */
  date: string;
  status: CategoryStatus;
  /** 0–100 uptime %, rounded to nearest int. */
  uptime_pct: number;
  /** Optional 1-line operator hint. */
  note?: string;
}

export interface CategoryRollup {
  category: CategoryKey;
  /** Status for the most recent fully-closed UTC day. */
  current: CategoryStatus;
  /** Mean of the 30 daily uptimes. */
  uptime_30d_pct: number;
  /** Oldest first, length 30. Last entry = yesterday (UTC). */
  daily: DailyPoint[];
  /** Status for "right now" (rolling last 6h). May differ from current. */
  realtime: CategoryStatus;
  /** Short human-readable cause for the realtime state. */
  realtime_note: string;
}

export interface PlatformStatus {
  generated_at: string;
  /** Worst of the three realtime states. Drives the Home banner. */
  overall: CategoryStatus;
  overall_note: string;
  categories: CategoryRollup[];
  /** Used by the public status page header copy. */
  window_days: number;
  /** True if the response was served from KV cache. */
  cached?: boolean;
}

/** Stable display labels — keep in sync between Home banner and Phase 3 status page. */
export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  feeds: "Feeds",
  agents: "Agents",
  processing: "Processing",
};

export const STATUS_LABELS: Record<CategoryStatus, string> = {
  operational: "All systems operational",
  degraded: "Degraded",
  outage: "Outage",
};
