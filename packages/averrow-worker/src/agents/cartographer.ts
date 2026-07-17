/**
 * Cartographer Agent — Infrastructure mapping & provider reputation scoring.
 *
 * Runs every 15 minutes (clearing enrichment backlog) and on Sentinel trigger.
 * Maps threat infrastructure to hosting providers and computes
 * reputation scores via Haiku AI analysis.
 *
 * Enrichment pipeline:
 * - ip-api.com batch (100 IPs/req, 45 req/min free) → lat/lng/ASN/country
 * - RDAP → registrar + registration date for domains
 * - hosting_providers table upsert from ASN data
 * - agent_events emitted after each enrichment batch
 *
 * Also performs:
 * - Geo enrichment of unenriched threats (ipinfo.io fallback)
 * - Provider threat stats aggregation across time periods
 * - Email security posture scans
 * - DMARC source IP geo enrichment
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import type { Env } from "../types";
import { scoreProvider, scoreProvidersBatch } from "../lib/haiku";
import { runEmailSecurityScan, saveEmailSecurityScan } from "../email-security";
import { createNotification } from "../lib/notifications";
import { emitIntelNotification, renderIntelRecommendedAction } from "../lib/intel-templates";
import { PRIVATE_IP_SQL_FILTER } from "../lib/geoip";
import { cachedCount } from "../lib/cached-count";
// Alert-type registry — single source of truth for alert_type column
// values. Importing the key here means any future rename of the
// 'geopolitical_threat' string changes in one place; the CHECK
// constraint in migration 0121 enforces match at the DB level.
import { ALERT_TYPES } from "@averrow/shared";

// ─── ip-api.com batch types ───────────────────────────────────────

interface IpApiResult {
  status: string;
  lat: number;
  lon: number;
  as: string;
  country: string;
  countryCode: string;
  isp: string;
  org: string;
}

interface IpGeoResult {
  status: string;
  lat: number;
  lon: number;
  as: string;
  country: string;
  countryCode: string;
  isp: string;
  org: string;
}

// ─── Utility ──────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── ip-api.com batch enrichment ──────────────────────────────────

async function enrichIpBatch(ips: string[]): Promise<Map<string, IpGeoResult>> {
  const chunks = chunkArray(ips.filter(Boolean), 100);
  const results = new Map<string, IpGeoResult>();

  // Total-elapsed cap across all chunks. ip-api.com going partially slow
  // would otherwise let multiple chunks compound into a multi-minute hang.
  // We've seen the upstream get unresponsive in bursts (cf taxii_otx
  // 12-min timeout 2026-05-13). 60s is generous for the common path
  // (45 req/min rate-limit gate + 5 chunks ≈ 7s) and a hard ceiling
  // for the pathological one. Cart's normal AI/email/stats work doesn't
  // depend on these results landing — empty map is the right fallback.
  const LOOP_CEILING_MS = 60_000;
  const PER_CHUNK_TIMEOUT_MS = 15_000;
  const loopStart = Date.now();

  for (const chunk of chunks) {
    if (Date.now() - loopStart > LOOP_CEILING_MS) {
      console.warn(`[cartographer] enrichIpBatch loop ceiling reached after ${results.size} IPs across ${chunks.length} chunks — bailing.`);
      break;
    }
    try {
      const res = await fetch('http://ip-api.com/batch?fields=status,lat,lon,as,country,countryCode,isp,org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(ip => ({ query: ip }))),
        signal: AbortSignal.timeout(PER_CHUNK_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const data = await res.json() as IpGeoResult[];
      chunk.forEach((ip, i) => {
        if (data[i]?.status === 'success') results.set(ip, data[i]);
      });
      // Respect 45 req/min rate limit
      if (chunks.length > 1) await sleep(1400);
    } catch (err) {
      console.error('[cartographer] ip-api batch error:', err);
    }
  }
  return results;
}

// ─── RDAP registrar lookup ────────────────────────────────────────

async function lookupRegistrar(env: Env, domain: string): Promise<{ registrar: string | null; registration_date: string | null }> {
  try {
    // PR-C (2026-05-16 audit fix #15): rdap.org returns HTTP 403
    // "Host not in allowlist" to CF Workers, nulling 100% of our
    // registrar enrichment. Route through the IANA bootstrap to hit
    // each TLD's authoritative server directly.
    const { getRdapServerForDomain } = await import('../lib/rdap-bootstrap');
    const server = await getRdapServerForDomain(env, domain);
    if (!server) return { registrar: null, registration_date: null };

    const base = server.endsWith('/') ? server : `${server}/`;
    const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
      headers: { 'Accept': 'application/rdap+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { registrar: null, registration_date: null };
    const data = await res.json() as {
      entities?: Array<{ roles?: string[]; vcardArray?: [string, Array<[string, unknown, string, string]>] }>;
      events?: Array<{ eventAction?: string; eventDate?: string }>;
    };
    const registrar = data.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]
      ?.find((v) => v[0] === 'fn')?.[3] ?? null;
    const registration_date = data.events?.find((e) => e.eventAction === 'registration')?.eventDate ?? null;
    return { registrar, registration_date };
  } catch {
    return { registrar: null, registration_date: null };
  }
}

// ─── Agent Definition ─────────────────────────────────────────────

export const cartographerAgent: AgentModule = {
  name: "cartographer",
  displayName: "Navigator",
  description: "Infrastructure mapping, geo enrichment & provider reputation scoring",
  color: "#5A80A8",
  trigger: "scheduled",
  requiresApproval: false,
  // Cartographer runs 5 phases sequentially: Phase 0 (ip-api batch),
  // 0.5 (GeoIP MMDB), 1 (ipinfo fallback), 2 (Haiku provider reputation
  // scoring — top 50 providers), 3 (email security scans), 4 (DMARC
  // source IP geo), 5 (provider stats aggregation). Live diagnostics
  // 2026-05-12 showed avg run duration 67 min with the 75-min stall
  // threshold + 30-min buffer = 105-min reaper ceiling repeatedly
  // tripping. Bumping the declared threshold to 150 (180-min ceiling)
  // gives the multi-phase pipeline room to land without false reaps.
  // Splitting Phase 2/3 into their own agents is the proper fix — this
  // is the operator-relief change while that's planned.
  stallThresholdMinutes: 150,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 50_000_000 },
  reads: [
    { kind: "kv", namespace: "CACHE" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "dmarc_report_records" },
    { kind: "d1_table", name: "geopolitical_campaign_links" },
    { kind: "d1_table", name: "geopolitical_campaigns" },
    { kind: "d1_table", name: "hosting_providers" },
    { kind: "d1_table", name: "threat_cube_provider" },
    { kind: "d1_table", name: "threats" },
  ],
  writes: [
    { kind: "d1_table", name: "agent_events" },
    { kind: "d1_table", name: "alerts" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "dmarc_report_records" },
    { kind: "d1_table", name: "hosting_providers" },
    { kind: "d1_table", name: "merges" },
    { kind: "d1_table", name: "provider_threat_stats" },
    { kind: "d1_table", name: "threats" },
  ],
  outputs: [{ type: "insight" }, { type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 3,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, runId } = ctx;
    const callCtx = { agentId: "cartographer", runId };

    let itemsProcessed = 0;
    let itemsUpdated = 0;
    let itemsCreated = 0;
    let totalTokens = 0;
    let model: string | undefined;
    const outputs: AgentOutputEntry[] = [];

    // ─── Lever #6: Message Batches API for daily provider scoring ───
    // Two pieces of the batched scoring flow run inside this hourly
    // cartographer tick:
    //   1. Always: poll any pending batch submissions. When Anthropic
    //      reports a batch ended, download results and update
    //      hosting_providers.reputation_score per provider — same shape
    //      as the inline sync path's UPDATE. Ingestion is fully
    //      idempotent (results carry the provider_id as custom_id).
    //   2. Once per day at hour=2 UTC: submit a new batch covering all
    //      AI-worthy providers that haven't been batch-scored in 25h.
    //
    // Both are no-ops when there's nothing to do (no pending batches,
    // no eligible providers, or a recent submit). The inline sync
    // scoring loop later in this function continues to run hourly but
    // naturally skips providers that the batch ingestion just freshened
    // (the upstream query gates on last_scored_at).
    //
    // Failure isolation: any failure here is logged + continued — the
    // rest of the cartographer tick (IP enrichment, email security
    // scans, inline scoring) must not be blocked by a batch hiccup.
    let batchPollSummary: Awaited<ReturnType<typeof import("../lib/cartographer-batch").pollAndIngestCartographerBatches>> | null = null;
    let batchSubmitSummary: Awaited<ReturnType<typeof import("../lib/cartographer-batch").submitCartographerScoringBatch>> | null = null;
    try {
      const { pollAndIngestCartographerBatches, submitCartographerScoringBatch } = await import("../lib/cartographer-batch");
      try {
        batchPollSummary = await pollAndIngestCartographerBatches(env, runId);
        if (batchPollSummary.ingested_batches > 0) {
          itemsUpdated += batchPollSummary.ingested_providers;
        }
      } catch (err) {
        console.error("[cartographer] batch poll failed:", err);
      }
      // Daily submission window. The cartographer cron fires at :09
      // UTC hourly per wrangler.toml; the hour gate matches the standard
      // cron-audit rule (hour-only checks). The submit helper itself
      // also enforces a 23h idempotency guard against double-fires, so
      // a manual /api/internal/agents/cartographer/run during hour=2
      // won't double-submit.
      const scheduledHour = new Date().getUTCHours();
      if (scheduledHour === 2) {
        try {
          batchSubmitSummary = await submitCartographerScoringBatch(env, runId);
        } catch (err) {
          console.error("[cartographer] batch submit failed:", err);
        }
      }
    } catch (err) {
      console.error("[cartographer] batch module import failed:", err);
    }

    // ─── Phase 0: ip-api.com batch enrichment for unenriched threats ───
    // Process up to 3 batches of 500 (1,500 threats) per cron tick. 2026-05-12
    // platform-status went degraded because 5 batches at ~3s/threat overshot
    // the 105-min reaper ceiling; navigator was killing cartographer runs
    // mid-flight. Trimming to 3 batches keeps each tick under ~60 min and
    // (paired with the typosquat skip below) drains the queue at the same
    // rate by stopping unenrichable items from re-entering it.
    // Flight Control can pass an offset via ctx.input to allow parallel instances
    const BATCH_SIZE = 500;
    const MAX_BATCHES_PER_RUN = 3;
    const startOffset = typeof ctx.input.offset === 'number' ? ctx.input.offset : 0;
    let batchGeoResponded = 0;
    let batchGeoLocated = 0;
    let rdapEnriched = 0;
    // Surface env.DB.batch() failures so we can diagnose without wrangler tail.
    // Pre-PR-#825 these went only to console.error and were invisible. The
    // 2026-04-27 cartographer-health snapshot revealed ~90% of threat UPDATEs
    // weren't persisting (geo_located counter said 2,397 but enriched_last_hour
    // showed 243). This counter + first-error capture surfaces the root cause
    // in agent_outputs.details so cartographer-health can read it.
    let batchFlushFailures = 0;
    let batchFlushSuccesses = 0;
    let firstFlushError: string | null = null;
    let firstFlushErrorChunk: number | null = null;

    try {
      for (let batchIndex = 0; batchIndex < MAX_BATCHES_PER_RUN; batchIndex++) {
        const currentOffset = startOffset + (batchIndex * BATCH_SIZE);
        const unenriched = await env.DB.prepare(`
          SELECT id, ip_address, malicious_domain, malicious_url, hosting_provider_id
          FROM threats
          WHERE enriched_at IS NULL
            AND ip_address IS NOT NULL AND ip_address != ''
            AND enrichment_attempts < 5
            -- typosquat_scanner emits hypothetical lookalike domains that
            -- almost never have a resolving IP, so cartographer just burns
            -- attempts on them and clogs the queue. Skip upstream — the
            -- companion migration drains items already enqueued.
            AND source_feed != 'typosquat_scanner'
            ${PRIVATE_IP_SQL_FILTER}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `).bind(BATCH_SIZE, currentOffset).all<{
          id: string;
          ip_address: string | null;
          malicious_domain: string | null;
          malicious_url: string | null;
          hosting_provider_id: string | null;
        }>();

        if (unenriched.results.length === 0) break; // backlog cleared

        // Batch enrich IPs via ip-api.com
        const ips = unenriched.results
          .map(t => t.ip_address)
          .filter((ip): ip is string => ip != null && ip !== '');
        const geoResults = ips.length > 0 ? await enrichIpBatch([...new Set(ips)]) : new Map<string, IpGeoResult>();

        // Collect all writes for this batch and flush via D1 batch() once at the end.
        // This reduces D1 writer hold time from ~1500 sequential awaits per run
        // (3 writes × 500 threats) to a small number of batched round-trips, freeing
        // the writer for user-facing reads.
        const pendingWrites: D1PreparedStatement[] = [];

        // ─── Pre-resolve hosting providers by ASN ─────────────────────
        // hosting_providers.asn has UNIQUE — but cartographer historically
        // derived the row id from the provider NAME (e.g. hp_china_unicom_beijing),
        // which let two threats with different name variants ("AS4837 China
        // Unicom Beijing" vs "AS4837 China Unicom") generate different ids
        // for the same ASN. Result: ON CONFLICT(id) didn't fire, UNIQUE(asn)
        // tripped, the entire 100-statement batch chunk rolled back atomically.
        // The 2026-04-28 cartographer-health snapshot showed this killing
        // ~90% of threat UPDATEs in production.
        //
        // Fix: look up existing providers by ASN once per batch, reuse those
        // ids when threats share an ASN with a known row. For genuinely-new
        // ASNs (not in DB), derive id deterministically as hp_${asn} so that
        // concurrent cartographer instances generate the same id and
        // ON CONFLICT(id) handles the cross-instance race naturally.
        const asnsInBatch = new Set<string>();
        for (const t of unenriched.results) {
          const g = t.ip_address ? geoResults.get(t.ip_address) : null;
          const a = g?.as?.split(' ')[0];
          if (a) asnsInBatch.add(a);
        }

        const asnToProviderId = new Map<string, string>();
        if (asnsInBatch.size > 0) {
          const asnList = [...asnsInBatch];
          const placeholders = asnList.map(() => '?').join(',');
          const existing = await env.DB.prepare(
            `SELECT id, asn FROM hosting_providers WHERE asn IN (${placeholders})`
          ).bind(...asnList).all<{ id: string; asn: string }>();
          for (const row of existing.results) {
            asnToProviderId.set(row.asn, row.id);
          }
        }

        // Track provider upserts queued in this batch so we don't queue
        // duplicates for threats that share the same ASN. Tracked by ASN
        // (not generated id) since the deterministic-id derivation makes
        // ASN the canonical identifier.
        const queuedAsns = new Set<string>();

        // Pre-load geopolitical campaigns once per batch (cached after first call)
        const activeCampaigns = await getActiveGeoCampaigns(env.DB);

        // Build all writes for this batch
        for (const threat of unenriched.results) {
          const geo = threat.ip_address ? geoResults.get(threat.ip_address) : null;

          // Match or create hosting provider from ASN — queue upsert, don't await
          let providerId = threat.hosting_provider_id;
          if (!providerId && geo?.as && geo.as.split(' ')[0]) {
            const asn = geo.as.split(' ')[0]!;
            const providerName = geo.as.replace(/^AS\d+\s*/, '').trim() || geo.isp || geo.org;

            // Prefer the existing provider's id (legacy or new shape).
            // This preserves FK integrity for threats already pointing
            // to the legacy name-derived id.
            const existingId = asnToProviderId.get(asn);

            if (existingId) {
              providerId = existingId;
              // Queue a touch-update so last_enriched reflects this run,
              // unless we've already queued for this ASN in this batch.
              if (providerName && !queuedAsns.has(asn)) {
                queuedAsns.add(asn);
                pendingWrites.push(env.DB.prepare(`
                  INSERT INTO hosting_providers (id, name, asn, country, last_enriched)
                  VALUES (?, ?, ?, ?, datetime('now'))
                  ON CONFLICT(id) DO UPDATE SET
                    last_enriched = datetime('now'),
                    asn = COALESCE(hosting_providers.asn, excluded.asn),
                    country = COALESCE(hosting_providers.country, excluded.country)
                `).bind(existingId, providerName, asn, geo.countryCode));
              }
            } else if (providerName) {
              // Genuinely-new ASN — derive id from ASN so concurrent
              // cartographer instances both produce hp_${asn} and the
              // ON CONFLICT(id) DO UPDATE merges them cleanly.
              const hpId = `hp_${asn}`;
              providerId = hpId;
              asnToProviderId.set(asn, hpId);  // remember within this batch
              if (!queuedAsns.has(asn)) {
                queuedAsns.add(asn);
                pendingWrites.push(env.DB.prepare(`
                  INSERT INTO hosting_providers (id, name, asn, country, last_enriched)
                  VALUES (?, ?, ?, ?, datetime('now'))
                  ON CONFLICT(id) DO UPDATE SET
                    last_enriched = datetime('now'),
                    asn = COALESCE(hosting_providers.asn, excluded.asn),
                    country = COALESCE(hosting_providers.country, excluded.country)
                `).bind(hpId, providerName, asn, geo.countryCode));
              }
            }
          }

          // RDAP for domain (throttled — max 10 per run to avoid overload).
          // This stays sequential because it's network-bound and rate-limited.
          let registrar: string | null = null;
          let registration_date: string | null = null;
          if (threat.malicious_domain && rdapEnriched < 10) {
            const rdap = await lookupRegistrar(env, threat.malicious_domain);
            registrar = rdap.registrar;
            registration_date = rdap.registration_date;
            if (registrar || registration_date) rdapEnriched++;
          }

          // Queue threat update — flushed in batch below.
          //
          // enriched_at is stamped only when ip-api returned actual coordinates
          // (geo.lat is non-null). Earlier behavior stamped enriched_at on any
          // status='success' response — but ip-api returns success with empty
          // lat/lng for ~93% of IPs (ASN-only or no-country responses). That
          // funneled most "successful" threats into the stuck pile (lat NULL
          // but enriched_at set), keeping them out of the queue forever despite
          // having no usable geo data.
          //
          // Recycling protection comes from enrichment_attempts (capped at 5
          // via migrations/0110's partial index filter). Threats that ip-api
          // can't geolocate retry up to 5 times then exit via the cap, instead
          // of graduating to the stuck pile on the first partial-success response.
          pendingWrites.push(env.DB.prepare(`
            UPDATE threats SET
              lat = COALESCE(lat, ?),
              lng = COALESCE(lng, ?),
              country_code = COALESCE(country_code, ?),
              asn = COALESCE(asn, ?),
              hosting_provider_id = COALESCE(hosting_provider_id, ?),
              registrar = COALESCE(registrar, ?),
              registration_date = COALESCE(registration_date, ?),
              enriched_at = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE enriched_at END,
              enrichment_attempts = enrichment_attempts + 1
            WHERE id = ?
          `).bind(
            geo?.lat ?? null, geo?.lon ?? null, geo?.countryCode ?? null,
            geo?.as?.split(' ')[0] ?? null, providerId,
            registrar, registration_date,
            geo?.lat ?? null,
            threat.id
          ));
          // geo_responded: ip-api returned status='success' for this IP
          //   (geo object exists in the result Map). Counts threats whose
          //   enrichment_attempts will increment regardless of usefulness.
          // geo_located:  ip-api actually returned coordinates (geo.lat is
          //   non-null). This is the only count that matches enriched_at
          //   stamping under the post-#823 logic — the headline yield metric.
          if (geo) batchGeoResponded++;
          if (geo?.lat != null) batchGeoLocated++;
          itemsUpdated++;

          // ─── Geopolitical campaign escalation ───
          // Build escalation statements from cached campaigns (no DB read).
          const threatCountryCode = geo?.countryCode ?? null;
          const threatAsn = geo?.as?.split(' ')[0] ?? null;
          if (threatCountryCode || threatAsn) {
            const escStmts = buildGeopoliticalEscalationStatements(
              env.DB, activeCampaigns, threat.id, threatCountryCode, threatAsn,
            );
            for (const stmt of escStmts) pendingWrites.push(stmt);
          }
        }

        // Flush all writes for this batch in one round-trip.
        // D1 batch() executes statements in a single transaction; failures
        // roll back the whole batch, so we chunk to keep failures localized
        // and to stay under any per-batch size limits.
        if (pendingWrites.length > 0) {
          const FLUSH_CHUNK = 100;
          for (let i = 0; i < pendingWrites.length; i += FLUSH_CHUNK) {
            const slice = pendingWrites.slice(i, i + FLUSH_CHUNK);
            try {
              await env.DB.batch(slice);
              batchFlushSuccesses++;
            } catch (err) {
              batchFlushFailures++;
              const msg = err instanceof Error ? err.message : String(err);
              if (firstFlushError === null) {
                firstFlushError = msg;
                firstFlushErrorChunk = i;
              }
              console.error(`[cartographer] batch flush error (chunk ${i}-${i + slice.length}):`, err);
            }
          }
        }

        // Emit agent_event after each enrichment batch
        try {
          await env.DB.prepare(`
            INSERT INTO agent_events (id, event_type, source_agent, payload_json, priority)
            VALUES (?, 'threats_enriched', 'cartographer', ?, 3)
          `).bind(
            crypto.randomUUID(),
            JSON.stringify({ count: unenriched.results.length, enriched: batchGeoResponded, geo_located: batchGeoLocated, batch: batchIndex + 1, batch_complete: true })
          ).run();
        } catch (err) {
          console.error('[cartographer] agent_event emit error:', err);
        }

        // Brief pause between batches to respect ip-api.com rate limit (45 req/min)
        if (batchIndex < MAX_BATCHES_PER_RUN - 1 && unenriched.results.length === BATCH_SIZE) {
          await sleep(1500);
        }
      }

      if (batchGeoResponded > 0 || batchFlushFailures > 0) {
        const totalChunks = batchFlushSuccesses + batchFlushFailures;
        const flushFailurePct = totalChunks > 0
          ? Math.round((batchFlushFailures / totalChunks) * 1000) / 10
          : 0;
        outputs.push({
          type: "diagnostic",
          summary: `ip-api.com batch: ${batchGeoResponded} responses, ${batchGeoLocated} geo-located across up to ${MAX_BATCHES_PER_RUN} batches, ${rdapEnriched} RDAP lookups${batchFlushFailures > 0 ? ` — ${batchFlushFailures}/${totalChunks} D1 batch chunks FAILED` : ''}`,
          severity: batchFlushFailures > 0 ? "high" : "info",
          // batch_enriched preserved as legacy alias for batch_geo_responded
          // — historical agent_outputs rows depend on it. New rows carry the
          // honest pair so consumers can compute the real lat-yield.
          //
          // batch_flush_failures / first_flush_error surface the silent D1
          // batch rollback failures that PR #825 made visible. Read via
          // /api/internal/cartographer-health to diagnose without wrangler tail.
          details: {
            batch_enriched: batchGeoResponded,
            batch_geo_responded: batchGeoResponded,
            batch_geo_located: batchGeoLocated,
            rdap_enriched: rdapEnriched,
            batch_size: BATCH_SIZE,
            max_batches: MAX_BATCHES_PER_RUN,
            batch_flush_successes: batchFlushSuccesses,
            batch_flush_failures: batchFlushFailures,
            batch_flush_failure_pct: flushFailurePct,
            first_flush_error: firstFlushError,
            first_flush_error_chunk: firstFlushErrorChunk,
          },
        });
      }
    } catch (err) {
      console.error("[cartographer] ip-api batch enrichment error:", err);
    }

    // ─── Phase 0.5: GeoIP MMDB lookup (third-tier provider) ───
    // Local D1-backed range lookup (MaxMind GeoLite2) for threats
    // that still have lat IS NULL after Phase 0. Different data
    // source class than ip-api/ipinfo (both census-style) — actually
    // covers malicious IPs Phase 0 leaves stuck.
    //
    // No-ops when GEOIP_DB binding is unset (operator hasn't
    // provisioned the dedicated D1 yet) — call short-circuits in
    // lookupGeoMmdb. Costs zero D1 reads on the main DB; the
    // SELECT runs against GEOIP_DB.
    let mmdbAttempted = 0;
    let mmdbResolved = 0;
    try {
      const { lookupGeoMmdb } = await import("../lib/geoip-mmdb");
      // Fetch threats that came out of Phase 0 with an IP but no
      // lat/lng. Bounded by MMDB_MAX_PER_RUN so a deep backlog
      // doesn't blow our CPU budget — Phase 1 (ipinfo) and the
      // next cartographer tick continue draining.
      const MMDB_MAX_PER_RUN = 500;
      const stuckRows = await env.DB.prepare(`
        SELECT id, ip_address FROM threats
        WHERE ip_address IS NOT NULL AND ip_address != ''
          AND lat IS NULL
          AND enrichment_attempts < 8
        ORDER BY created_at DESC
        LIMIT ?
      `).bind(MMDB_MAX_PER_RUN).all<{ id: string; ip_address: string }>();

      for (const row of stuckRows.results) {
        mmdbAttempted++;
        const geo = await lookupGeoMmdb(env, row.ip_address);
        if (!geo || geo.lat == null || geo.lng == null) {
          // Increment the attempt counter even on miss so this IP
          // eventually drops out of the queue via the < 8 bound.
          // Without this, GeoLite2-uncovered IPs (sinkholes, CDN,
          // anycast) get re-selected by the LIMIT 500 selector every
          // cartographer tick and re-hit D1 forever — see geoip-mmdb
          // null-cache fix in the same PR.
          try {
            await env.DB.prepare(`
              UPDATE threats
                 SET enrichment_attempts = COALESCE(enrichment_attempts, 0) + 1
               WHERE id = ?
            `).bind(row.id).run();
          } catch (err) {
            console.error('[cartographer] mmdb attempt-increment failed:', err instanceof Error ? err.message : err);
          }
          continue;
        }
        try {
          await env.DB.prepare(`
            UPDATE threats SET
              lat = COALESCE(lat, ?),
              lng = COALESCE(lng, ?),
              country_code = COALESCE(country_code, ?),
              asn = COALESCE(asn, ?),
              enriched_at = CASE WHEN enriched_at IS NULL THEN datetime('now') ELSE enriched_at END
            WHERE id = ?
          `).bind(geo.lat, geo.lng, geo.countryCode, geo.asn, row.id).run();
          mmdbResolved++;
          itemsUpdated++;
        } catch (err) {
          console.error('[cartographer] mmdb update failed:', err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.error('[cartographer] mmdb phase error:', err);
    }

    if (mmdbAttempted > 0) {
      outputs.push({
        type: 'insight',
        summary: `mmdb lookup: ${mmdbResolved}/${mmdbAttempted} threats geo-located via local GeoIP DB`,
        severity: 'info',
        details: { attempted: mmdbAttempted, resolved: mmdbResolved },
      });
    }

    // ─── Phase 1: ipinfo.io fallback for threats still missing country_code ───
    try {
      const { enrichThreatsGeo } = await import("../lib/geoip");
      const enrichResult = await enrichThreatsGeo(env.DB, env.CACHE, env.IPINFO_TOKEN);
      itemsUpdated += enrichResult.enriched;
    } catch (err) {
      console.error("[cartographer] geo enrichment error:", err);
    }

    // ─── Phase 2: Score hosting providers via Haiku AI ───
    const providers = await env.DB.prepare(
      `SELECT hp.id, hp.name, hp.asn, hp.active_threat_count, hp.total_threat_count,
              hp.avg_response_time, hp.trend_7d, hp.trend_30d
       FROM hosting_providers hp
       WHERE hp.total_threat_count > 0
         AND (
           hp.last_scored_at IS NULL
           OR hp.last_scored_at < datetime('now', '-6 hours')
           OR ABS(hp.active_threat_count - COALESCE(hp.last_score_threat_count, 0)) > 10
         )
       ORDER BY hp.active_threat_count DESC LIMIT 50`
    ).all<{
      id: string; name: string; asn: string | null;
      active_threat_count: number; total_threat_count: number;
      avg_response_time: number | null; trend_7d: number; trend_30d: number;
    }>();

    // Diagnostic counts — used for cartographer's per-run summary
    // logging only, never to drive logic. Wrap in cachedCount (30
    // min TTL) so we don't full-scan threats every cartographer
    // tick. PR-BL bumped from 300s → 1800s because the 5-min TTL
    // was too tight: cartographer runs hourly via dedicated cron +
    // ad-hoc scaleAgents instances, so consecutive ticks were
    // always missing the cache. With 30-min freshness the count
    // values are still well within "log-line tolerable" drift.
    // Hosting-providers count gets the same treatment for parity
    // even though that table is small.
    const totalProviders = { n: await cachedCount(env, 'count.hosting_providers.total', 1800, async () => {
      const row = await env.DB.prepare("SELECT COUNT(*) as n FROM hosting_providers").first<{ n: number }>();
      return row?.n ?? 0;
    }) };
    const threatsWithProvider = { n: await cachedCount(env, 'count.threats.with_provider', 1800, async () => {
      const row = await env.DB.prepare("SELECT COUNT(*) as n FROM threats WHERE hosting_provider_id IS NOT NULL").first<{ n: number }>();
      return row?.n ?? 0;
    }) };
    const threatsWithoutProvider = { n: await cachedCount(env, 'count.threats.without_provider', 1800, async () => {
      const row = await env.DB.prepare("SELECT COUNT(*) as n FROM threats WHERE hosting_provider_id IS NULL AND ip_address IS NOT NULL").first<{ n: number }>();
      return row?.n ?? 0;
    }) };
    // count.threats.active is a SHARED key (dashboard.ts, admin.ts also
    // read it) — pinned to 3600s across every caller so no caller's
    // shorter TTL forces a full-scan recompute of an entry another caller
    // already warmed. The three cartographer-only count.* keys above keep
    // their 1800s budget since nothing else reads them.
    const threatsTotal = { n: await cachedCount(env, 'count.threats.active', 3600, async () => {
      const row = await env.DB.prepare("SELECT COUNT(*) as n FROM threats WHERE status = 'active'").first<{ n: number }>();
      return row?.n ?? 0;
    }) };

    let haikuSuccessCount = 0;
    let haikuFailCount = 0;

    // Batch: threat type breakdowns for all providers
    const providerIds = providers.results.map(p => p.id);
    const allTypeBreakdowns = providerIds.length > 0 ? await env.DB.prepare(`
      SELECT hosting_provider_id, threat_type, COUNT(*) as count
      FROM threats
      WHERE hosting_provider_id IN (${providerIds.map(() => '?').join(',')})
      GROUP BY hosting_provider_id, threat_type
    `).bind(...providerIds).all<{ hosting_provider_id: string; threat_type: string; count: number }>() : { results: [] as { hosting_provider_id: string; threat_type: string; count: number }[] };

    const breakdownsByProvider = new Map<string, Record<string, number>>();
    for (const row of allTypeBreakdowns.results) {
      const existing = breakdownsByProvider.get(row.hosting_provider_id) ?? {};
      existing[row.threat_type] = row.count;
      breakdownsByProvider.set(row.hosting_provider_id, existing);
    }

    // Batch: campaign counts for all providers
    const allCampaignStats = providerIds.length > 0 ? await env.DB.prepare(`
      SELECT hosting_provider_id, COUNT(DISTINCT campaign_id) as campaign_count
      FROM threats
      WHERE hosting_provider_id IN (${providerIds.map(() => '?').join(',')})
        AND campaign_id IS NOT NULL
      GROUP BY hosting_provider_id
    `).bind(...providerIds).all<{ hosting_provider_id: string; campaign_count: number }>() : { results: [] as { hosting_provider_id: string; campaign_count: number }[] };

    const campaignCountByProvider = new Map<string, number>();
    for (const row of allCampaignStats.results) {
      campaignCountByProvider.set(row.hosting_provider_id, row.campaign_count);
    }

    // Lever #1b: pre-bucket providers into heuristic-skip and AI-worthy
    // before the loop. Heuristic-skip providers run per-item (no AI cost
    // to amortize). AI-worthy providers are batched 5-at-a-time through
    // scoreProvidersBatch so the static system prompt is sent once per
    // batch instead of once per provider — ~150 input tokens × (N-1)
    // calls saved per batch, plus per-item JSON wrapper overhead.
    type AiInput = {
      provider: typeof providers.results[number];
      threatTypes: Record<string, number>;
      campaignCount: number;
      repeatOffender: boolean;
    };
    const aiQueue: AiInput[] = [];

    for (const provider of providers.results) {
      itemsProcessed++;

      const threatTypes = breakdownsByProvider.get(provider.id) ?? {};
      const campaignCount = campaignCountByProvider.get(provider.id) ?? 0;
      const repeatOffender = campaignCount >= 3;

      // AI cost gate (added 2026-05-16 platform audit): only call Haiku
      // for providers that warrant actual reasoning. Providers with <5
      // active threats AND no campaign history produce a flat "looks
      // fine" 90-100 score that nobody reads — pure AI waste. Skip
      // straight to the heuristic score for those.
      const aiWorthScoring = provider.active_threat_count >= 5 || repeatOffender;

      if (!aiWorthScoring) {
        const heuristicScore = computeHeuristicScore(
          provider.active_threat_count,
          provider.total_threat_count,
          provider.avg_response_time,
        );
        try {
          await env.DB.prepare(
            "UPDATE hosting_providers SET reputation_score = ?, last_scored_at = datetime('now'), last_score = ?, last_score_threat_count = ? WHERE id = ?"
          ).bind(heuristicScore, heuristicScore, provider.active_threat_count, provider.id).run();
          itemsUpdated++;
        } catch (err) {
          console.error(`[cartographer] heuristic update failed for ${provider.id}:`, err);
        }
        continue;
      }

      aiQueue.push({ provider, threatTypes, campaignCount, repeatOffender });
    }

    // Lever #1b: 5-at-a-time batching. Larger batches risk maxTokens
    // truncation when several providers in the same batch score < 70
    // (verbose-response path) and the model hits the output cap.
    const CART_BATCH_SIZE = 5;
    for (let i = 0; i < aiQueue.length; i += CART_BATCH_SIZE) {
      const batch = aiQueue.slice(i, i + CART_BATCH_SIZE);
      const batchInput = batch.map((entry) => ({
        name: entry.provider.name,
        asn: entry.provider.asn,
        active_threats: entry.provider.active_threat_count,
        total_threats: entry.provider.total_threat_count,
        avg_response_time: entry.provider.avg_response_time,
        threat_types: entry.threatTypes,
        trend_7d: entry.provider.trend_7d,
        trend_30d: entry.provider.trend_30d,
      }));

      const batchResult = await scoreProvidersBatch(env, callCtx, batchInput);
      // Validate: success + array length matches input. A short or
      // malformed response forces per-provider fallback so we don't
      // silently drop scores on the floor.
      const batchOk =
        batchResult.success
        && Array.isArray(batchResult.data)
        && batchResult.data.length === batch.length;

      if (!batchOk) {
        // Batch failed or partial — drop back to per-provider scoring
        // for this batch. Preserves the old behavior exactly.
        if (batchResult.tokens_used) totalTokens += batchResult.tokens_used;
        for (const entry of batch) {
          await processOneAiProvider(entry, await scoreProvider(env, callCtx, {
            name: entry.provider.name,
            asn: entry.provider.asn,
            active_threats: entry.provider.active_threat_count,
            total_threats: entry.provider.total_threat_count,
            avg_response_time: entry.provider.avg_response_time,
            threat_types: entry.threatTypes,
            trend_7d: entry.provider.trend_7d,
            trend_30d: entry.provider.trend_30d,
          }));
        }
        continue;
      }

      if (batchResult.tokens_used) totalTokens += batchResult.tokens_used;
      if (batchResult.model) model = batchResult.model;
      // Per-provider post-processing using the batch results, by index.
      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j]!;
        const score = batchResult.data![j];
        await processOneAiProvider(entry, { success: true, data: score });
      }
    }

    // Per-provider post-processing. Used by both the per-call fallback
    // path (batch failure) and the per-index batch results. Identical
    // logic to the pre-Lever-#1b code path — only the upstream Haiku
    // call differs.
    async function processOneAiProvider(
      entry: AiInput,
      result: Awaited<ReturnType<typeof scoreProvider>>,
    ): Promise<void> {
      const { provider, campaignCount, repeatOffender } = entry;
      let reputationScore: number;

      if (result.success && result.data) {
        reputationScore = result.data.reputation_score;
        haikuSuccessCount++;

        if (reputationScore < 70 || repeatOffender) {
          // Lever #1: scoreProvider() prompt only emits prose fields
          // when score < 70. Synthesize a summary for the
          // repeat_offender + score >= 70 edge case.
          const reasoning = result.data.reasoning
            ?? `repeat offender (${campaignCount} campaigns) — score ${reputationScore}/100`;
          outputs.push({
            type: "insight",
            summary: `${provider.name}: reputation ${reputationScore}/100${repeatOffender ? ' [REPEAT OFFENDER]' : ''} — ${reasoning}`,
            severity: reputationScore < 30 ? "critical" : reputationScore < 50 ? "high" : reputationScore < 70 ? "medium" : "info",
            details: {
              provider: provider.name,
              score: reputationScore,
              risk_factors: result.data.risk_factors ?? [],
              response_assessment: result.data.response_assessment ?? null,
              campaign_count: campaignCount,
              repeat_offender: repeatOffender,
            },
            relatedProviderIds: [provider.id],
          });
        }
      } else {
        haikuFailCount++;
        reputationScore = computeHeuristicScore(
          provider.active_threat_count,
          provider.total_threat_count,
          provider.avg_response_time,
        );
        if (repeatOffender) reputationScore = Math.max(0, reputationScore - 15);
      }

      try {
        await env.DB.prepare(
          "UPDATE hosting_providers SET reputation_score = ?, last_scored_at = datetime('now'), last_score = ?, last_score_threat_count = ? WHERE id = ?"
        ).bind(reputationScore, reputationScore, provider.active_threat_count, provider.id).run();
        itemsUpdated++;
      } catch (err) {
        console.error(`[cartographer] update failed for ${provider.id}:`, err);
      }
    }

    console.log(`[cartographer] phase2: ${providers.results.length} providers eligible for scoring (gate: 6h OR ±10 threat delta)`);

    // ─── Phase 3: Email security posture scans — 50 brands per cycle, oldest first ───
    let emailScanned = 0;
    let emailErrors = 0;
    try {
      // Backfill canonical_domain from name for Tranco imports where domain is missing
      await env.DB.prepare(`
        UPDATE brands SET canonical_domain = LOWER(name)
        WHERE source = 'tranco_import' AND (canonical_domain IS NULL OR canonical_domain = '')
      `).run();

      // Include brands without canonical_domain by falling back to name
      const brandsToScan = await env.DB.prepare(`
        SELECT b.id, COALESCE(b.canonical_domain, LOWER(b.name)) AS domain, b.email_security_grade AS existing_grade
        FROM brands b
        WHERE (b.canonical_domain IS NOT NULL OR b.name IS NOT NULL)
          AND (b.email_security_scanned_at IS NULL
               OR b.email_security_scanned_at < datetime('now', '-7 days'))
        ORDER BY b.email_security_scanned_at ASC NULLS FIRST
        LIMIT 50
      `).all<{ id: number; domain: string; existing_grade: string | null }>();

      for (const brand of brandsToScan.results) {
        try {
          const result = await runEmailSecurityScan(brand.domain);
          await saveEmailSecurityScan(env.DB, brand.id, result);
          await env.DB.prepare(`
            UPDATE brands
            SET email_security_score = ?, email_security_grade = ?, email_security_scanned_at = datetime('now')
            WHERE id = ?
          `).bind(result.score, result.grade, brand.id).run();

          // Detect grade changes and notify — boundary-crossing only.
          // Per NOTIFICATIONS_AUDIT.md Q4: classify grades into bands
          // {good: A+/A/B, neutral: C, bad: D/F} and only fire when the
          // transition crosses good↔bad. C↔anything is silent.
          // metadata.brand_id is required for the dedup key in
          // createNotification — without it we got 3× duplicate rows
          // per brand before this fix.
          if (brand.existing_grade && brand.existing_grade !== result.grade) {
            const prev = gradeBand(brand.existing_grade);
            const next = gradeBand(result.grade);
            const crossed =
              (prev === 'good' && next === 'bad') ||
              (prev === 'bad' && next === 'good');
            if (crossed) {
              const dropped = next === 'bad';
              const brandName = await env.DB.prepare('SELECT name FROM brands WHERE id = ?')
                .bind(brand.id).first<{ name: string }>();
              try {
                await createNotification(env, {
                  // N1: explicit tenant audience — email security grade
                  // change is a brand event. brandId in metadata routes
                  // to the brand's subscribers; default super-admins are
                  // excluded unless they opted-in via show_tenant_notifications.
                  audience: 'tenant',
                  brandId: String(brand.id),
                  type: 'email_security_change',
                  title: `${brandName?.name ?? brand.domain} email security ${dropped ? 'degraded' : 'improved'}`,
                  message: `Grade changed from ${brand.existing_grade} to ${result.grade}`,
                  severity: dropped ? 'high' : 'info',
                  link: `/brands/${brand.id}`,
                  metadata: { brand_id: brand.id, prev_grade: brand.existing_grade, new_grade: result.grade },
                });
              } catch (notifErr) {
                console.error('[cartographer] notification error:', notifErr);
              }
            }
          }

          // N6a — intel_recommended_action: DMARC policy still 'none'
          // is the canonical "you're not protected; do this" hygiene
          // call-out per §11.1. Group key dedup keeps this firing at
          // most every 3 days per brand (per registry).
          if (result.dmarc.exists && result.dmarc.policy === 'none') {
            const fullName = await env.DB.prepare('SELECT name FROM brands WHERE id = ?')
              .bind(brand.id).first<{ name: string }>();
            try {
              const rendered = renderIntelRecommendedAction({
                brand_id: String(brand.id),
                brand_name: fullName?.name ?? brand.domain,
                check_id: 'dmarc_policy_none',
                what: `DMARC policy is set to none on ${brand.domain}`,
                why_it_matters: `A DMARC policy of "none" means the domain reports impersonation attempts but doesn't block them. Attackers can spoof your email with no enforcement.`,
                recommended_action: `Move DMARC to quarantine, then to reject after monitoring DMARC reports for two weeks. Documentation: https://dmarc.org/overview/`,
                link: `/brands/${brand.id}?tab=email`,
              });
              await emitIntelNotification(env, 'intel_recommended_action', rendered);
            } catch (intelErr) {
              console.error('[cartographer] intel notification error:', intelErr);
            }
          }

          emailScanned++;
          itemsUpdated++;
        } catch (e) {
          console.error(`[cartographer] email security scan failed for ${brand.domain}:`, e);
          emailErrors++;
        }
      }

      outputs.push({
        type: "diagnostic",
        summary: `Email security: ${emailScanned} brands scanned, ${emailErrors} errors`,
        severity: emailErrors > 5 ? "medium" : "info",
        details: { email_scanned: emailScanned, email_errors: emailErrors },
      });
    } catch (e) {
      console.error("[cartographer] email security phase error:", e);
    }

    // ─── Phase 4: Geo-enrich DMARC source IPs — up to 10 per cycle ───
    let dmarcGeoEnriched = 0;
    try {
      const unenrichedIps = await env.DB.prepare(`
        SELECT DISTINCT source_ip FROM dmarc_report_records
        WHERE country_code IS NULL AND source_ip IS NOT NULL
        LIMIT 10
      `).all<{ source_ip: string }>();

      if (unenrichedIps.results.length > 0) {
        const { batchGeoLookup, isPrivateIP } = await import("../lib/geoip");
        const ips = unenrichedIps.results.map(r => r.source_ip).filter(ip => !isPrivateIP(ip));
        const { results: geoMap } = await batchGeoLookup(ips, env.CACHE, env.IPINFO_TOKEN);

        for (const [ip, geo] of geoMap.entries()) {
          await env.DB.prepare(`
            UPDATE dmarc_report_records
            SET country_code = ?, org = ?, asn = ?, lat = ?, lng = ?
            WHERE source_ip = ? AND country_code IS NULL
          `).bind(geo.countryCode, geo.org, geo.as, geo.lat, geo.lng, ip).run();
          dmarcGeoEnriched++;
        }

        // Mark private/bogon IPs so they exit the queue
        for (const { source_ip } of unenrichedIps.results) {
          if (isPrivateIP(source_ip)) {
            await env.DB.prepare(
              `UPDATE dmarc_report_records SET country_code = 'PRIV' WHERE source_ip = ? AND country_code IS NULL`
            ).bind(source_ip).run();
          }
        }
      }
    } catch (e) {
      console.error("[cartographer] DMARC geo enrichment error:", e);
    }

    // ─── Phase 5: Aggregate provider threat stats across time periods ───
    const statsCreated = await aggregateProviderStats(env);
    itemsCreated += statsCreated;

    // Emit diagnostic output so cartographer never shows 0 outputs silently
    outputs.push({
      type: "diagnostic",
      summary: `Cartographer: ${batchGeoResponded} ip-api responses (${batchGeoLocated} geo-located), ${providers.results.length} providers scored (${haikuSuccessCount} AI, ${haikuFailCount} heuristic), ${statsCreated} stat entries, ${emailScanned} email security scans, ${dmarcGeoEnriched} DMARC IPs geo-enriched, ${threatsWithProvider?.n ?? 0}/${threatsTotal?.n ?? 0} threats have provider`,
      severity: providers.results.length === 0 ? "medium" : "info",
      details: {
        ip_api_enriched: batchGeoResponded,
        ip_api_geo_located: batchGeoLocated,
        rdap_enriched: rdapEnriched,
        providers_with_threats: providers.results.length,
        total_providers: totalProviders?.n ?? 0,
        haiku_scored: haikuSuccessCount,
        heuristic_scored: haikuFailCount,
        stats_entries: statsCreated,
        email_security_scanned: emailScanned,
        email_security_errors: emailErrors,
        dmarc_geo_enriched: dmarcGeoEnriched,
        threats_total_active: threatsTotal?.n ?? 0,
        threats_with_provider: threatsWithProvider?.n ?? 0,
        threats_without_provider_but_with_ip: threatsWithoutProvider?.n ?? 0,
        // Lever #6: batches API metrics
        batch_poll: batchPollSummary,
        batch_submit: batchSubmitSummary,
      },
    });

    return {
      itemsProcessed,
      itemsCreated,
      itemsUpdated,
      output: { providersScored: providers.results.length, statsEntries: statsCreated, ipApiBatchEnriched: batchGeoResponded, ipApiGeoLocated: batchGeoLocated },
      model,
      tokensUsed: totalTokens,
      agentOutputs: outputs,
    };
  },
};

function computeHeuristicScore(
  activeThreats: number,
  totalThreats: number,
  avgResponseTime: number | null,
): number {
  let score = 100;

  // Penalize for active threats
  if (activeThreats > 100) score -= 40;
  else if (activeThreats > 50) score -= 30;
  else if (activeThreats > 10) score -= 20;
  else if (activeThreats > 0) score -= 10;

  // Penalize for slow response
  if (avgResponseTime !== null) {
    if (avgResponseTime > 168) score -= 20;      // > 1 week
    else if (avgResponseTime > 72) score -= 15;   // > 3 days
    else if (avgResponseTime > 24) score -= 10;   // > 1 day
  }

  // Penalize for high total volume
  if (totalThreats > 1000) score -= 15;
  else if (totalThreats > 100) score -= 10;

  return Math.max(0, Math.min(100, score));
}

// Band classification for the boundary-crossing notification policy.
// See NOTIFICATIONS_AUDIT.md Q4: only good↔bad transitions notify.
function gradeBand(g: string): 'good' | 'neutral' | 'bad' {
  if (g === 'A+' || g === 'A' || g === 'B') return 'good';
  if (g === 'D' || g === 'F') return 'bad';
  return 'neutral';
}

// ─── Geopolitical campaign escalation ─────────────────────────────

interface GeoCampaign {
  id: string;
  name: string;
  conflict: string;
  adversary_countries: string;
  adversary_asns: string;
}

// Cache active campaigns for the duration of a single run
let _geoCampaignCache: GeoCampaign[] | null = null;

async function getActiveGeoCampaigns(db: D1Database): Promise<GeoCampaign[]> {
  if (_geoCampaignCache) return _geoCampaignCache;
  const result = await db.prepare(
    "SELECT id, name, conflict, adversary_countries, adversary_asns FROM geopolitical_campaigns WHERE status = 'active'"
  ).all<GeoCampaign>();
  _geoCampaignCache = result.results;
  return _geoCampaignCache;
}

/**
 * Build the prepared statements for a single geopolitical escalation without
 * executing them. The caller queues the returned statements into a D1 batch.
 *
 * Pure function — no DB I/O. Campaigns must be passed in (cached by the caller).
 */
function buildGeopoliticalEscalationStatements(
  db: D1Database,
  campaigns: GeoCampaign[],
  threatId: string,
  countryCode: string | null,
  asn: string | null,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];

  for (const campaign of campaigns) {
    const adversaryCountries: string[] = JSON.parse(campaign.adversary_countries || '[]');
    const adversaryASNs: string[] = JSON.parse(campaign.adversary_asns || '[]');

    const countryMatch = countryCode && adversaryCountries.includes(countryCode);
    const asnMatch = asn && adversaryASNs.some(a => asn.includes(a));

    if (countryMatch || asnMatch) {
      // Auto-escalate severity and link to campaign
      stmts.push(db.prepare(
        `UPDATE threats SET severity = 'critical',
           campaign_id = COALESCE(campaign_id, (SELECT campaign_id FROM geopolitical_campaign_links WHERE geopolitical_campaign_id = ? LIMIT 1)),
           confidence_score = MAX(COALESCE(confidence_score, 0), 90)
         WHERE id = ?`
      ).bind(campaign.id, threatId));

      // Create geopolitical alert. alert_type + severity values come
      // from the registry and CHECK constraint (migration 0121) — no
      // string literals at the call site. Severity is lowercase per
      // the migration 0120 convention.
      const geoTypeDef = ALERT_TYPES.find((t) => t.key === 'geopolitical_threat')!;
      stmts.push(db.prepare(
        `INSERT INTO alerts (id, brand_id, user_id, alert_type, severity, title, summary, source_type, source_id, created_at, updated_at)
         VALUES (?, '__system__', '__system__', ?, ?, ?, ?, 'geopolitical_campaign', ?, datetime('now'), datetime('now'))`
      ).bind(
        crypto.randomUUID(),
        geoTypeDef.key,
        geoTypeDef.defaultSeverity,
        `Nation-state threat: ${campaign.name}`,
        `Threat from ${countryCode ?? 'unknown'} infrastructure (ASN: ${asn ?? 'unknown'}) detected. Campaign: ${campaign.conflict}`,
        campaign.id,
      ));

      break; // One escalation per threat is sufficient
    }
  }

  return stmts;
}

/**
 * Aggregate provider threat stats across time periods.
 * Merged from the hosting-provider-analysis agent — computes stats for
 * today, 7d, 30d, and all-time, writing to provider_threat_stats table.
 */
async function aggregateProviderStats(env: { DB: D1Database }): Promise<number> {
  const db = env.DB;
  let totalEntries = 0;

  const periods = [
    { key: "today", where: "created_at >= date('now', 'start of day')", priorWhere: "created_at >= date('now', '-1 day', 'start of day') AND created_at < date('now', 'start of day')" },
    { key: "7d", where: "created_at >= date('now', '-7 days')", priorWhere: "created_at >= date('now', '-14 days') AND created_at < date('now', '-7 days')" },
    { key: "30d", where: "created_at >= date('now', '-30 days')", priorWhere: "created_at >= date('now', '-60 days') AND created_at < date('now', '-30 days')" },
    { key: "all", where: "1=1", priorWhere: null as string | null },
  ];

  // Pre-load provider names to avoid N+1 in the stats loop
  const providerNameRows = await db.prepare(
    "SELECT id, name FROM hosting_providers"
  ).all<{ id: string; name: string }>();
  const providerNameMap = new Map<string, string>();
  for (const r of providerNameRows.results) {
    providerNameMap.set(r.id, r.name);
  }

  for (const period of periods) {
    // Phase 2 D1 migration: read aggregates from threat_cube_provider
    // instead of scanning the threats table. The cube is hour-bucketed
    // with denormalized threat_type + severity, so SUM(CASE...)
    // expressions pivot cleanly per provider. Pre-migration this single
    // 30d query alone consumed ~708k rows_read/hour at ~6 calls/hour
    // (see diagnostics 2026-05-12 query #7).
    //
    // Note: country_code is NOT on the cube — provider_threat_stats.top_countries
    // is rebuilt below by a small bounded query keyed off the top-50 provider IDs
    // we just resolved, which is way cheaper than the original global GROUP BY.
    const cubePeriodWhere = period.key === "all"
      ? "1=1"
      : period.key === "today"
        ? "hour_bucket >= date('now', 'start of day')"
        : period.key === "7d"
          ? "hour_bucket >= datetime('now', '-7 days')"
          : "hour_bucket >= datetime('now', '-30 days')";

    const providerRows = await db.prepare(`
      SELECT
        hosting_provider_id,
        SUM(threat_count) as threat_count,
        SUM(CASE WHEN severity = 'critical' THEN threat_count ELSE 0 END) as critical_count,
        SUM(CASE WHEN severity = 'high' THEN threat_count ELSE 0 END) as high_count,
        SUM(CASE WHEN threat_type = 'phishing' THEN threat_count ELSE 0 END) as phishing_count,
        SUM(CASE WHEN threat_type = 'malware_distribution' THEN threat_count ELSE 0 END) as malware_count
      FROM threat_cube_provider
      WHERE ${cubePeriodWhere}
      GROUP BY hosting_provider_id
      ORDER BY threat_count DESC
      LIMIT 50
    `).all<{
      hosting_provider_id: string; threat_count: number;
      critical_count: number; high_count: number;
      phishing_count: number; malware_count: number;
    }>();

    // Resolve countries only for the 50 providers we actually care about.
    // Bounded IN-list keeps the scan small even though it touches the
    // threats table — vs the pre-migration query which scanned the full
    // 30d window across ALL providers.
    const countryMap = new Map<string, string>();
    if (providerRows.results.length > 0) {
      const ids = providerRows.results.map(r => r.hosting_provider_id);
      const placeholders = ids.map(() => "?").join(",");
      const countryRows = await db.prepare(`
        SELECT hosting_provider_id,
               GROUP_CONCAT(DISTINCT country_code) as countries
        FROM threats
        WHERE hosting_provider_id IN (${placeholders})
          AND country_code IS NOT NULL
          AND ${period.where}
        GROUP BY hosting_provider_id
      `).bind(...ids).all<{ hosting_provider_id: string; countries: string | null }>();
      for (const r of countryRows.results) {
        countryMap.set(r.hosting_provider_id, r.countries ?? "");
      }
    }

    // Get prior period for trend calculation — also from the cube.
    const priorMap = new Map<string, number>();
    if (period.priorWhere) {
      const cubePriorWhere = period.key === "today"
        ? "hour_bucket >= date('now', '-1 day', 'start of day') AND hour_bucket < date('now', 'start of day')"
        : period.key === "7d"
          ? "hour_bucket >= datetime('now', '-14 days') AND hour_bucket < datetime('now', '-7 days')"
          : "hour_bucket >= datetime('now', '-60 days') AND hour_bucket < datetime('now', '-30 days')";

      const priorRows = await db.prepare(`
        SELECT hosting_provider_id, SUM(threat_count) as count
        FROM threat_cube_provider
        WHERE ${cubePriorWhere}
        GROUP BY hosting_provider_id
      `).all<{ hosting_provider_id: string; count: number }>();
      for (const r of priorRows.results) {
        priorMap.set(r.hosting_provider_id, r.count);
      }
    }

    // Build all upserts for this period and flush in one batch.
    const periodWrites: D1PreparedStatement[] = [];
    for (const row of providerRows.results) {
      const priorCount = priorMap.get(row.hosting_provider_id) ?? 0;
      let trendDirection = "stable";
      let trendPct = 0;

      if (priorCount > 0 && period.priorWhere) {
        trendPct = ((row.threat_count - priorCount) / priorCount) * 100;
        trendDirection = trendPct > 10 ? "up" : trendPct < -10 ? "down" : "stable";
      } else if (row.threat_count > 0 && priorCount === 0 && period.priorWhere) {
        trendDirection = "up";
        trendPct = 100;
      }

      const countryCodes = (countryMap.get(row.hosting_provider_id) ?? "").split(",").filter(Boolean);
      const topCountries = countryCodes.slice(0, 5).map(c => ({ country_code: c, count: 1 }));

      const providerName = providerNameMap.get(row.hosting_provider_id) ?? row.hosting_provider_id;

      const id = crypto.randomUUID();
      periodWrites.push(db.prepare(`
        INSERT INTO provider_threat_stats
          (id, provider_name, period, threat_count, critical_count, high_count, phishing_count, malware_count, top_countries, trend_direction, trend_pct, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(provider_name, period) DO UPDATE SET
          threat_count = excluded.threat_count,
          critical_count = excluded.critical_count,
          high_count = excluded.high_count,
          phishing_count = excluded.phishing_count,
          malware_count = excluded.malware_count,
          top_countries = excluded.top_countries,
          trend_direction = excluded.trend_direction,
          trend_pct = excluded.trend_pct,
          computed_at = excluded.computed_at
        WHERE provider_threat_stats.threat_count   IS NOT excluded.threat_count
           OR provider_threat_stats.critical_count IS NOT excluded.critical_count
           OR provider_threat_stats.high_count     IS NOT excluded.high_count
           OR provider_threat_stats.phishing_count IS NOT excluded.phishing_count
           OR provider_threat_stats.malware_count  IS NOT excluded.malware_count
           OR provider_threat_stats.top_countries  IS NOT excluded.top_countries
           OR provider_threat_stats.trend_direction IS NOT excluded.trend_direction
           OR provider_threat_stats.trend_pct      IS NOT excluded.trend_pct
      `).bind(
        id, providerName, period.key,
        row.threat_count, row.critical_count, row.high_count,
        row.phishing_count, row.malware_count,
        JSON.stringify(topCountries), trendDirection, Math.round(trendPct * 10) / 10,
      ));
    }

    if (periodWrites.length > 0) {
      try {
        await db.batch(periodWrites);
        totalEntries += periodWrites.length;
      } catch (err) {
        console.error(`[cartographer] stats batch failed for period ${period.key}:`, err);
      }
    }
  }

  return totalEntries;
}
