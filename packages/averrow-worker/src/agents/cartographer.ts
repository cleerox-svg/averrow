/**
 * Cartographer Agent — Infrastructure mapping & provider reputation scoring.
 *
 * Runs every 15 minutes (clearing enrichment backlog) and on Sentinel trigger.
 * Maps threat infrastructure to hosting providers and computes
 * reputation scores with a deterministic heuristic
 * (`computeHeuristicScore`) — no AI call since AI_STRATEGY_2026-10
 * Phase 1 (Batch B).
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
import { runEmailSecurityScan, saveEmailSecurityScan } from "../email-security";
import { createNotification } from "../lib/notifications";
import { emitIntelNotification, renderIntelRecommendedAction } from "../lib/intel-templates";
import { PRIVATE_IP_SQL_FILTER } from "../lib/geoip";
import { cachedCount, peekCount } from "../lib/cached-count";
import { cachedValue } from "../lib/cached-value";
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

/**
 * Render a Phase 2 diagnostic counter for the per-run summary line.
 * `null` means "no instance has warmed this counter yet" — render it as
 * `?` rather than `0`, so an operator reading the summary can't mistake
 * an un-warmed cache for a collapsed count.
 */
function fmtDiagCount(n: number | null): string {
  return n === null ? "?" : String(n);
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
  // for the pathological one. Cart's normal scoring/email/stats work doesn't
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
  // 0.5 (GeoIP MMDB), 1 (ipinfo fallback), 2 (heuristic provider
  // reputation scoring — top 50 providers), 3 (email security scans), 4 (DMARC
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
    const { env } = ctx;

    let itemsProcessed = 0;
    let itemsUpdated = 0;
    let itemsCreated = 0;
    const outputs: AgentOutputEntry[] = [];

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
    // Give-up state is `geo_mmdb_checked_at` (migration 0263), NOT
    // `enrichment_attempts`. That column is Phase 0's ip-api budget and
    // is baked into the partial index `idx_threats_carto_phase0`
    // (`enrichment_attempts < 5`). Borrowing it here meant every MMDB
    // miss spent one of ip-api's five retries, cutting Phase 0's real
    // budget to ~2 and marching un-geolocated rows to the `< 8` cap in
    // ~2h — the 4,740-row pile at exactly attempts=8 observed
    // 2026-09-11, 65% of it dataplane/scanning (a feed that inserts
    // malicious_domain=NULL and so never touched the DNS pipeline).
    //
    // One consultation per threat is also all that is informative:
    // geo_ip_ranges refreshes weekly and lib/geoip-mmdb.ts KV-caches
    // negative answers behind NULL_SENTINEL, so attempts 2..8 re-read
    // the same cached miss and learn nothing.
    let mmdbAttempted = 0;
    let mmdbResolved = 0;
    let mmdbPartial = 0;
    let mmdbBudgetHit = false;
    try {
      const { lookupGeoMmdb } = await import("../lib/geoip-mmdb");
      // Fetch threats that came out of Phase 0 with an IP but no
      // lat/lng and that GeoLite2 hasn't been asked about yet.
      // Bounded by MMDB_MAX_PER_RUN so a deep backlog doesn't blow our
      // CPU budget — Phase 1 (ipinfo) and the next cartographer tick
      // continue draining. Served by idx_threats_mmdb_pending.
      const MMDB_MAX_PER_RUN = 500;
      // Wall-clock guard. This loop is the only unbounded sequential
      // await chain left in the agent (cross-DB range scan + write per
      // row); without a budget it is the long tail that puts ~9% of
      // runs past the 180-min reap ceiling while the median run is
      // ~6 min. Same pattern as enrichIpBatch's LOOP_CEILING_MS.
      const MMDB_BUDGET_MS = 90_000;
      const mmdbStart = Date.now();
      const stuckRows = await env.DB.prepare(`
        SELECT id, ip_address FROM threats
        WHERE ip_address IS NOT NULL AND ip_address != ''
          AND lat IS NULL
          AND geo_mmdb_checked_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `).bind(MMDB_MAX_PER_RUN).all<{ id: string; ip_address: string }>();

      // Marker writes are batched rather than issued one .run() per
      // row — up to 500 sequential single-row UPDATEs was both the
      // slowest part of the loop and a needless writer hold.
      const mmdbWrites: D1PreparedStatement[] = [];

      for (const row of stuckRows.results) {
        if (Date.now() - mmdbStart > MMDB_BUDGET_MS) {
          mmdbBudgetHit = true;
          break;
        }
        mmdbAttempted++;
        const geo = await lookupGeoMmdb(env, row.ip_address);

        if (geo && geo.lat != null && geo.lng != null) {
          // Full hit — coordinates available.
          mmdbWrites.push(env.DB.prepare(`
            UPDATE threats SET
              lat = COALESCE(lat, ?),
              lng = COALESCE(lng, ?),
              country_code = COALESCE(country_code, ?),
              asn = COALESCE(asn, ?),
              geo_mmdb_checked_at = datetime('now'),
              enriched_at = CASE WHEN enriched_at IS NULL THEN datetime('now') ELSE enriched_at END
            WHERE id = ?
          `).bind(geo.lat, geo.lng, geo.countryCode, geo.asn, row.id));
          mmdbResolved++;
          itemsUpdated++;
          continue;
        }

        if (geo && (geo.countryCode != null || geo.asn != null)) {
          // Partial hit — GeoLite2 covers the range at country/ASN
          // level but ships no coordinates (common for allocated-but-
          // unmapped scanner ranges, i.e. exactly the dataplane
          // population). Previously discarded wholesale. It doesn't
          // reach threat_cube_geo (that needs lat/lng) but it does fix
          // country_code and ASN-based provider attribution, which we
          // already paid the lookup to obtain. enriched_at stays NULL —
          // the row has no coordinates, so it must not graduate to the
          // stuck pile (see the Phase 0 note above).
          mmdbWrites.push(env.DB.prepare(`
            UPDATE threats SET
              country_code = COALESCE(country_code, ?),
              asn = COALESCE(asn, ?),
              geo_mmdb_checked_at = datetime('now')
            WHERE id = ?
          `).bind(geo.countryCode, geo.asn, row.id));
          mmdbPartial++;
          itemsUpdated++;
          continue;
        }

        // True miss — GeoLite2 doesn't cover this IP. Stamp the marker
        // so we never ask again, and leave enrichment_attempts alone so
        // Phase 0 keeps its full ip-api budget.
        mmdbWrites.push(env.DB.prepare(`
          UPDATE threats SET geo_mmdb_checked_at = datetime('now') WHERE id = ?
        `).bind(row.id));
      }

      if (mmdbWrites.length > 0) {
        const MMDB_FLUSH_CHUNK = 100;
        for (let i = 0; i < mmdbWrites.length; i += MMDB_FLUSH_CHUNK) {
          try {
            await env.DB.batch(mmdbWrites.slice(i, i + MMDB_FLUSH_CHUNK));
          } catch (err) {
            console.error('[cartographer] mmdb flush failed:', err instanceof Error ? err.message : err);
          }
        }
      }
    } catch (err) {
      console.error('[cartographer] mmdb phase error:', err);
    }

    if (mmdbAttempted > 0) {
      outputs.push({
        type: 'insight',
        summary: `mmdb lookup: ${mmdbResolved}/${mmdbAttempted} threats geo-located via local GeoIP DB (${mmdbPartial} country/ASN only)${mmdbBudgetHit ? ' — wall-clock budget hit, truncated' : ''}`,
        severity: 'info',
        details: {
          attempted: mmdbAttempted,
          resolved: mmdbResolved,
          partial: mmdbPartial,
          budget_hit: mmdbBudgetHit,
        },
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

    // ─── Phase 2: Score hosting providers (deterministic heuristic) ───
    // `last_score` (migration 0078) is the score this provider got on its
    // previous scoring pass — the hosting_providers write further down sets reputation_score
    // and last_score with the same value, so reading it BEFORE the
    // overwrite gives the prior score for the insight-emission gate.
    const providers = await env.DB.prepare(
      `SELECT hp.id, hp.name, hp.asn, hp.active_threat_count, hp.total_threat_count,
              hp.avg_response_time, hp.trend_7d, hp.trend_30d, hp.last_score
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
      avg_response_time: number | null; trend_7d: number | null; trend_30d: number | null;
      last_score: number | null;
    }>();

    // Diagnostic counts — used for cartographer's per-run summary
    // logging only (see the summary line + agent_outputs details
    // below), never to drive logic.
    //
    // PR-BV root cause — SUPERSEDES the PR-BU "TTL was too short"
    // theory. The misses were never TTL expiry:
    //
    //   * PR-BU raised the TTL 1800s → 21600s (12×) on 2026-07-29. The
    //     diagnostics attribution for
    //     `SELECT COUNT(*) as n FROM threats WHERE hosting_provider_id
    //      IS NOT NULL` did not move: 60.1M → 62.3M rows/24h. A
    //     12× TTL increase cannot leave an expiry-driven miss pattern
    //     unchanged, so expiry was not the driver.
    //   * The observed 100 executions/24h tracks cartographer's
    //     INVOCATION count (~3-4/h — see the agent_outputs timeline via
    //     /api/internal/cartographer-health), not the TTL-boundary
    //     count (~4/day at 6h). Every invocation recomputes.
    //
    // The mechanism is the herd, and it is structural: `cachedCount` is
    // a read-through cache with NO single-flight. Phase 2 runs on every
    // cartographer instance — the dedicated `9 * * * *` maintenance
    // cron, the 1-3 FC scaleAgents backlog instances, and the
    // geo_backlog instance — and they overlap, so each one reads the key
    // before any of them has written it. No TTL suppresses that.
    //
    // Two-part fix, neither of which depends on out-TTL-ing the herd:
    //
    //   1. Stop issuing the 622K-row threats scan at all. "threats with
    //      a provider" is exactly SUM(hosting_providers.total_threat_count)
    //      — a maintained pre-computed column (lib/provider-counts.ts,
    //      CLAUDE.md §8 "Pre-computed columns"). One 11.6K-row pass over
    //      hosting_providers yields the provider count AND the
    //      with-provider total, so it stays correct even when every
    //      instance misses. (Orphan guard: cartographer-health reports
    //      legacy_hosting_provider_ids = 0, i.e. no threat points at a
    //      deleted provider row, so the SUM and the COUNT agree.)
    //   2. For the counters with no pre-computed source, only ONE
    //      designated instance may compute. The scheduled maintenance
    //      run (triggeredBy 'cron' / manual) computes; FC's backlog
    //      instances peek at KV and log `null` rather than racing.
    //
    // Rule of thumb for future counters here: a raw `threats` scan in
    // this block is only ever allowed on the maintenance instance.
    const DIAG_COUNT_TTL = 21600; // 6h — log-line drift-tolerant
    // FC dispatches backlog/geo-backlog instances with triggeredBy
    // 'flight_control' (agents/flightControl.ts scaleAgents); the
    // dedicated `9 * * * *` cron dispatches with 'cron'
    // (cron/orchestrator.ts). Anything that is not an FC backlog
    // instance is the single designated computer for this tick.
    const isMaintenanceRun = ctx.triggeredBy !== 'flight_control';

    // Providers rollup: COUNT + SUM in one 11.6K-row pass over
    // hosting_providers, replacing the 622K-row threats scan. Cheap
    // enough that it stays ungated — even a full herd miss costs
    // ~1.2M rows/day instead of 62.3M.
    const providerRollup = await cachedValue<{ providers: number; with_provider: number }>(
      env, 'count.hosting_providers.rollup', DIAG_COUNT_TTL, async () => {
        const row = await env.DB.prepare(
          `SELECT COUNT(*) AS providers,
                  COALESCE(SUM(total_threat_count), 0) AS with_provider
           FROM hosting_providers`
        ).first<{ providers: number; with_provider: number }>();
        return { providers: row?.providers ?? 0, with_provider: row?.with_provider ?? 0 };
      });
    const totalProviders: { n: number | null } = { n: providerRollup.providers };
    const threatsWithProvider: { n: number | null } = { n: providerRollup.with_provider };

    // No pre-computed source for "has an IP but no provider yet", so it
    // stays a raw threats index scan — restricted to the maintenance
    // instance. Backlog instances peek (never compute).
    const threatsWithoutProvider: { n: number | null } = {
      n: isMaintenanceRun
        ? await cachedCount(env, 'count.threats.without_provider', DIAG_COUNT_TTL, async () => {
            const row = await env.DB.prepare("SELECT COUNT(*) as n FROM threats WHERE hosting_provider_id IS NULL AND ip_address IS NOT NULL").first<{ n: number }>();
            return row?.n ?? 0;
          })
        : await peekCount(env, 'count.threats.without_provider', DIAG_COUNT_TTL),
    };

    // count.threats.active is a SHARED key — handlers/dashboard.ts and
    // handlers/admin/stats.ts both read AND write it at the same 21600s
    // TTL, and navigator pre-warms the dashboard every 5 min. Those are
    // the callers that own it. Cartographer now only PEEKS: it never
    // computes, so it can never add a 1.1M-row scan of its own, and the
    // owners' behaviour is untouched (same key, same envelope, same
    // TTL — peekCount only reads). When nothing has warmed it the log
    // line shows `null`, which is honest; it is a log line.
    const threatsTotal: { n: number | null } = {
      n: await peekCount(env, 'count.threats.active', DIAG_COUNT_TTL),
    };

    let insightsEmitted = 0;

    // Batch: threat type breakdowns for all providers
    const providerIds = providers.results.map(p => p.id);
    const allTypeBreakdowns = providerIds.length > 0 ? await env.DB.prepare(`
      SELECT hosting_provider_id, threat_type, COUNT(*) as count
      FROM threats
      WHERE hosting_provider_id IN (${providerIds.map(() => '?').join(',')})
      GROUP BY hosting_provider_id, threat_type
    `).bind(...providerIds).all<{ hosting_provider_id: string; threat_type: string | null; count: number }>() : { results: [] as { hosting_provider_id: string; threat_type: string | null; count: number }[] };

    const breakdownsByProvider = new Map<string, Record<string, number>>();
    for (const row of allTypeBreakdowns.results) {
      if (!row.threat_type) continue;
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

    // One deterministic pass per provider. computeHeuristicScore is the
    // sole score (AI_STRATEGY_2026-10 Phase 1 removed the Haiku
    // scoreProvider / scoreProvidersBatch path and the Message Batches
    // ingest that could overwrite it). An insight row is emitted only on
    // a meaningful change — see shouldEmitProviderInsight — so a stable
    // bad provider does not re-announce itself every 6h.
    for (const provider of providers.results) {
      itemsProcessed++;

      const threatTypes = breakdownsByProvider.get(provider.id) ?? {};
      const campaignCount = campaignCountByProvider.get(provider.id) ?? 0;
      const { score, riskFactors, repeatOffender } = computeHeuristicScore({
        activeThreats: provider.active_threat_count,
        totalThreats: provider.total_threat_count,
        avgResponseTime: provider.avg_response_time,
        campaignCount,
        trend7d: provider.trend_7d,
        trend30d: provider.trend_30d,
      });

      if (shouldEmitProviderInsight(score, provider.last_score, repeatOffender)) {
        const topTypes = topThreatTypes(threatTypes, 3);
        insightsEmitted++;
        outputs.push({
          type: "insight",
          summary: renderProviderInsightSummary({
            name: provider.name,
            score,
            repeatOffender,
            activeThreats: provider.active_threat_count,
            totalThreats: provider.total_threat_count,
            topTypes,
            campaignCount,
          }),
          severity: score < 30 ? "critical" : score < 50 ? "high" : score < 70 ? "medium" : "info",
          details: {
            provider: provider.name,
            score,
            previous_score: provider.last_score,
            risk_factors: riskFactors,
            top_threat_types: topTypes,
            active_threats: provider.active_threat_count,
            total_threats: provider.total_threat_count,
            campaign_count: campaignCount,
            repeat_offender: repeatOffender,
          },
          relatedProviderIds: [provider.id],
        });
      }

      try {
        await env.DB.prepare(
          "UPDATE hosting_providers SET reputation_score = ?, last_scored_at = datetime('now'), last_score = ?, last_score_threat_count = ? WHERE id = ?"
        ).bind(score, score, provider.active_threat_count, provider.id).run();
        itemsUpdated++;
      } catch (err) {
        console.error(`[cartographer] score update failed for ${provider.id}:`, err);
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
            SET email_security_score = ?, email_security_grade = ?, email_security_dmarc_policy = ?, email_security_scanned_at = datetime('now')
            WHERE id = ?
          `).bind(result.score, result.grade, result.dmarc.policy, brand.id).run();

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
    // KV self-throttle (Fix #5): Phase 5 runs on EVERY cartographer
    // instance — the dedicated `9 * * * *` maintenance cron AND the 1-3
    // backlog-drain instances Flight Control fires per hour via scaleAgents
    // (trigger='flight_control'). The provider rollup is identical work
    // regardless of which instance runs it, so re-running it on each
    // backlog instance was ~2x redundant (~28M reads/24h). Gate on a KV
    // stamp with a <hourly window so exactly one run per hour lands. We do
    // NOT hard-skip on trigger==='flight_control': if the maintenance cron
    // instance itself fails/delays, a backlog instance still refreshes
    // provider_threat_stats and it never goes stale.
    //
    // PR-BV: the single 50-min window was not enough, for the same
    // reason Phase 2's cachedCount wasn't (see that block). A
    // read-then-write KV stamp is not a lock: the overlapping instances
    // all read the stale stamp before any of them writes the new one, so
    // they all proceed. Diagnostics showed the 'all'-period country
    // rollup running 99×/24h against a 50-min throttle — one run per
    // INSTANCE, not one per window (41.5M rows/24h, the #2 read query
    // on the platform).
    //
    // Fix without losing the failover: make the window depend on who is
    // asking. The maintenance instance keeps the 50-min window and is
    // the normal writer. An FC backlog instance only takes over once the
    // stamp is BACKLOG-stale (2.5h), i.e. the maintenance path has
    // genuinely missed two consecutive hours. Steady state is one
    // Phase 5 run per hour; the failover the original comment protects
    // still fires, just two hours later instead of two minutes.
    let statsCreated = 0;
    const providerStatsWindowMs = isMaintenanceRun
      ? PROVIDER_STATS_THROTTLE_MS
      : PROVIDER_STATS_BACKLOG_THROTTLE_MS;
    const lastProviderStatsRun = await env.CACHE.get(PROVIDER_STATS_LAST_RUN_KEY);
    if (shouldRunProviderStats(lastProviderStatsRun, Date.now(), providerStatsWindowMs)) {
      statsCreated = await aggregateProviderStats(env);
      await env.CACHE.put(PROVIDER_STATS_LAST_RUN_KEY, String(Date.now()), { expirationTtl: 3600 });
    }
    itemsCreated += statsCreated;

    // Emit diagnostic output so cartographer never shows 0 outputs silently
    outputs.push({
      type: "diagnostic",
      summary: `Cartographer: ${batchGeoResponded} ip-api responses (${batchGeoLocated} geo-located), ${providers.results.length} providers scored (rules, ${insightsEmitted} insights), ${statsCreated} stat entries, ${emailScanned} email security scans, ${dmarcGeoEnriched} DMARC IPs geo-enriched, ${fmtDiagCount(threatsWithProvider.n)}/${fmtDiagCount(threatsTotal.n)} threats have provider`,
      // agent_outputs.severity CHECK allows critical/high/medium/low/info
      // (migration 0061).
      severity: providers.results.length === 0 ? "medium" : "info",
      details: {
        // No aiCalls* counters: cartographer makes no Anthropic call since
        // Phase 1, so it is no longer read by Flight Control's
        // platform_ai_calls_failing check or diagnostics ai_health.
        ip_api_enriched: batchGeoResponded,
        ip_api_geo_located: batchGeoLocated,
        rdap_enriched: rdapEnriched,
        providers_with_threats: providers.results.length,
        total_providers: totalProviders.n,
        heuristic_scored: providers.results.length,
        provider_insights_emitted: insightsEmitted,
        stats_entries: statsCreated,
        email_security_scanned: emailScanned,
        email_security_errors: emailErrors,
        dmarc_geo_enriched: dmarcGeoEnriched,
        // `null` here means "no instance has warmed this counter yet" —
        // deliberately NOT coerced to 0, which would read as "the count
        // really is zero" on a diagnostic panel. See the Phase 2 block.
        threats_total_active: threatsTotal.n,
        threats_with_provider: threatsWithProvider.n,
        threats_without_provider_but_with_ip: threatsWithoutProvider.n,
        diag_counts_computed_here: isMaintenanceRun,
      },
    });

    return {
      itemsProcessed,
      itemsCreated,
      itemsUpdated,
      output: { providersScored: providers.results.length, statsEntries: statsCreated, ipApiBatchEnriched: batchGeoResponded, ipApiGeoLocated: batchGeoLocated },
      tokensUsed: 0,
      agentOutputs: outputs,
    };
  },
};

// ─── Provider reputation heuristic (Phase 2) ──────────────────────

/** Campaign count at which a provider is a repeat offender (−15). */
export const REPEAT_OFFENDER_CAMPAIGNS = 3;
/** Score below which a provider is "bad" for the insight gate. */
export const PROVIDER_INSIGHT_SCORE_THRESHOLD = 70;
/** Minimum |score − last_score| that counts as a meaningful move. */
export const PROVIDER_INSIGHT_MIN_DELTA = 10;

export interface ProviderHeuristicInput {
  activeThreats: number;
  totalThreats: number;
  /** Hours. No writer populates hosting_providers.avg_response_time today, so this is normally null. */
  avgResponseTime: number | null;
  campaignCount?: number;
  trend7d?: number | null;
  trend30d?: number | null;
}

export interface ProviderHeuristicScore {
  /** 0–100, higher is better. */
  score: number;
  /** Names of the rules that fired, in evaluation order. */
  riskFactors: string[];
  repeatOffender: boolean;
}

/**
 * The sole provider reputation score. Pure — exported for tests.
 *
 *   start 100
 *   active threats   >100 −40 | >50 −30 | >10 −20 | >0 −10
 *   slow response    >168h −20 | >72h −15 | >24h −10   (no writer today)
 *   total volume     >1000 −15 | >100 −10
 *   repeat offender  campaigns >= 3 −15
 *   7d surge         trend_7d >= 10 AND trend_7d × 30/7 > 1.5 × trend_30d −10
 *   clamp 0..100
 */
export function computeHeuristicScore(input: ProviderHeuristicInput): ProviderHeuristicScore {
  const riskFactors: string[] = [];
  let score = 100;
  const penalize = (points: number, factor: string): void => {
    score -= points;
    riskFactors.push(factor);
  };

  const active = input.activeThreats;
  if (active > 100) penalize(40, "active_threats_over_100");
  else if (active > 50) penalize(30, "active_threats_over_50");
  else if (active > 10) penalize(20, "active_threats_over_10");
  else if (active > 0) penalize(10, "active_threats_present");

  const rt = input.avgResponseTime;
  if (rt !== null) {
    if (rt > 168) penalize(20, "slow_takedown_response_over_1w");
    else if (rt > 72) penalize(15, "slow_takedown_response_over_3d");
    else if (rt > 24) penalize(10, "slow_takedown_response_over_1d");
  }

  const total = input.totalThreats;
  if (total > 1000) penalize(15, "total_volume_over_1000");
  else if (total > 100) penalize(10, "total_volume_over_100");

  const repeatOffender = (input.campaignCount ?? 0) >= REPEAT_OFFENDER_CAMPAIGNS;
  if (repeatOffender) penalize(15, "repeat_offender");

  // 7-day run-rate projected to 30 days vs the actual 30-day count. The
  // absolute floor keeps a 1→3 blip on a tiny provider from reading as a
  // surge.
  const t7 = input.trend7d ?? 0;
  const t30 = input.trend30d ?? 0;
  if (t7 >= 10 && (t7 * 30) / 7 > 1.5 * t30) penalize(10, "surge_7d");

  return { score: Math.max(0, Math.min(100, score)), riskFactors, repeatOffender };
}

/**
 * Whether a scoring pass is worth an `insight` agent_outputs row.
 * Pure — exported for tests.
 *
 * Only providers that are bad (score < 70) or repeat offenders are
 * reportable at all, and of those only on a meaningful change: first
 * score ever, a move of >= 10 points, or a crossing of the 70 line in
 * either direction (a repeat offender recovering past 70 is news too).
 */
export function shouldEmitProviderInsight(
  score: number,
  lastScore: number | null,
  repeatOffender: boolean,
): boolean {
  if (!(score < PROVIDER_INSIGHT_SCORE_THRESHOLD || repeatOffender)) return false;
  if (lastScore === null) return true;
  if (Math.abs(score - lastScore) >= PROVIDER_INSIGHT_MIN_DELTA) return true;
  return (lastScore < PROVIDER_INSIGHT_SCORE_THRESHOLD) !== (score < PROVIDER_INSIGHT_SCORE_THRESHOLD);
}

/** Top-N threat types by count, ties broken alphabetically for stable output. */
export function topThreatTypes(breakdown: Record<string, number>, n: number): string[] {
  return Object.entries(breakdown)
    .filter(([type, count]) => type && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([type]) => type);
}

export function renderProviderInsightSummary(p: {
  name: string;
  score: number;
  repeatOffender: boolean;
  activeThreats: number;
  totalThreats: number;
  topTypes: string[];
  campaignCount: number;
}): string {
  const top = p.topTypes.length > 0 ? p.topTypes.join(", ") : "none";
  return `${p.name}: reputation ${p.score}/100${p.repeatOffender ? " [REPEAT OFFENDER]" : ""} — ${p.activeThreats} active / ${p.totalThreats} total; top types: ${top}; ${p.campaignCount} campaigns`;
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
// KV key + window for the Phase 5 provider-stats self-throttle (Fix #5).
// `cc:` matches the platform's KV cache namespace convention (lib/cached-count.ts);
// this is a raw last-run stamp, distinct from any cachedCount-managed `cc:count.*` key.
export const PROVIDER_STATS_LAST_RUN_KEY = "cc:cartographer.provider_stats.last_run";
// 50 min — comfortably under the ~hourly `9 * * * *` maintenance-cron cadence.
// Applies to the MAINTENANCE instance, which is the designated writer.
export const PROVIDER_STATS_THROTTLE_MS = 50 * 60_000;
// 150 min — the window an FC backlog instance must see elapse before it
// takes over Phase 5. A read-then-write KV stamp is not a lock, so
// overlapping instances sharing one window all read it stale and all run
// (observed: 99 runs/24h against a 50-min window). Giving backlog
// instances a 3× window means they only fire when the maintenance cron
// has genuinely missed two consecutive hours — preserving the failover
// the single-window design was protecting, without the herd.
export const PROVIDER_STATS_BACKLOG_THROTTLE_MS = 150 * 60_000;

/**
 * Pure decision for the Phase 5 provider-stats KV self-throttle.
 * Runs the aggregation when there is no prior stamp, when the stamp is
 * unparseable/garbage, or when the throttle window has elapsed.
 */
export function shouldRunProviderStats(
  lastRun: string | null,
  now: number,
  intervalMs: number,
): boolean {
  if (!lastRun) return true;
  const last = Number(lastRun);
  if (!Number.isFinite(last)) return true;
  return now - last > intervalMs;
}

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
