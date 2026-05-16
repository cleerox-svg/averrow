// Cloudflare zone introspection — read-only debug endpoint
//
// Operator-facing diagnostic: given a hostname (e.g. averrow.ca),
// queries the CF API using the worker's existing CF_API_TOKEN /
// CF_ACCOUNT_ID secrets and reports the zone state that affects
// whether HTTP traffic reaches our Worker:
//
//   - The matching CF zone (existence + status)
//   - DNS records (looking for the @ + www proxy state)
//   - Workers Routes attached to the zone
//   - Page Rules for the zone
//   - Custom WAF rulesets (entry phase) for the zone
//
// Each section calls a separate CF API endpoint. If the existing
// token doesn't carry the right scope, that section returns the
// CF error verbatim so the operator can grant the missing scope
// without surprises.
//
// Gating: AVERROW_INTERNAL_SECRET — same pattern as the rest of
// /api/internal/*.

import type { Env } from "../types";

interface CfApiResponse<T> {
  result?: T;
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: unknown[];
}

interface ZoneSummary {
  id:     string;
  name:   string;
  status: string;
  paused: boolean;
}

interface DnsRecordSummary {
  id:        string;
  type:      string;
  name:      string;
  content:   string;
  proxied:   boolean;
  proxiable: boolean;
}

interface WorkersRouteSummary {
  id:      string;
  pattern: string;
  script:  string;
}

interface PageRuleSummary {
  id:       string;
  targets:  unknown;
  actions:  unknown;
  priority: number;
  status:   string;
}

interface RulesetRuleSummary {
  id:          string;
  action:      string;
  description: string | null;
  expression:  string;
  enabled:     boolean;
}

interface ZoneIntrospectReport {
  zone:           ZoneSummary | { error: string };
  dns_records:    DnsRecordSummary[]    | { error: string };
  workers_routes: WorkersRouteSummary[] | { error: string };
  page_rules:     PageRuleSummary[]     | { error: string };
  waf_custom:     RulesetRuleSummary[]  | { error: string };
  http_probe:     { url: string; status: number; headers: Record<string, string> } | { error: string };
}

async function cfFetch<T>(
  token: string,
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = (await res.json()) as CfApiResponse<T>;
  if (!res.ok || !body.success) {
    const msg = body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, data: body.result as T };
}

export async function handleCfZoneIntrospect(
  request: Request,
  env:     Env,
): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.searchParams.get("zone");
  if (!hostname) {
    return new Response(JSON.stringify({ success: false, error: "missing ?zone=<hostname>" }),
      { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const token = env.CF_API_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({
      success: false,
      error: "CF_API_TOKEN secret not set on the worker — run `wrangler secret put CF_API_TOKEN`",
    }), { status: 503, headers: { "Content-Type": "application/json" } });
  }

  // 1. Find the matching zone by name (strip any subdomain — we only
  //    introspect at the apex). If the caller passes www.foo.com we
  //    still look up foo.com.
  const apex = hostname.split(".").slice(-2).join(".");
  const zonesRes = await cfFetch<ZoneSummary[]>(token, `/zones?name=${encodeURIComponent(apex)}`);

  const report: ZoneIntrospectReport = {
    zone:           { error: "uninitialised" },
    dns_records:    { error: "uninitialised" },
    workers_routes: { error: "uninitialised" },
    page_rules:     { error: "uninitialised" },
    waf_custom:     { error: "uninitialised" },
    http_probe:     { error: "uninitialised" },
  };

  if (!zonesRes.ok || zonesRes.data.length === 0) {
    report.zone = { error: zonesRes.ok ? "zone not found" : zonesRes.error };
    return new Response(JSON.stringify({ success: true, data: report }, null, 2),
      { headers: { "Content-Type": "application/json" } });
  }
  const zone = zonesRes.data[0];
  if (!zone) {
    report.zone = { error: "zone array returned empty entry" };
    return new Response(JSON.stringify({ success: true, data: report }, null, 2),
      { headers: { "Content-Type": "application/json" } });
  }
  report.zone = {
    id: zone.id, name: zone.name, status: zone.status, paused: zone.paused,
  };
  const zoneId = zone.id;

  // 2-5. Parallel fetches against the introspected zone. Each one fails
  // independently if its scope is missing; the section returns the
  // CF error message so the operator can grant the missing scope.
  const [dnsRes, routesRes, pageRulesRes, rulesetsRes] = await Promise.all([
    cfFetch<DnsRecordSummary[]>(token, `/zones/${zoneId}/dns_records?per_page=200`),
    cfFetch<WorkersRouteSummary[]>(token, `/zones/${zoneId}/workers/routes`),
    cfFetch<PageRuleSummary[]>(token, `/zones/${zoneId}/pagerules`),
    cfFetch<Array<{ id: string; phase: string; description?: string }>>(token, `/zones/${zoneId}/rulesets`),
  ]);

  report.dns_records = dnsRes.ok
    ? dnsRes.data.map((r) => ({
        id: r.id, type: r.type, name: r.name, content: r.content,
        proxied: r.proxied, proxiable: r.proxiable,
      }))
    : { error: dnsRes.error };

  report.workers_routes = routesRes.ok
    ? routesRes.data.map((r) => ({ id: r.id, pattern: r.pattern, script: r.script }))
    : { error: routesRes.error };

  report.page_rules = pageRulesRes.ok
    ? pageRulesRes.data.map((r) => ({
        id: r.id, targets: r.targets, actions: r.actions,
        priority: r.priority, status: r.status,
      }))
    : { error: pageRulesRes.error };

  // For WAF custom rules, find the http_request_firewall_custom ruleset
  // and pull its rules. This is where dashboard "Custom rules" live.
  if (rulesetsRes.ok) {
    const customRuleset = rulesetsRes.data.find((r) => r.phase === "http_request_firewall_custom");
    if (customRuleset) {
      const rulesRes = await cfFetch<{ rules?: RulesetRuleSummary[] }>(
        token, `/zones/${zoneId}/rulesets/${customRuleset.id}`,
      );
      if (rulesRes.ok) {
        const rules = rulesRes.data.rules ?? [];
        report.waf_custom = rules.map((r) => ({
          id: r.id, action: r.action, description: r.description,
          expression: r.expression, enabled: r.enabled,
        }));
      } else {
        report.waf_custom = { error: rulesRes.error };
      }
    } else {
      report.waf_custom = [];
    }
  } else {
    report.waf_custom = { error: rulesetsRes.error };
  }

  // 6. Issue a fresh HEAD against the hostname so we can see exactly
  // what the edge is returning right now, including any deny-reason
  // header. Doesn't need a CF scope — just a public-internet probe.
  try {
    const probeUrl = `https://${hostname}/`;
    const probeRes = await fetch(probeUrl, { method: "HEAD", redirect: "manual" });
    const headers: Record<string, string> = {};
    probeRes.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    report.http_probe = { url: probeUrl, status: probeRes.status, headers };
  } catch (err) {
    report.http_probe = { error: err instanceof Error ? err.message : String(err) };
  }

  return new Response(JSON.stringify({ success: true, data: report }, null, 2),
    { headers: { "Content-Type": "application/json" } });
}
