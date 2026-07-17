import type { Env } from "../types";

export interface EnrichmentResult {
  enriched: number;
  skipped: number;
  errors: number;
}

export type EnricherFn = (db: D1Database, env: Env) => Promise<EnrichmentResult>;
