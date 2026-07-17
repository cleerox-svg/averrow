import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { PRIVATE_IP_SQL_FILTER } from '../lib/geoip';

interface BackfillParams {
  batchSize: number;
  startOffset: number;
}

interface BackfillEnv {
  DB: D1Database;
  CARTOGRAPHER_BACKFILL: Workflow;
}

export class CartographerBackfillWorkflow extends WorkflowEntrypoint<BackfillEnv, BackfillParams> {
  async run(event: WorkflowEvent<BackfillParams>, step: WorkflowStep) {
    const BATCH_SIZE = event.payload.batchSize ?? 500;

    // Step 1: Count total backlog
    const total = await step.do('count-backlog', async () => {
      const result = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM threats
        WHERE enriched_at IS NULL
          AND ip_address IS NOT NULL AND ip_address != ''
          ${PRIVATE_IP_SQL_FILTER}
      `).first<{ count: number }>();
      return result?.count ?? 0;
    });

    if (total === 0) {
      return { message: 'No backlog — all threats already enriched', total: 0 };
    }

    const totalBatches = Math.ceil(total / BATCH_SIZE);

    // Log start to agent_activity_log
    await step.do('log-start', async () => {
      await this.env.DB.prepare(`
        INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
        VALUES (?, 'cartographer', 'started', ?, ?, 'info')
      `).bind(
        crypto.randomUUID(),
        `Backfill workflow started: ${total} threats to enrich across ${totalBatches} batches`,
        JSON.stringify({ total, totalBatches, batchSize: BATCH_SIZE })
      ).run();
    });

    // Process each batch as a separate durable step
    // If any batch fails it retries automatically — completed batches are NOT re-run
    let totalEnriched = 0;

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const enriched = await step.do(
        `enrich-batch-${batchNum}`,
        {
          retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
          timeout: '5 minutes',
        },
        async () => {
          // Fetch next batch of unenriched threats — newest first so live activity
          // gets processed before ancient backlog of dead IPs.
          const threats = await this.env.DB.prepare(`
            SELECT id, ip_address, malicious_domain, hosting_provider_id, registration_date
            FROM threats
            WHERE enriched_at IS NULL
              AND ip_address IS NOT NULL AND ip_address != ''
              ${PRIVATE_IP_SQL_FILTER}
            ORDER BY created_at DESC
            LIMIT ?
          `).bind(BATCH_SIZE).all();

          if (threats.results.length === 0) return 0;

          // Batch IP enrichment via ip-api.com
          const ips = threats.results
            .map((t: Record<string, unknown>) => t.ip_address as string | null)
            .filter((ip): ip is string => ip !== null && ip !== undefined);

          const geoMap: Map<string, Record<string, unknown>> = new Map();
          if (ips.length > 0) {
            // ip-api.com: max 100 per request
            const chunks: string[][] = [];
            for (let i = 0; i < ips.length; i += 100) {
              chunks.push(ips.slice(i, i + 100));
            }
            for (const chunk of chunks) {
              const res = await fetch(
                'http://ip-api.com/batch?fields=status,lat,lon,as,country,countryCode,isp,org',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(chunk.map((ip: string) => ({ query: ip }))),
                  signal: AbortSignal.timeout(15_000),
                }
              );
              if (res.ok) {
                const data = await res.json() as Record<string, unknown>[];
                chunk.forEach((ip: string, i: number) => {
                  if (data[i]?.status === 'success') geoMap.set(ip, data[i] as Record<string, unknown>);
                });
              }
              // Respect 45 req/min — 1.4s between chunks
              if (chunks.length > 1) {
                await new Promise(r => setTimeout(r, 1400));
              }
            }
          }

          // Update each threat
          let enrichedCount = 0;
          for (const threat of threats.results) {
            const t = threat as Record<string, unknown>;
            const ipAddress = t.ip_address as string | null;
            const geo = ipAddress ? geoMap.get(ipAddress) : null;

            // Upsert hosting provider if we got ASN data.
            // Uses canonical hp_${asn} id form (matches PR #826's cartographer
            // convention). The ON CONFLICT(asn) handler still merges in case
            // a legacy row exists with a different id for the same asn —
            // pre-resolve via SELECT below returns the actual id either way.
            let providerId = t.hosting_provider_id as string | null;
            const geoAs = geo?.as as string | undefined;
            if (!providerId && geoAs) {
              const asn = geoAs.split(' ')[0];
              if (asn) {
                const providerName = geoAs.replace(/^AS\d+\s*/, '').trim() || (geo?.isp as string) || (geo?.org as string);
                await this.env.DB.prepare(`
                  INSERT INTO hosting_providers (id, name, asn, country, last_enriched)
                  VALUES (?, ?, ?, ?, datetime('now'))
                  ON CONFLICT(asn) DO UPDATE SET
                    last_enriched = datetime('now'),
                    country = COALESCE(country, excluded.country)
                `).bind(`hp_${asn}`, providerName, asn, geo?.countryCode as string ?? null).run();

                const provider = await this.env.DB.prepare(
                  'SELECT id FROM hosting_providers WHERE asn = ?'
                ).bind(asn).first<{ id: string }>();
                providerId = provider?.id ?? null;
              }
            }

            // Update threat with enriched data. Stamp enriched_at whenever
            // ip-api.com returned ANY data (status=success), not just when it
            // returned a country — otherwise threats with partial geo recycle
            // through the queue forever.
            await this.env.DB.prepare(`
              UPDATE threats SET
                lat = COALESCE(lat, ?),
                lng = COALESCE(lng, ?),
                country_code = COALESCE(country_code, ?),
                asn = COALESCE(asn, ?),
                hosting_provider_id = COALESCE(hosting_provider_id, ?),
                enriched_at = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE enriched_at END
              WHERE id = ?
            `).bind(
              geo?.lat as number ?? null,
              geo?.lon as number ?? null,
              geo?.countryCode as string ?? null,
              geoAs?.split(' ')[0] ?? null,
              providerId,
              geo ? 'attempted' : null,
              t.id as string
            ).run();

            enrichedCount++;
          }

          return enrichedCount;
        }
      );

      totalEnriched += enriched;

      // Log progress every 10 batches
      if (batchNum % 10 === 0) {
        await step.do(`log-progress-${batchNum}`, async () => {
          await this.env.DB.prepare(`
            INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
            VALUES (?, 'cartographer', 'batch_complete', ?, ?, 'info')
          `).bind(
            crypto.randomUUID(),
            `Backfill progress: ${totalEnriched}/${total} threats enriched`,
            JSON.stringify({ batchNum, totalEnriched, total, pct: Math.round(totalEnriched / total * 100) })
          ).run();
        });
      }

      // Brief pause between batches to stay within ip-api.com rate limits
      if (batchNum < totalBatches - 1) {
        await step.sleep(`rate-limit-pause-${batchNum}`, '2 seconds');
      }
    }

    // Final log
    await step.do('log-complete', async () => {
      await this.env.DB.prepare(`
        INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
        VALUES (?, 'cartographer', 'batch_complete', ?, ?, 'info')
      `).bind(
        crypto.randomUUID(),
        `Backfill workflow complete: ${totalEnriched} threats enriched`,
        JSON.stringify({ totalEnriched, total, success: true })
      ).run();
    });

    return { totalEnriched, total, batches: totalBatches };
  }
}
