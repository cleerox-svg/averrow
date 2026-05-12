import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

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
 * The first impl (PR #1275) pulled all 6 per tick and was reaped
 * at 15 min by navigator — 5k IPs × 6 endpoints × sequential D1
 * inserts blew the scheduled-handler CPU budget. Rotating one
 * endpoint per tick keeps each run bounded; over 6 hours we cover
 * the full mesh and steady-state inflow per endpoint sits well
 * under the budget.
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

async function fetchEndpoint(endpoint: DataPlaneEndpoint): Promise<string[]> {
  const res = await fetch(endpoint.url, {
    headers: {
      Accept: "text/plain",
      "User-Agent": "Averrow-ThreatIntel/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`dataplane HTTP ${res.status} from ${endpoint.url}`);
  const text = await res.text();
  return text.split("\n");
}

export const dataplane: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    // Pick one endpoint per tick. UTC hour mod 6 walks the full
    // mesh every 6 hours; first impl pulled all 6 per tick and
    // got reaped (~30k inserts blew the CPU budget).
    const hour = new Date().getUTCHours();
    const endpoint = ENDPOINTS[hour % ENDPOINTS.length]!;

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    let lines: string[];
    try {
      lines = await fetchEndpoint(endpoint);
    } catch (err) {
      console.error(`[dataplane:${endpoint.name}] fetch failed:`, err);
      throw err;
    }

    for (const line of lines) {
      const ip = extractIp(line);
      if (!ip) continue;
      itemsFetched++;

      try {
        if (await isDuplicate(ctx.env, "ip", ip)) {
          itemsDuplicate++;
          continue;
        }
        await insertThreat(ctx.env.DB, {
          id: threatId(`dataplane_${endpoint.name}`, "ip", ip),
          source_feed: "dataplane",
          threat_type: "scanning",
          malicious_url: null,
          malicious_domain: null,
          ip_address: ip,
          ioc_value: JSON.stringify({
            ip,
            category: endpoint.category,
            dataplane_feed: endpoint.name,
          }),
          severity: endpoint.severity,
          confidence_score: endpoint.confidence,
          status: "active",
        });
        await markSeen(ctx.env, "ip", ip);
        itemsNew++;
      } catch (err) {
        itemsError++;
        console.error(`[dataplane:${endpoint.name}] insert error:`, err);
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
