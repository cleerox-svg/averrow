/**
 * Briefing Email Service — comprehensive 12-section operations briefing.
 * Sends styled HTML via Resend API.
 */
import { logger } from "./logger";
import type { Env } from "../types";
import type { ComprehensiveBriefing } from "../handlers/briefing";

const RECIPIENT_DEFAULT = "claude.leroux@averrow.com";
const FROM_ADDRESS = "Averrow Platform <briefing@averrow.com>";

// ─── Resend API ────────────────────────────────────────────────

interface ResendResponse {
  id?: string;
  /** Resend errors include a `name` discriminator like 'invalid_api_key',
   *  'validation_error', 'rate_limit_exceeded', 'domain_not_verified'. */
  name?: string;
  error?: string;
  message?: string;
  statusCode?: number;
}

/**
 * Last-error breadcrumb stored under this KV key on failure so the next
 * successful tick (or a manual diagnostic call) can read the full Resend
 * response body, not just the truncated message that gets persisted in
 * threat_briefings.report_data.email_error.
 */
const RESEND_LAST_ERROR_KV = 'briefing:resend_last_error';

async function sendViaResend(
  env: Env,
  apiKey: string,
  to: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; id?: string; error?: string; statusCode?: number; errorName?: string }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });

  // Read raw body once so we can parse + cache the full diagnostic on failure
  // even if Resend returns non-JSON HTML for 5xx (rare but happens on outages).
  const rawBody = await res.text();
  let body: ResendResponse;
  try {
    body = JSON.parse(rawBody) as ResendResponse;
  } catch {
    body = { message: `Non-JSON response: ${rawBody.slice(0, 240)}` };
  }

  if (!res.ok) {
    // Compose a useful single-line error: "<HTTP> <name>: <message>".
    // Resend returns errors like { name: 'invalid_api_key', message: 'API key is invalid' }
    // — surfacing both lets the operator distinguish "rotate the key" from
    // "verify the sending domain" from "you hit the rate limit." Previously
    // only `message` was persisted, which collapsed all four scenarios into
    // the same opaque "API key is invalid" / "Domain not verified" string.
    const composed = [
      `HTTP ${res.status}`,
      body.name ?? null,
      body.message ?? body.error ?? null,
    ].filter(Boolean).join(' / ');

    // Cache the full body in KV (TTL 7 days) so the next call to
    // /api/internal/platform-diagnostics can pick it up. KV failures are
    // non-fatal — caching is a diagnostic aid, not the alert path.
    try {
      await env.CACHE.put(
        RESEND_LAST_ERROR_KV,
        JSON.stringify({
          ts: new Date().toISOString(),
          status: res.status,
          name: body.name ?? null,
          message: body.message ?? body.error ?? null,
          raw: rawBody.slice(0, 1000),
          recipient: to,
        }),
        { expirationTtl: 7 * 24 * 60 * 60 },
      );
    } catch { /* non-fatal */ }

    return {
      ok: false,
      error: composed,
      statusCode: res.status,
      errorName: body.name,
    };
  }
  return { ok: true, id: body.id };
}

// ─── Helpers ──────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

function pct(hits: number, checked: number): string {
  if (checked === 0) return "—";
  return ((hits / checked) * 100).toFixed(1) + "%";
}

function dayOverDayPct(today: number, yesterday: number): string {
  if (yesterday === 0) return today > 0 ? "+100%" : "0%";
  const change = ((today - yesterday) / yesterday) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(0)}%`;
}

function dayOverDayArrow(today: number, yesterday: number): string {
  if (today > yesterday) return " &#9650;";
  if (today < yesterday) return " &#9660;";
  return "";
}

function statusBadge(status: string): string {
  const isOp = status === "OPERATIONAL";
  return `<span style="display:inline-block;padding:4px 14px;border-radius:6px;background:${isOp ? "#10b981" : "#f59e0b"};color:${isOp ? "#ffffff" : "#1a1a1a"};font-weight:700;font-size:12px;letter-spacing:1px;font-family:monospace;">[${status}]</span>`;
}

function sectionHeader(text: string): string {
  return `<tr><td style="padding:20px 24px 8px;background:#0a0f1a;">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#E5A832;text-transform:uppercase;font-family:monospace;">${text}</div>
  </td></tr>`;
}

function cardStart(): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1e293b;border-radius:8px;overflow:hidden;background:#111827;">`;
}

function cardEnd(): string {
  return `</table>`;
}

function tableRow(
  cells: Array<{
    text: string;
    align?: string;
    color?: string;
    mono?: boolean;
    bold?: boolean;
    width?: string;
  }>,
  bgOverride?: string,
  borderLeft?: string,
): string {
  const bg = bgOverride ? `background:${bgOverride};` : "";
  const bl = borderLeft ? `border-left:3px solid ${borderLeft};` : "";
  return `<tr style="${bg}${bl}">${cells
    .map(
      (c) =>
        `<td style="padding:8px 14px;border-bottom:1px solid #1e293b;color:${c.color ?? "#e2e8f0"};font-size:12px;text-align:${c.align ?? "left"};${c.mono ? "font-family:monospace;" : ""}${c.bold ? "font-weight:700;" : ""}${c.width ? `width:${c.width};` : ""}">${c.text}</td>`,
    )
    .join("")}</tr>`;
}

function headerRow(
  cells: Array<{ text: string; align?: string; width?: string }>,
): string {
  return `<tr style="background:#0f172a;">${cells
    .map(
      (c) =>
        `<td style="padding:8px 14px;border-bottom:1px solid #1e293b;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;font-family:monospace;font-weight:600;text-align:${c.align ?? "left"};${c.width ? `width:${c.width};` : ""}">${c.text}</td>`,
    )
    .join("")}</tr>`;
}

function warningRow(text: string): string {
  return `<tr><td style="padding:8px 14px;border-bottom:1px solid #1e293b;background:#1c1410;border-left:3px solid #f59e0b;color:#f59e0b;font-size:12px;font-family:monospace;">&#9888; ${text}</td></tr>`;
}

function okRow(text: string): string {
  return `<tr><td style="padding:8px 14px;border-bottom:1px solid #1e293b;color:#10b981;font-size:12px;font-family:monospace;">&#10003; ${text}</td></tr>`;
}

function severityColor(sev: string): string {
  switch (sev) {
    case "critical":
      return "#f87171";
    case "high":
      return "#fb923c";
    case "medium":
      return "#fbbf24";
    case "low":
      return "#78A0C8";
    default:
      return "#4ade80";
  }
}

function enrichmentStatus(checked: number): string {
  if (checked > 0) return '<span style="color:#10b981;">&#10003;</span>';
  return '<span style="color:#f59e0b;">&#9888;</span>';
}

// ─── Parse Flight Controller summary ─────────────────────────

function parseFlightControllerSummary(
  summary: string | null,
): Array<{ queue: string; backlog: string }> {
  if (!summary) return [];
  const rows: Array<{ queue: string; backlog: string }> = [];
  // Parse patterns like "Cartographer: 124" or "queue_name backlog: 15403"
  const lines = summary.split(/[,;\n]+/);
  for (const line of lines) {
    const match = line.match(
      /([A-Za-z_\s]+?)[\s:]+(\d[\d,]*)/,
    );
    if (match) {
      rows.push({ queue: match[1]!.trim(), backlog: match[2]!.trim() });
    }
  }
  // Look for budget pattern
  const budgetMatch = summary.match(
    /\$[\d.]+\s*\/\s*\$[\d.]+/,
  );
  if (budgetMatch) {
    rows.push({ queue: "Budget", backlog: budgetMatch[0] });
  }
  return rows;
}

// ─── Build HTML ──────────────────────────────────────────────

function buildBriefingHtml(
  b: ComprehensiveBriefing,
  title: string,
): string {
  const p = b.platformOverview;
  const dateStr = new Date(b.generatedAt).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = new Date(b.generatedAt).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  });
  const dodPct = dayOverDayPct(p.todayCount, p.yesterdayCount);
  const dodArrow = dayOverDayArrow(p.todayCount, p.yesterdayCount);
  const total12h = b.newThreats.bySeverity.reduce(
    (s, r) => s + Number(r.count),
    0,
  );

  // Feed production totals
  const totalFeedRuns = b.feedProduction.reduce(
    (s, f) => s + Number(f.runs),
    0,
  );
  const totalIngested = b.feedProduction.reduce(
    (s, f) => s + Number(f.ingested),
    0,
  );

  // Feed health summary
  const healthCounts: Record<string, number> = {};
  for (const h of b.feedHealth.summary) {
    healthCounts[h.health_status] = Number(h.count);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#080C14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#080C14;">
<tr><td align="center" style="padding:24px 16px;">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#0a0f1a;">

<!-- ═══ HEADER ═══ -->
<tr><td style="padding:28px 24px 16px;background:#0a0f1a;border-radius:12px 12px 0 0;border-bottom:1px solid #1e293b;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td>
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#E5A832;text-transform:uppercase;font-family:monospace;">AVERROW INTELLIGENCE</div>
      <div style="font-size:18px;font-weight:700;color:#e2e8f0;margin-top:6px;">${title}</div>
      <div style="font-size:12px;color:#78A0C8;margin-top:4px;">${dateStr}</div>
    </td>
    <td style="text-align:right;vertical-align:top;">${statusBadge(b.statusBadge)}</td>
  </tr></table>
</td></tr>

${b.geopoliticalCampaigns.length > 0 ? b.geopoliticalCampaigns.map(gc => {
  const actors: string[] = JSON.parse(gc.threat_actors || '[]');
  const priorityColor = gc.briefing_priority === 'critical' ? '#C83C3C' : '#fb923c';
  return `<!-- ═══ GEOPOLITICAL ALERT ═══ -->
<tr><td style="padding:12px 24px;background:#0a0f1a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #C83C3C;border-radius:8px;overflow:hidden;background:#1a0f0f;">
    <tr><td style="padding:14px 16px;border-bottom:1px solid #3d1515;">
      <div style="font-size:13px;font-weight:700;color:#f87171;font-family:monospace;letter-spacing:1px;">&#128308; GEOPOLITICAL ALERT: ${gc.name.toUpperCase()}</div>
    </td></tr>
    <tr><td style="padding:12px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:4px 0;font-size:12px;color:#e2e8f0;font-family:monospace;">Status: <span style="color:${priorityColor};font-weight:700;">${gc.status.toUpperCase()}</span></td>
          <td style="padding:4px 0;font-size:12px;color:#e2e8f0;font-family:monospace;">Since: <span style="color:#E5A832;">${gc.start_date}</span></td>
          <td style="padding:4px 0;font-size:12px;color:#e2e8f0;font-family:monospace;">Priority: <span style="color:${priorityColor};font-weight:700;">${gc.briefing_priority.toUpperCase()}</span></td>
        </tr>
      </table>
      <div style="margin-top:8px;font-size:12px;color:#e2e8f0;font-family:monospace;">
        Total threats: <span style="color:#E5A832;font-weight:700;">${fmt(gc.total_threats)}</span>
        &middot; New (24h): <span style="color:#E5A832;font-weight:700;">${fmt(gc.new_24h)}</span>
        &middot; Brands targeted: <span style="color:#E5A832;font-weight:700;">${fmt(gc.brands_hit)}</span>
      </div>
      <div style="margin-top:6px;font-size:11px;color:#fb923c;font-family:monospace;">
        Actors: ${actors.join(', ')}
      </div>
      ${gc.notes ? `<div style="margin-top:6px;font-size:11px;color:#78A0C8;font-family:monospace;">${gc.notes}</div>` : ''}
    </td></tr>
  </table>
</td></tr>`;
}).join('') : ''}

<!-- ═══ SECTION 1: PLATFORM OVERVIEW ═══ -->
${sectionHeader("Platform Overview")}
<tr><td style="padding:0 24px 12px;background:#0a0f1a;">
  ${cardStart()}
  <tr>
    <td style="padding:16px;text-align:center;width:25%;border-right:1px solid #1e293b;">
      <div style="font-size:26px;font-weight:700;color:#E5A832;font-family:monospace;">${fmt(p.totalThreats)}</div>
      <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-top:2px;">Total</div>
    </td>
    <td style="padding:16px;text-align:center;width:25%;border-right:1px solid #1e293b;">
      <div style="font-size:26px;font-weight:700;color:#E5A832;font-family:monospace;">${fmt(p.last24h)}</div>
      <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-top:2px;">New 24h</div>
    </td>
    <td style="padding:16px;text-align:center;width:25%;border-right:1px solid #1e293b;">
      <div style="font-size:26px;font-weight:700;color:#E5A832;font-family:monospace;">${fmt(p.avgPerHour)}/hr</div>
      <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-top:2px;">Per Hour</div>
    </td>
    <td style="padding:16px;text-align:center;width:25%;">
      <div style="font-size:26px;font-weight:700;color:${p.todayCount >= p.yesterdayCount ? "#C83C3C" : "#10b981"};font-family:monospace;">${dodPct}${dodArrow}</div>
      <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-top:2px;">Day/Day</div>
    </td>
  </tr>
  ${cardEnd()}
  <div style="font-size:11px;color:#78A0C8;margin-top:8px;font-family:monospace;">
    ${fmt(p.brandsMonitored)} brands monitored &middot; ${fmt(p.brandsClassified)} classified
  </div>
</td></tr>

<!-- ═══ SECTION 2: NEW THREATS (12H) ═══ -->
${sectionHeader("New Threats (12h)")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  <div style="font-size:14px;color:#e2e8f0;font-weight:600;margin-bottom:8px;">Total new: <span style="color:#E5A832;">${fmt(total12h)}</span></div>
  <div style="font-size:12px;color:#78A0C8;font-family:monospace;margin-bottom:12px;">
    ${b.newThreats.bySeverity.map((s) => `<span style="color:${severityColor(s.severity)};">${s.severity}: ${fmt(s.count)}</span>`).join(" &middot; ")}
  </div>
</td></tr>
${b.newThreats.bySource.length > 0 ? `<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;font-family:monospace;margin-bottom:4px;">By Source</div>
  ${cardStart()}
  ${headerRow([{ text: "Feed" }, { text: "Count", align: "right" }])}
  ${b.newThreats.bySource.map((s) => tableRow([{ text: s.source_feed, mono: true }, { text: fmt(s.count), align: "right", mono: true, color: "#E5A832" }])).join("")}
  ${cardEnd()}
</td></tr>` : ""}
${b.newThreats.notable.length > 0 ? `<tr><td style="padding:8px 24px 4px;background:#0a0f1a;">
  <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;font-family:monospace;margin-bottom:4px;">Notable Critical/High</div>
  ${cardStart()}
  ${b.newThreats.notable.slice(0, 5).map((t) => `<tr><td style="padding:8px 14px;border-bottom:1px solid #1e293b;">
    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${severityColor(t.severity)};margin-right:8px;"></span>
    <span style="color:#e2e8f0;font-size:12px;font-weight:600;">${t.malicious_domain}</span>
    <span style="color:#78A0C8;font-size:11px;margin-left:8px;">${t.type} &middot; ${t.severity} &middot; ${t.source_feed}</span>
  </td></tr>`).join("")}
  ${cardEnd()}
</td></tr>` : ""}

<!-- ═══ SECTION 3: FEED PRODUCTION (12H) ═══ -->
${sectionHeader("Feed Production (12h)")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  ${cardStart()}
  ${headerRow([{ text: "Feed" }, { text: "Runs", align: "right", width: "60px" }, { text: "Ingested", align: "right", width: "80px" }])}
  ${b.feedProduction.map((f) => tableRow([{ text: f.feed_name, mono: true }, { text: fmt(f.runs), align: "right", mono: true }, { text: fmt(f.ingested), align: "right", mono: true, color: "#E5A832" }])).join("")}
  ${cardEnd()}
  <div style="font-size:11px;color:#78A0C8;margin-top:8px;font-family:monospace;">
    ${b.feedProduction.length} feeds active &middot; ${fmt(totalFeedRuns)} total runs &middot; ${fmt(totalIngested)} records ingested
  </div>
</td></tr>

<!-- ═══ SECTION 4: FEED HEALTH ═══ -->
${sectionHeader("Feed Health")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  <div style="font-size:12px;color:#e2e8f0;font-family:monospace;margin-bottom:10px;">
    ${[
      healthCounts["healthy"] ? `<span style="color:#10b981;">&#9679; ${healthCounts["healthy"]} healthy</span>` : "",
      healthCounts["degraded"] ? `<span style="color:#f59e0b;">&#9679; ${healthCounts["degraded"]} degraded</span>` : "",
      healthCounts["failed"] ? `<span style="color:#C83C3C;">&#9679; ${healthCounts["failed"]} failed</span>` : "",
    ].filter(Boolean).join("&nbsp;&nbsp;")}
  </div>
  ${b.feedHealth.degradedFeeds.length > 0 || b.feedHealth.staleFeeds.length > 0 ? `${cardStart()}
  ${b.feedHealth.degradedFeeds.map((f) => warningRow(`${f.feed_name} — ${f.last_error ?? "unknown error"}`)).join("")}
  ${b.feedHealth.staleFeeds.map((f) => warningRow(`${f.feed_name} — last run ${f.last_successful_pull ?? "never"} (stale)`)).join("")}
  ${cardEnd()}` : `<div style="font-size:12px;color:#10b981;font-family:monospace;">&#10003; All feeds operational</div>`}
</td></tr>

<!-- ═══ SECTION 5: ENRICHMENT PIPELINE ═══ -->
${sectionHeader("Enrichment Pipeline")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  ${cardStart()}
  ${headerRow([{ text: "Engine" }, { text: "Checked", align: "right" }, { text: "Hits", align: "right" }, { text: "Hit Rate", align: "right" }, { text: "Status", align: "center", width: "50px" }])}
  ${[
    { name: "SURBL", checked: b.enrichment.surbl_checked, hits: b.enrichment.surbl_hits },
    { name: "VirusTotal", checked: b.enrichment.vt_checked, hits: b.enrichment.vt_hits },
    { name: "Google SB", checked: b.enrichment.gsb_checked, hits: b.enrichment.gsb_hits },
    { name: "Spamhaus DBL", checked: b.enrichment.dbl_checked, hits: b.enrichment.dbl_hits },
    { name: "AbuseIPDB", checked: b.enrichment.abuse_checked, hits: b.enrichment.abuse_hits },
    { name: "GreyNoise", checked: b.enrichment.gn_checked, hits: 0 },
    { name: "SecLookup", checked: b.enrichment.sec_checked, hits: 0 },
  ].map((e) => tableRow([
    { text: e.name, mono: true },
    { text: fmt(e.checked), align: "right", mono: true },
    { text: fmt(e.hits), align: "right", mono: true, color: e.hits > 0 ? "#E5A832" : "#64748b" },
    { text: pct(e.hits, e.checked), align: "right", mono: true },
    { text: enrichmentStatus(e.checked), align: "center" },
  ])).join("")}
  ${cardEnd()}
</td></tr>

<!-- ═══ SECTION 6: FLIGHT CONTROLLER ═══ -->
${sectionHeader("Flight Controller")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  ${b.flightController.summary ? (() => {
    const fcRows = parseFlightControllerSummary(b.flightController.summary);
    if (fcRows.length === 0) {
      return `<div style="font-size:12px;color:#78A0C8;font-family:monospace;padding:8px 0;">${b.flightController.summary}</div>`;
    }
    return `${cardStart()}
    ${headerRow([{ text: "Queue" }, { text: "Backlog", align: "right" }])}
    ${fcRows.map((r) => tableRow([{ text: r.queue, mono: true }, { text: r.backlog, align: "right", mono: true, color: "#E5A832" }])).join("")}
    ${cardEnd()}`;
  })() : `<div style="font-size:12px;color:#64748b;font-family:monospace;">No Flight Controller diagnostic available</div>`}
</td></tr>

<!-- ═══ SECTION 7: AGENT STATUS ═══ -->
${sectionHeader("Agent Status (12h)")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  ${cardStart()}
  ${headerRow([{ text: "Agent" }, { text: "Runs", align: "right", width: "60px" }, { text: "Last Run", align: "right" }, { text: "Status", align: "center", width: "50px" }])}
  ${b.agentActivity.map((a) => {
    const lastRunTime = a.last_run ? new Date(a.last_run).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC" : "—";
    return tableRow([
      { text: a.agent_id, mono: true },
      { text: fmt(a.runs), align: "right", mono: true },
      { text: lastRunTime, align: "right", mono: true, color: "#78A0C8" },
      { text: '<span style="color:#10b981;">&#10003;</span>', align: "center" },
    ]);
  }).join("")}
  ${b.agentActivity.length === 0 ? `<tr><td style="padding:12px 14px;color:#64748b;font-size:12px;">No agent activity in last 12h</td></tr>` : ""}
  ${cardEnd()}
</td></tr>

<!-- ═══ SECTION 8: SPAM TRAP INTELLIGENCE ═══ -->
${sectionHeader("Spam Trap Intelligence")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  <div style="font-size:12px;color:#e2e8f0;font-family:monospace;margin-bottom:8px;">
    Seeds deployed: <span style="color:#E5A832;">${fmt(b.spamTrap.totalSeeds)}</span>
    ${b.spamTrap.seedingSources.length > 0 ? ` (${b.spamTrap.seedingSources.slice(0, 3).map((s) => `${s.seeded_location}: ${s.seeds}`).join(" &middot; ")})` : ""}
  </div>
  <div style="font-size:12px;color:#e2e8f0;font-family:monospace;margin-bottom:8px;">
    Total captures: <span style="color:#E5A832;">${fmt(b.spamTrap.totalCaptures)}</span>
    &middot; New (12h): <span style="color:#E5A832;">${fmt(b.spamTrap.captures12h)}</span>
  </div>
  ${b.spamTrap.seedingSources.length > 0 ? `
  <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;font-family:monospace;margin:8px 0 4px;">Seeding Sources</div>
  ${cardStart()}
  ${headerRow([{ text: "Source" }, { text: "Seeds", align: "right" }, { text: "Catches", align: "right" }])}
  ${b.spamTrap.seedingSources.map((s) => tableRow([{ text: s.seeded_location, mono: true }, { text: fmt(s.seeds), align: "right", mono: true }, { text: fmt(s.catches), align: "right", mono: true, color: Number(s.catches) > 0 ? "#E5A832" : "#64748b" }])).join("")}
  ${cardEnd()}` : ""}
  ${b.spamTrap.latestCaptures.length > 0 ? `
  <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;font-family:monospace;margin:12px 0 4px;">Latest Captures</div>
  ${cardStart()}
  ${b.spamTrap.latestCaptures.map((c) => `<tr><td style="padding:10px 14px;border-bottom:1px solid #1e293b;">
    <div style="font-size:12px;color:#e2e8f0;">From: <span style="color:#78A0C8;">${c.from_address}</span> &#8594; <span style="color:#78A0C8;">${c.trap_address}</span></div>
    <div style="font-size:11px;color:#e2e8f0;margin-top:2px;">Subject: &ldquo;${c.subject}&rdquo;</div>
    <div style="font-size:10px;color:#64748b;margin-top:2px;">${c.category} &middot; ${c.severity} &middot; ${c.captured_at}</div>
  </td></tr>`).join("")}
  ${cardEnd()}` : ""}
</td></tr>

<!-- ═══ SECTION 9: HONEYPOT ACTIVITY ═══ -->
${sectionHeader("Honeypot Activity")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  <div style="font-size:12px;color:#e2e8f0;font-family:monospace;margin-bottom:8px;">
    Total visits: <span style="color:#E5A832;">${fmt(b.honeypot.totalVisits)}</span>
    (<span style="color:#78A0C8;">${fmt(b.honeypot.botVisits)} bots</span> &middot;
    <span style="color:#78A0C8;">${fmt(b.honeypot.humanVisits)} humans</span>)
    &middot; Last 12h: <span style="color:#E5A832;">${fmt(b.honeypot.visits12h)}</span>
  </div>
  ${b.honeypot.pageBreakdown.length > 0 ? `
  <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;font-family:monospace;margin:8px 0 4px;">Page Breakdown</div>
  ${cardStart()}
  ${headerRow([{ text: "Page" }, { text: "Visits", align: "right" }, { text: "Bots", align: "right" }])}
  ${b.honeypot.pageBreakdown.map((p) => tableRow([{ text: p.page, mono: true }, { text: fmt(p.visits), align: "right", mono: true }, { text: fmt(p.bots), align: "right", mono: true }])).join("")}
  ${cardEnd()}` : ""}
  ${b.honeypot.recentBots.length > 0 ? `
  <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;font-family:monospace;margin:12px 0 4px;">Recent Crawlers</div>
  ${cardStart()}
  ${b.honeypot.recentBots.map((bot) => `<tr><td style="padding:8px 14px;border-bottom:1px solid #1e293b;font-size:12px;color:#e2e8f0;font-family:monospace;">
    &#9679; ${bot.bot_name || "Unknown bot"} &middot; ${bot.country || "?"} &middot; ${bot.visited_at ? new Date(bot.visited_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC" : "—"}
  </td></tr>`).join("")}
  ${cardEnd()}` : ""}
  ${b.honeypot.suspiciousHumans.length > 0 ? `
  <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;font-family:monospace;margin:12px 0 4px;">Recon &amp; Bait Hits (7d)</div>
  ${cardStart()}
  ${b.honeypot.suspiciousHumans.map((h) => {
    const label = h.reason === "bait" ? "Bait page hit" : "Recon probe";
    const time = h.visited_at ? new Date(h.visited_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC" : "—";
    const asn = h.asn ? ` AS${h.asn}` : "";
    return warningRow(`${label}: ${h.country || "??"}${asn} → ${h.page} at ${time}`);
  }).join("")}
  ${cardEnd()}` : ""}
</td></tr>

<!-- ═══ SECTION 10: TOP TARGETED BRANDS (24H) ═══ -->
${sectionHeader("Top Targeted Brands (24h)")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  ${b.topTargetedBrands.length > 0 ? `${cardStart()}
  ${b.topTargetedBrands.map((brand, i) => tableRow([
    { text: `${i + 1}.`, align: "right", color: "#64748b", width: "30px", mono: true },
    { text: brand.name },
    { text: fmt(brand.threats_24h), align: "right", mono: true, color: "#E5A832" },
  ])).join("")}
  ${cardEnd()}` : `<div style="font-size:12px;color:#64748b;font-family:monospace;">No brand-attributed threats in last 24h</div>`}
</td></tr>

<!-- ═══ SECTION 11: ANOMALIES & ALERTS ═══ -->
${sectionHeader("Anomalies & Alerts")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  ${cardStart()}
  ${(() => {
    const rows: string[] = [];
    // Enrichment anomalies
    if (b.enrichment.gn_checked > 0 && b.enrichment.gn_checked === b.enrichment.gn_checked) {
      // GreyNoise executing but 0 enrichments
    }
    if (b.enrichment.gn_checked === 0) {
      rows.push(warningRow("GreyNoise: executing but 0 enrichments — API may not be returning data"));
    }
    if (b.enrichment.sec_checked === 0) {
      rows.push(warningRow("SecLookup: executing but 0 enrichments — API may not be returning data"));
    }
    // CertStream
    if (b.newCapabilities.certstream === 0) {
      rows.push(warningRow("CertStream: alive but 0 captures"));
    }
    // Degraded feeds
    for (const f of b.feedHealth.degradedFeeds) {
      rows.push(warningRow(`${f.feed_name}: degraded — ${f.last_error ?? "unknown"}`));
    }
    // OK statuses
    if (b.agentActivity.length > 0) {
      rows.push(okRow(`All ${b.agentActivity.length} agents running normally`));
    }
    const producingEngines = [b.enrichment.surbl_checked, b.enrichment.vt_checked, b.enrichment.gsb_checked, b.enrichment.dbl_checked, b.enrichment.abuse_checked, b.enrichment.gn_checked, b.enrichment.sec_checked].filter((v) => v > 0).length;
    rows.push(okRow(`Enrichment pipeline operational (${producingEngines} of 7 engines producing)`));
    if (b.newCapabilities.typosquat_new > 0) {
      rows.push(okRow(`Typosquat scanner active — ${fmt(b.newCapabilities.typosquat_new)} domains discovered`));
    } else if (b.newCapabilities.typosquat_total > 0) {
      rows.push(okRow(`Typosquat scanner active — ${fmt(b.newCapabilities.typosquat_total)} total domains`));
    }
    if (b.newCapabilities.appstore_new > 0) {
      rows.push(okRow(`App-store monitor active — ${fmt(b.newCapabilities.appstore_new)} new impersonations in 12h (${fmt(b.newCapabilities.appstore_total)} total active)`));
    } else if (b.newCapabilities.appstore_total > 0) {
      rows.push(okRow(`App-store monitor active — ${fmt(b.newCapabilities.appstore_total)} active impersonations`));
    }
    if (b.newCapabilities.darkweb_new > 0) {
      rows.push(okRow(`Dark-web monitor active — ${fmt(b.newCapabilities.darkweb_new)} new mentions in 12h (${fmt(b.newCapabilities.darkweb_total)} total active)`));
    } else if (b.newCapabilities.darkweb_total > 0) {
      rows.push(okRow(`Dark-web monitor active — ${fmt(b.newCapabilities.darkweb_total)} active mentions`));
    }
    return rows.join("");
  })()}
  ${cardEnd()}
</td></tr>

<!-- ═══ SECTION 12: BRAND COVERAGE ═══ -->
${sectionHeader("Brand Coverage")}
<tr><td style="padding:0 24px 4px;background:#0a0f1a;">
  <div style="font-size:12px;color:#e2e8f0;font-family:monospace;margin-bottom:8px;">
    ${fmt(p.brandsMonitored)} monitored &middot; ${fmt(p.brandsClassified)} classified
  </div>
  ${b.brandCoverage.length > 0 ? `<div style="font-size:12px;color:#78A0C8;font-family:monospace;">
    Top: ${b.brandCoverage.slice(0, 5).map((c) => `${c.sector} (${c.brands})`).join(" &middot; ")}
  </div>` : ""}
</td></tr>

<!-- ═══ FOOTER ═══ -->
<tr><td style="padding:24px;background:#0a0f1a;border-radius:0 0 12px 12px;border-top:1px solid #1e293b;margin-top:16px;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:11px;color:#78A0C8;font-family:monospace;">
      Averrow Threat Interceptor &middot; averrow.com<br>
      <span style="color:#4a5568;">Generated at ${timeStr} UTC &middot; Next briefing at 8:00 AM ET</span>
    </td>
    <td style="text-align:right;">
      <a href="https://averrow.com/v2/briefings" style="color:#E5A832;font-size:11px;text-decoration:none;font-family:monospace;">View in Dashboard &#8594;</a>
    </td>
  </tr></table>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── Public API ────────────────────────────────────────────────

export async function sendBriefingEmail(
  env: Env,
  briefing: ComprehensiveBriefing,
  title: string,
): Promise<{ sent: boolean; id?: string; error?: string; recipient: string }> {
  // BRIEFING_RECIPIENT lets the operator change recipient without a
  // code edit. Set via `wrangler secret put BRIEFING_RECIPIENT`.
  const recipient = (env.BRIEFING_RECIPIENT?.trim() || RECIPIENT_DEFAULT);

  if (!env.RESEND_API_KEY) {
    logger.warn("briefing_email_skip", {
      reason: "RESEND_API_KEY not configured",
    });
    return { sent: false, error: "RESEND_API_KEY not configured", recipient };
  }

  const subject = `${briefing.statusBadge === "DEGRADED" ? "[DEGRADED] " : "[OPERATIONAL] "}${title}`;
  const html = buildBriefingHtml(briefing, title);

  const result = await sendViaResend(
    env,
    env.RESEND_API_KEY,
    recipient,
    subject,
    html,
  );

  if (result.ok) {
    logger.info("briefing_email_sent", { to: recipient, resendId: result.id });
  } else {
    // Surface the discriminator (`name`) and HTTP status, not just `message`.
    // Operators reading the diagnostics endpoint need to know whether to
    // rotate the key, verify the domain, or wait out a rate limit.
    logger.error("briefing_email_failed", {
      to: recipient,
      error: result.error,
      statusCode: result.statusCode,
      errorName: result.errorName,
    });
  }

  return { sent: result.ok, id: result.id, error: result.error, recipient };
}
