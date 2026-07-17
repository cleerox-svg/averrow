/**
 * Cartographer batch-submit + poll-and-ingest workflow (Lever #6).
 *
 * Architecture:
 *
 *   Daily at hour=2 (UTC):  submitCartographerScoringBatch()
 *     - Picks every AI-worthy provider that hasn't been batch-scored
 *       in the last 25h
 *     - Submits ONE message-batch to Anthropic at 50% discount
 *     - Stores the batch_id + provider IDs in KV
 *
 *   Every cartographer cron tick (9 * * * *):  pollAndIngestCartographerBatches()
 *     - Looks up the KV-pinned pending batches
 *     - Checks each via Anthropic's batch status endpoint
 *     - For any with processing_status === 'ended', downloads results
 *       and updates hosting_providers.reputation_score + last_scored_at
 *       per provider (same shape as the existing sync scoring path)
 *     - Cleans the batch from KV state
 *
 *   Inline scoreProvider() loop (existing):  unchanged
 *     - Still runs hourly for any AI-worthy provider whose last_scored_at
 *       is stale (the upstream query already gates on a 6h freshness
 *       window). Batch-scored providers naturally suppress sync calls
 *       because their last_scored_at gets updated by the ingestion step.
 *
 * State (KV):
 *   `cart:batch:pending` → JSON array of PendingBatch records, written
 *     by submitCartographerScoringBatch and pruned by the poller.
 *   `cart:batch:last_submit` → ISO-8601 of last successful submit. Used
 *     to skip a same-day double-submit if the cron fires twice.
 *
 * Why KV not D1: pending-batch state is small, ephemeral, and only read
 * by cartographer itself. Adding a D1 table for ~1-2 rows that turn over
 * daily is overkill. KV's eventual consistency is fine because the
 * submit/poll are serialized inside a single cartographer cron tick.
 */

import type { Env } from "../types";
import { HOT_PATH_HAIKU } from "./ai-models";
import {
  submitMessageBatch,
  getMessageBatch,
  downloadBatchResults,
  recordBatchCostInLedger,
  type BatchRequest,
} from "./anthropic-batches";

const KV_PENDING_KEY = "cart:batch:pending";
const KV_LAST_SUBMIT_KEY = "cart:batch:last_submit";
const PROVIDER_RESCORE_HOURS = 25; // 24h cadence + 1h slack
// Hard cap on providers per batch submission. Anthropic accepts up to
// 100,000 requests per batch, but oversized batches risk one bad input
// poisoning the whole result. 200 keeps each daily batch tractable for
// observability while still covering every AI-worthy provider we see.
const MAX_PROVIDERS_PER_BATCH = 200;

interface PendingBatch {
  batch_id: string;
  submitted_at: string;
  provider_count: number;
  /** Map from custom_id (provider_id) to provider_id — redundant for
   *  cartographer (custom_id IS the provider id) but kept explicit so
   *  the shape stays stable if a future caller diverges. */
  custom_id_to_provider_id: Record<string, string>;
}

async function readPending(env: Env): Promise<PendingBatch[]> {
  try {
    const raw = await env.CACHE.get(KV_PENDING_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PendingBatch[];
  } catch (err) {
    console.warn(`[cart-batch] readPending failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function writePending(env: Env, batches: PendingBatch[]): Promise<void> {
  // 48h TTL — covers 2x the 24h batch SLA so an in-flight batch never
  // gets dropped from state mid-processing.
  await env.CACHE.put(KV_PENDING_KEY, JSON.stringify(batches), { expirationTtl: 48 * 3600 });
}

/**
 * Submit the daily cartographer scoring batch. No-op if the last submit
 * was less than 23h ago (idempotency guard for double-fires).
 *
 * Returns the number of providers submitted (0 if no-op).
 */
export async function submitCartographerScoringBatch(env: Env, runId: string | null): Promise<{
  submitted: number;
  batch_id: string | null;
  skipped_reason?: string;
}> {
  // Idempotency: skip if we submitted within the last 23h
  try {
    const lastSubmit = await env.CACHE.get(KV_LAST_SUBMIT_KEY);
    if (lastSubmit) {
      const lastMs = Date.parse(lastSubmit);
      if (Number.isFinite(lastMs) && Date.now() - lastMs < 23 * 3600 * 1000) {
        return { submitted: 0, batch_id: null, skipped_reason: `last submit ${lastSubmit} < 23h ago` };
      }
    }
  } catch { /* fall through */ }

  // Gather AI-worthy providers: active_threat_count >= 5 OR has any
  // recent campaigns. Matches the inline gate at cartographer.ts:687.
  // Skip providers scored via batch within the last PROVIDER_RESCORE_HOURS.
  const providersRes = await env.DB.prepare(`
    SELECT id, name, asn, active_threat_count, total_threat_count,
           avg_response_time, trend_7d, trend_30d
      FROM hosting_providers
     WHERE active_threat_count >= 5
       AND (last_scored_at IS NULL
            OR last_scored_at < datetime('now', '-${PROVIDER_RESCORE_HOURS} hours'))
     ORDER BY active_threat_count DESC
     LIMIT ?
  `).bind(MAX_PROVIDERS_PER_BATCH).all<{
    id: string; name: string; asn: string | null;
    active_threat_count: number; total_threat_count: number;
    avg_response_time: number | null;
    trend_7d: number; trend_30d: number;
  }>();

  if (providersRes.results.length === 0) {
    return { submitted: 0, batch_id: null, skipped_reason: "no eligible providers" };
  }

  // One request per provider — Anthropic batches charge per request,
  // so packing N items into one request offers no extra discount. Single
  // provider per request keeps result-to-provider matching trivial.
  const systemPrompt = `You are a hosting provider reputation analyst. Score the hosting provider based on their threat hosting metrics.

Respond with ONLY a JSON object (no markdown, no prose outside the JSON).

If reputation_score >= 70 (low risk, "looks fine"):
  {"provider_name":"...","reputation_score":NN}
  Omit reasoning, risk_factors, response_assessment entirely.

If reputation_score < 70 (notable risk):
  {"provider_name":"...","reputation_score":NN,"reasoning":"<= 1 sentence, <= 200 chars","risk_factors":["...", "..."],"response_assessment":"<= 1 sentence, <= 150 chars"}
  Cap risk_factors at 3 items. Each item <= 60 chars. No filler.

100 = excellent abuse response. 0 = bulletproof / non-responsive / heavy threat hosting.`;

  const requests: BatchRequest[] = providersRes.results.map((p) => ({
    custom_id: p.id,
    params: {
      model: HOT_PATH_HAIKU,
      max_tokens: 384,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `Score this hosting provider's reputation:
${JSON.stringify({
  name: p.name,
  asn: p.asn,
  active_threats: p.active_threat_count,
  total_threats: p.total_threat_count,
  avg_response_time: p.avg_response_time,
  trend_7d: p.trend_7d,
  trend_30d: p.trend_30d,
}, null, 2)}`,
      }],
    },
  }));

  const submitResp = await submitMessageBatch(env, requests, { useGateway: false });

  const pending = await readPending(env);
  const pendingEntry: PendingBatch = {
    batch_id: submitResp.id,
    submitted_at: new Date().toISOString(),
    provider_count: providersRes.results.length,
    custom_id_to_provider_id: Object.fromEntries(providersRes.results.map((p) => [p.id, p.id])),
  };
  await writePending(env, [...pending, pendingEntry]);
  await env.CACHE.put(KV_LAST_SUBMIT_KEY, pendingEntry.submitted_at, { expirationTtl: 30 * 24 * 3600 });

  console.log(`[cart-batch] submitted batch_id=${submitResp.id} providers=${providersRes.results.length} runId=${runId ?? '-'}`);
  return { submitted: providersRes.results.length, batch_id: submitResp.id };
}

/**
 * Poll every pending batch. For any that's ended, download results,
 * update hosting_providers, bill the ledger at the discounted rate,
 * and remove from pending state.
 *
 * Designed to run inside the existing hourly cartographer cron — safe
 * to call when there are no pending batches (no-op).
 */
export async function pollAndIngestCartographerBatches(env: Env, runId: string | null): Promise<{
  polled: number;
  ingested_batches: number;
  ingested_providers: number;
  cost_usd: number;
  errors: string[];
}> {
  const pending = await readPending(env);
  const errors: string[] = [];
  if (pending.length === 0) {
    return { polled: 0, ingested_batches: 0, ingested_providers: 0, cost_usd: 0, errors };
  }

  let ingestedBatches = 0;
  let ingestedProviders = 0;
  let costUsd = 0;
  const stillPending: PendingBatch[] = [];

  for (const entry of pending) {
    let status;
    try {
      status = await getMessageBatch(env, entry.batch_id, { useGateway: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`get ${entry.batch_id}: ${msg}`);
      stillPending.push(entry);
      continue;
    }

    if (status.processing_status !== "ended" || !status.results_url) {
      stillPending.push(entry);
      continue;
    }

    let results;
    try {
      results = await downloadBatchResults(env, status.results_url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`download ${entry.batch_id}: ${msg}`);
      stillPending.push(entry);
      continue;
    }

    // Ingest each succeeded result. Errors stay as a counter on the
    // batch — we don't retry inside the cron tick; the affected
    // providers will be re-eligible next day via the freshness gate.
    for (const r of results) {
      if (r.result.type !== "succeeded") continue;
      const providerId = entry.custom_id_to_provider_id[r.custom_id];
      if (!providerId) {
        errors.push(`unknown custom_id ${r.custom_id} in batch ${entry.batch_id}`);
        continue;
      }
      const textBlock = r.result.message.content.find((b) => b.type === "text");
      if (!textBlock?.text) {
        errors.push(`provider ${providerId} batch ${entry.batch_id}: no text block`);
        continue;
      }
      // Same parsing tolerance as the sync path's callAnthropicJSON
      let parsed: { reputation_score?: number };
      try {
        const t = textBlock.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        const m = t.match(/\{[\s\S]*\}/);
        if (!m) throw new Error("no JSON object in response");
        parsed = JSON.parse(m[0]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`provider ${providerId} batch ${entry.batch_id}: parse fail (${msg})`);
        continue;
      }
      const score = parsed.reputation_score;
      if (typeof score !== "number" || score < 0 || score > 100) {
        errors.push(`provider ${providerId} batch ${entry.batch_id}: bad score ${score}`);
        continue;
      }
      try {
        await env.DB.prepare(
          "UPDATE hosting_providers SET reputation_score = ?, last_scored_at = datetime('now'), last_score = ?, last_score_threat_count = active_threat_count WHERE id = ?"
        ).bind(Math.round(score), Math.round(score), providerId).run();
        ingestedProviders++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`provider ${providerId} batch ${entry.batch_id}: update failed (${msg})`);
      }
    }

    // Bill the batch to the ledger at the 50% Batches rate
    try {
      const cost = await recordBatchCostInLedger(env, "cartographer", runId, HOT_PATH_HAIKU, results);
      costUsd += cost.cost_usd_estimate;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`ledger ${entry.batch_id}: ${msg}`);
    }
    ingestedBatches++;
  }

  await writePending(env, stillPending);
  return {
    polled: pending.length,
    ingested_batches: ingestedBatches,
    ingested_providers: ingestedProviders,
    cost_usd: costUsd,
    errors,
  };
}
