import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isPrivateIP } from "../lib/geoip";

/**
 * DataPlane.org — first-party honeypot-derived attacker IP feeds.
 *
 * https://dataplane.org/ runs a globally-distributed honeypot mesh
 * and publishes attacker IPs by attack category as plain-text
 * lists. We pull six of their categorized feeds, ONE per hourly
 * tick, selected by `hour % 6`:
 *
 *   hour%6=0  sshpwauth       — SSH password-auth brute-force IPs
 *   hour%6=1  sshclient       — SSH client connect attempts
 *   hour%6=2  telnetlogin     — Telnet login attempts
 *   hour%6=3  dnsrd           — DNS recursion desperation
 *   hour%6=4  sipinvitation   — SIP scanner IPs (VoIP probing)
 *   hour%6=5  proto41         — IPv6-tunneling abuse (proto 41)
 *
 * Iteration history:
 *   - PR #1275 (initial): pulled all 6 endpoints per tick. Reaped
 *     at 15min — sequential D1 inserts blew the CPU budget.
 *   - PR #1276 (rotate): one endpoint per tick. Still reaped —
 *     per-endpoint volume (5k+ IPs) × per-IP `isDuplicate` + `insertThreat`
 *     + `markSeen` round-trips was still too much.
 *   - This PR (batched): copy the cins_army pattern — sample down
 *     to SAMPLE_SIZE, batched `db.batch()` INSERT OR IGNORE for
 *     DB-side dedup, fire-and-forget KV markSeen at end. Per-tick
 *     runtime should now be <60 sec.
 *
 * Every line is `<ASN>|<ASN_org>|<IP>|<last_seen>|<category>`
 * (plus blank/comment lines we filter). We only extract the IP +
 * category — the ASN columns are useful but optional; cartographer
 * will re-derive ASN authoritatively during enrichment.
 *
 * No auth. The dataplane.org service runs continuously; pulling
 * hourly is well below their request budget.
 *
 * All rows land as threat_type='scanning' with severity per
 * category (password-spray > telnet > SIP > generic scan).
 */

interface DataPlaneEndpoint {
  name: string;
  url: string;
  severity: "critical" | "high" | "medium" | "low";
  confidence: number;
  category: string;
}

const ENDPOINTS: DataPlaneEndpoint[] = [
  // SSH password-spray IPs — by far the highest-signal class.
  // Credential-attack infrastructure, often pre-positioned for
  // ransomware initial access.
  { name: "sshpwauth", url: "https://dataplane.org/sshpwauth.txt",
    severity: "high", confidence: 85, category: "ssh_password_spray" },
  // SSH connection attempts (banner grabs).
  { name: "sshclient", url: "https://dataplane.org/sshclient.txt",
    severity: "medium", confidence: 70, category: "ssh_scanner" },
  // Telnet login spam — almost entirely IoT botnet recruitment
  // (Mirai et al.).
  { name: "telnetlogin", url: "https://dataplane.org/telnetlogin.txt",
    severity: "high", confidence: 85, category: "telnet_brute" },
  // DNS recursion abuse — amplification reflector candidates.
  { name: "dnsrd", url: "https://dataplane.org/dnsrd.txt",
    severity: "medium", confidence: 70, category: "dns_recursion_abuse" },
  // SIP scanner IPs (VoIP probing).
  { name: "sipinvitation", url: "https://dataplane.org/sipinvitation.txt",
    severity: "medium", confidence: 70, category: "sip_scanner" },
  // IPv6 protocol-41 tunneling abuse. Low volume, weird signal.
  { name: "proto41", url: "https://dataplane.org/proto41.txt",
    severity: "low", confidence: 65, category: "ipv6_proto41_abuse" },
];

// Sample size per tick. With 6-endpoint rotation, 250 × 6 = 1500
// IPs/6h across the full mesh. Random sampling means we get
// breadth across the upstream list rather than always the first N.
//
// PR-CA: trimmed from 500 → 250 (2026-05-23). Diagnostic
// `d1_top_write_queries_24h` flagged this INSERT path at 103K
// rows_written / 24h (the largest single write source). With
// each insert touching ~10 indexes on the threats table, 500/tick
// × 24 ticks/day was contributing ~13% of total D1 writes against
// the 50M-row/cycle quota. Halving the sample drops the
// contribution to ~50K/day (~6.5%) while keeping breadth — the
// 6-endpoint rotation still covers the full mesh every 6h, just
// at lower density per endpoint. Downstream consumer (FC's C2
// overlap correlation) compares IP presence across feeds, not
// IP-count density, so coverage breadth matters more than depth.
const SAMPLE_SIZE = 250;
const BATCH_SIZE = 50;
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Parse one DataPlane text line into an IP, tolerating their
 * pipe-delimited format AND the bare-IP variant some endpoints
 * use. Returns null for header/comment/blank lines.
 *
 * Documented format: `ASN | ASN_org | IP | last_seen | category`
 * Header lines begin with `#`; some endpoints add blank lines
 * between sections.
 */
function extractIp(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  // Pipe-delimited: IP is the 3rd column.
  if (trimmed.includes("|")) {
    const parts = trimmed.split("|").map((p) => p.trim());
    const candidate = parts[2];
    if (candidate && /^[\da-f.:]+$/i.test(candidate)) return candidate;
    return null;
  }
  // Fallback for bare-IP lines.
  if (/^[\da-f.:]+$/i.test(trimmed)) return trimmed;
  return null;
}

/** Fisher-Yates partial shuffle — returns the first n elements. */
function sample<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  const len = copy.length;
  const limit = Math.min(n, len);
  for (let i = 0; i < limit; i++) {
    const j = i + Math.floor(Math.random() * (len - i));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, limit);
}

async function fetchEndpoint(endpoint: DataPlaneEndpoint): Promise<string[]> {
  const res = await fetch(endpoint.url, {
    headers: {
      Accept: "text/plain",
      "User-Agent": "Averrow-ThreatIntel/1.0",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`dataplane HTTP ${res.status} from ${endpoint.url}`);
  const text = await res.text();
  return text.split("\n");
}

export const dataplane: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    // Pick one endpoint per tick. UTC hour mod 6 walks the full mesh
    // every 6 hours.
    const hour = new Date().getUTCHours();
    const endpoint = ENDPOINTS[hour % ENDPOINTS.length]!;

    const db = ctx.env.DB;
    let lines: string[];
    try {
      lines = await fetchEndpoint(endpoint);
    } catch (err) {
      console.error(`[dataplane:${endpoint.name}] fetch failed:`, err);
      throw err;
    }

    // Parse every line, then random-sample down to SAMPLE_SIZE so
    // we don't burn the CPU budget on 5k+ inserts per tick. Over
    // ENDPOINTS.length hours we cover the breadth of each list.
    const allIps: string[] = [];
    for (const line of lines) {
      const ip = extractIp(line);
      if (ip) allIps.push(ip);
    }
    const ips = sample(allIps, SAMPLE_SIZE);

    // Batched INSERT OR IGNORE — dedup is DB-side, no per-IP KV
    // round-trip. is_private_ip stamped via the shared isPrivateIP
    // helper for consistency with feedRunner.insertThreat.
    let itemsNew = 0;
    let firstError: string | null = null;
    for (let i = 0; i < ips.length; i += BATCH_SIZE) {
      const batch = ips.slice(i, i + BATCH_SIZE);
      const stmts = batch.map((ip) => {
        const iocJson = JSON.stringify({
          ip,
          category: endpoint.category,
          dataplane_feed: endpoint.name,
        });
        return db.prepare(
          `INSERT OR IGNORE INTO threats
             (id, source_feed, threat_type, malicious_url, malicious_domain,
              ip_address, ioc_value, severity, confidence_score, status,
              is_private_ip, first_seen, last_seen, created_at)
           VALUES (?, 'dataplane', 'scanning', NULL, NULL,
                   ?, ?, ?, ?, 'active',
                   ?, datetime('now'), datetime('now'), datetime('now'))`,
        ).bind(
          threatId(`dataplane_${endpoint.name}`, "ip", ip),
          ip,
          iocJson,
          endpoint.severity,
          endpoint.confidence,
          isPrivateIP(ip) ? 1 : 0,
        );
      });

      try {
        const results = await db.batch(stmts);
        const batchNew = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
        itemsNew += batchNew;
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
        console.error(`[dataplane:${endpoint.name}] batch insert error:`, err);
      }
    }

    // Mark inserted IPs as seen in KV — fire-and-forget Promise.all.
    // Only the ones that actually inserted (itemsNew > 0) — if the
    // whole batch failed we have nothing useful to cache.
    if (itemsNew > 0) {
      const kvPromises = ips.map((ip) =>
        ctx.env.CACHE.put(`dedup:ip:${ip}`, "1", { expirationTtl: 86_400 }).catch(() => {}),
      );
      await Promise.all(kvPromises);
    }

    return {
      itemsFetched: allIps.length,
      itemsNew,
      itemsDuplicate: ips.length - itemsNew,
      itemsError: firstError ? 1 : 0,
    };
  },
};
