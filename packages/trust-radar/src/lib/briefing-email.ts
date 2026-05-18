/**
 * Daily Platform Briefing email — comprehensive operations report shaped
 * for an executive inbox, not a logs dump.
 *
 * Visual structure: wrapped by `email-layout.emailShell()` (canonical brand
 * header + footer with logo). Body is a sequence of glass-style cards on
 * the Deep Space background, each card hosting one logical section.
 *
 * Sends via Resend; failure path caches the full body in KV under
 * `briefing:resend_last_error` so the diagnostics endpoint can surface
 * the actionable failure (rotate key vs verify domain vs rate-limit).
 */
import { logger } from "./logger";
import type { Env } from "../types";
import type { ComprehensiveBriefing } from "../handlers/briefing";
import { emailShell, escapeHtml, headerStatusBadge } from "./email-layout";

const RECIPIENT_DEFAULT = "claude.leroux@averrow.com";
const FROM_ADDRESS = "Averrow Intelligence <briefing@averrow.com>";

// ─── Tokens (mirror the SPA design system) ─────────────────────

const COLOR = {
  bgCard:     "#111A2C",
  bgCardAlt:  "#0D1626",
  border:     "rgba(255,255,255,0.07)",
  borderHard: "rgba(255,255,255,0.10)",
  text:       "#E8ECF2",
  textDim:    "#9AAABF",
  textMuted:  "#6B7A90",
  amber:      "#E5A832",
  red:        "#F87171",
  orange:     "#FB923C",
  yellow:     "#FBBF24",
  blue:       "#60A5FA",
  green:      "#34D399",
} as const;

const FONT_MONO = "'SF Mono','Menlo',Consolas,'Courier New',monospace";

// ─── Resend transport ───────────────────────────────────────────

interface ResendResponse {
  id?: string;
  name?: string;
  error?: string;
  message?: string;
  statusCode?: number;
}

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
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  const rawBody = await res.text();
  let body: ResendResponse;
  try { body = JSON.parse(rawBody) as ResendResponse; }
  catch { body = { message: `Non-JSON response: ${rawBody.slice(0, 240)}` }; }

  if (!res.ok) {
    const composed = [
      `HTTP ${res.status}`,
      body.name ?? null,
      body.message ?? body.error ?? null,
    ].filter(Boolean).join(' / ');
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
    return { ok: false, error: composed, statusCode: res.status, errorName: body.name };
  }
  return { ok: true, id: body.id };
}

// ─── Format helpers ─────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

function pct(hits: number, checked: number): string {
  if (checked === 0) return "—";
  return ((hits / checked) * 100).toFixed(1) + "%";
}

function dodPct(today: number, yesterday: number): string {
  if (yesterday === 0) return today > 0 ? "+100%" : "0%";
  const change = ((today - yesterday) / yesterday) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(0)}%`;
}

function dodArrow(today: number, yesterday: number): string {
  if (today > yesterday) return "▲";
  if (today < yesterday) return "▼";
  return "·";
}

function severityColor(sev: string): string {
  switch (sev) {
    case "critical": return COLOR.red;
    case "high":     return COLOR.orange;
    case "medium":   return COLOR.yellow;
    case "low":      return COLOR.blue;
    default:         return COLOR.green;
  }
}

// ─── Building blocks ────────────────────────────────────────────

/** Section: title strip + card body, with consistent spacing. */
function section(title: string, bodyHtml: string, opts?: { eyebrow?: string }): string {
  const eyebrow = opts?.eyebrow
    ? `<div style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.22em;color:${COLOR.amber};text-transform:uppercase;margin-bottom:2px;">${escapeHtml(opts.eyebrow)}</div>`
    : "";
  return `
  <tr><td style="padding:22px 28px 6px;">
    ${eyebrow}
    <div style="font-size:13px;font-weight:700;letter-spacing:0.04em;color:${COLOR.text};">${escapeHtml(title)}</div>
  </td></tr>
  <tr><td style="padding:0 28px 4px;">${bodyHtml}</td></tr>`;
}

/** Card: rounded container with hairline border. */
function card(innerHtml: string, opts?: { accent?: string }): string {
  const accentRule = opts?.accent
    ? `border-left:3px solid ${opts.accent};`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.bgCard};border:1px solid ${COLOR.border};${accentRule}border-radius:10px;overflow:hidden;">${innerHtml}</table>`;
}

/** Stat tile (used in the 4-up overview grid). */
function statTile(value: string, label: string, color: string = COLOR.amber): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.bgCard};border:1px solid ${COLOR.border};border-radius:10px;">
    <tr><td style="padding:14px 12px;text-align:center;">
      <div style="font-family:${FONT_MONO};font-size:22px;font-weight:800;color:${color};line-height:1.1;letter-spacing:-0.02em;">${value}</div>
      <div style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.18em;color:${COLOR.textMuted};text-transform:uppercase;margin-top:6px;">${escapeHtml(label)}</div>
    </td></tr>
  </table>`;
}

/** Table row builder — keeps row spacing + colour consistent. */
function tr(cells: Array<{ html: string; align?: "left" | "right" | "center"; width?: string; color?: string; mono?: boolean; bold?: boolean }>): string {
  return `<tr>${cells.map(c => `<td style="padding:10px 14px;border-top:1px solid ${COLOR.border};color:${c.color ?? COLOR.text};font-size:12px;text-align:${c.align ?? "left"};${c.mono ? `font-family:${FONT_MONO};` : ""}${c.bold ? "font-weight:700;" : ""}${c.width ? `width:${c.width};` : ""}">${c.html}</td>`).join("")}</tr>`;
}

function thead(cells: Array<{ text: string; align?: "left" | "right" | "center"; width?: string }>): string {
  return `<tr>${cells.map(c => `<td style="padding:10px 14px;background:${COLOR.bgCardAlt};color:${COLOR.textDim};font-family:${FONT_MONO};font-size:9px;letter-spacing:0.18em;font-weight:600;text-transform:uppercase;text-align:${c.align ?? "left"};${c.width ? `width:${c.width};` : ""}">${escapeHtml(c.text)}</td>`).join("")}</tr>`;
}

function statusDot(color: string): string {
  return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};box-shadow:0 0 6px ${color}80;vertical-align:middle;"></span>`;
}

function pillBadge(label: string, color: string): string {
  return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;border:1px solid ${color}55;background:${color}18;color:${color};font-family:${FONT_MONO};font-size:9px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${escapeHtml(label)}</span>`;
}

// ─── Compose the body ───────────────────────────────────────────

function buildBriefingBody(b: ComprehensiveBriefing): string {
  const p = b.platformOverview;
  const dateStr = new Date(b.generatedAt).toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const dodStr = dodPct(p.todayCount, p.yesterdayCount);
  const dodSym = dodArrow(p.todayCount, p.yesterdayCount);
  const dodColor = p.todayCount > p.yesterdayCount ? COLOR.red
                 : p.todayCount < p.yesterdayCount ? COLOR.green
                 : COLOR.textDim;
  const total12h = b.newThreats.bySeverity.reduce((s, r) => s + Number(r.count), 0);

  const totalFeedRuns = b.feedProduction.reduce((s, f) => s + Number(f.runs), 0);
  const totalIngested = b.feedProduction.reduce((s, f) => s + Number(f.ingested), 0);
  const healthCounts: Record<string, number> = {};
  for (const h of b.feedHealth.summary) healthCounts[h.health_status] = Number(h.count);

  // 1) Title + date
  const titleBlock = `
  <tr><td style="padding:24px 28px 6px;">
    <div style="font-family:${FONT_MONO};font-size:10px;letter-spacing:0.22em;color:${COLOR.amber};text-transform:uppercase;">Daily Operations Briefing</div>
    <div style="font-size:20px;font-weight:700;color:${COLOR.text};margin-top:6px;line-height:1.25;">${escapeHtml(dateStr)}</div>
    <div style="font-size:12px;color:${COLOR.textDim};margin-top:4px;">${fmt(p.brandsMonitored)} brands monitored · ${fmt(p.brandsClassified)} classified</div>
  </td></tr>`;

  // 2) Geopolitical alert (if any) — full-width crimson card up top
  const geoBlock = b.geopoliticalCampaigns.length === 0 ? "" : b.geopoliticalCampaigns.map(gc => {
    let actors: string[] = [];
    try { actors = JSON.parse(gc.threat_actors || "[]"); } catch { /* noop */ }
    return `
    <tr><td style="padding:14px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1A0E0E;border:1px solid #5A1A1A;border-radius:10px;">
        <tr><td style="padding:14px 16px;border-bottom:1px solid #3D1515;">
          <div style="font-family:${FONT_MONO};font-size:11px;font-weight:700;letter-spacing:0.16em;color:${COLOR.red};text-transform:uppercase;">⚑ Geopolitical Alert · ${escapeHtml(gc.name)}</div>
        </td></tr>
        <tr><td style="padding:12px 16px;">
          <div style="font-size:12px;color:${COLOR.text};line-height:1.6;">
            Status <strong style="color:${COLOR.red};">${escapeHtml(gc.status.toUpperCase())}</strong>
            · Priority <strong style="color:${COLOR.orange};">${escapeHtml(gc.briefing_priority.toUpperCase())}</strong>
            · Since <strong style="color:${COLOR.amber};">${escapeHtml(gc.start_date)}</strong>
          </div>
          <div style="font-size:12px;color:${COLOR.text};line-height:1.6;margin-top:4px;">
            ${fmt(gc.total_threats)} threats total · <strong style="color:${COLOR.amber};">${fmt(gc.new_24h)}</strong> new in 24h · ${fmt(gc.brands_hit)} brands targeted
          </div>
          ${actors.length > 0 ? `<div style="font-family:${FONT_MONO};font-size:11px;color:${COLOR.orange};margin-top:6px;">Actors: ${escapeHtml(actors.join(", "))}</div>` : ""}
          ${gc.notes ? `<div style="font-size:12px;color:${COLOR.textDim};margin-top:6px;font-style:italic;">${escapeHtml(gc.notes)}</div>` : ""}
        </td></tr>
      </table>
    </td></tr>`;
  }).join("");

  // 3) 4-up overview grid
  const overviewGrid = `
  <tr><td style="padding:18px 28px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td width="25%" style="padding:0 6px 0 0;">${statTile(fmt(p.totalThreats), "Total Threats")}</td>
        <td width="25%" style="padding:0 6px;">${statTile(fmt(p.last24h), "New · 24h")}</td>
        <td width="25%" style="padding:0 6px;">${statTile(fmt(p.avgPerHour) + "/hr", "Hourly Rate")}</td>
        <td width="25%" style="padding:0 0 0 6px;">${statTile(`${dodStr} ${dodSym}`, "Day over Day", dodColor)}</td>
      </tr>
    </table>
  </td></tr>`;

  // 4) New threats (12h)
  const severityChips = b.newThreats.bySeverity.map(s =>
    `<span style="display:inline-block;margin-right:14px;font-family:${FONT_MONO};font-size:11px;color:${COLOR.text};">
      ${statusDot(severityColor(s.severity))} <span style="text-transform:capitalize;color:${COLOR.textDim};">${escapeHtml(s.severity)}</span> <strong style="color:${COLOR.text};">${fmt(s.count)}</strong>
    </span>`
  ).join("");

  const bySourceTable = b.newThreats.bySource.length > 0 ? card(`
    ${thead([{ text: "Source" }, { text: "Count", align: "right", width: "80px" }])}
    ${b.newThreats.bySource.map(s => tr([
      { html: escapeHtml(s.source_feed), mono: true },
      { html: fmt(s.count), align: "right", mono: true, color: COLOR.amber, bold: true },
    ])).join("")}
  `) : "";

  const notableList = b.newThreats.notable.length === 0 ? "" : `
    <div style="margin-top:10px;font-family:${FONT_MONO};font-size:9px;letter-spacing:0.22em;color:${COLOR.textDim};text-transform:uppercase;margin-bottom:6px;">Notable Critical / High</div>
    ${card(b.newThreats.notable.slice(0, 5).map(t => tr([
      { html: `${statusDot(severityColor(t.severity))} <span style="margin-left:6px;font-weight:600;color:${COLOR.text};">${escapeHtml(t.malicious_domain)}</span>` },
      { html: `<span style="color:${COLOR.textDim};font-family:${FONT_MONO};font-size:11px;">${escapeHtml(t.type)} · ${escapeHtml(t.severity)} · ${escapeHtml(t.source_feed)}</span>`, align: "right" },
    ])).join(""))}
  `;

  const newThreatsBody = section(
    "New Threats",
    `<div style="margin-bottom:10px;">
      <span style="font-family:${FONT_MONO};font-size:11px;color:${COLOR.textDim};">Last 12h:</span>
      <span style="font-family:${FONT_MONO};font-size:14px;color:${COLOR.amber};font-weight:700;margin-left:4px;">${fmt(total12h)}</span>
    </div>
    <div style="margin-bottom:14px;">${severityChips}</div>
    ${bySourceTable}
    ${notableList}
    <div style="height:8px;"></div>`,
    { eyebrow: "Section 1" }
  );

  // 5) Feed production + health (two-column on desktop, stacks via tables)
  const feedProductionTable = b.feedProduction.length === 0
    ? `<div style="font-size:12px;color:${COLOR.textMuted};font-family:${FONT_MONO};">No feed activity in window.</div>`
    : card(`
      ${thead([{ text: "Feed" }, { text: "Runs", align: "right", width: "60px" }, { text: "Ingested", align: "right", width: "90px" }])}
      ${b.feedProduction.slice(0, 12).map(f => tr([
        { html: escapeHtml(f.feed_name), mono: true },
        { html: fmt(f.runs), align: "right", mono: true, color: COLOR.textDim },
        { html: fmt(f.ingested), align: "right", mono: true, color: COLOR.amber, bold: true },
      ])).join("")}
    `);

  const healthChips = [
    healthCounts["healthy"] ? `${statusDot(COLOR.green)} <span style="color:${COLOR.text};margin-left:6px;">${healthCounts["healthy"]} healthy</span>` : "",
    healthCounts["degraded"] ? `${statusDot(COLOR.amber)} <span style="color:${COLOR.text};margin-left:6px;">${healthCounts["degraded"]} degraded</span>` : "",
    healthCounts["failed"] ? `${statusDot(COLOR.red)} <span style="color:${COLOR.text};margin-left:6px;">${healthCounts["failed"]} failed</span>` : "",
  ].filter(Boolean).join("<span style='display:inline-block;width:18px;'></span>");

  const feedIssues = [...b.feedHealth.degradedFeeds, ...b.feedHealth.staleFeeds];
  const feedIssuesHtml = feedIssues.length === 0
    ? `<div style="font-size:12px;color:${COLOR.green};font-family:${FONT_MONO};margin-top:8px;">✓ All feeds operational</div>`
    : feedIssues.slice(0, 6).map(f => {
        const err = "last_error" in f ? f.last_error : `last run ${f.last_successful_pull ?? "never"} (stale)`;
        return `<div style="font-family:${FONT_MONO};font-size:11px;color:${COLOR.amber};margin-top:6px;line-height:1.5;">⚠ ${escapeHtml(f.feed_name)} — ${escapeHtml(String(err ?? "unknown"))}</div>`;
      }).join("");

  const feedsBlock = section(
    "Feeds (12h)",
    `
    <div style="font-family:${FONT_MONO};font-size:11px;color:${COLOR.textDim};margin-bottom:10px;">
      ${b.feedProduction.length} active · ${fmt(totalFeedRuns)} runs · ${fmt(totalIngested)} records ingested
    </div>
    ${feedProductionTable}
    <div style="margin-top:14px;font-family:${FONT_MONO};font-size:9px;letter-spacing:0.22em;color:${COLOR.textDim};text-transform:uppercase;margin-bottom:6px;">Health</div>
    <div style="font-family:${FONT_MONO};font-size:12px;">${healthChips}</div>
    ${feedIssuesHtml}
    <div style="height:6px;"></div>
    `,
    { eyebrow: "Section 2" }
  );

  // 6) Enrichment pipeline
  const enrichmentRows = [
    { name: "SURBL",        checked: b.enrichment.surbl_checked, hits: b.enrichment.surbl_hits },
    { name: "VirusTotal",   checked: b.enrichment.vt_checked,    hits: b.enrichment.vt_hits },
    { name: "Google SB",    checked: b.enrichment.gsb_checked,   hits: b.enrichment.gsb_hits },
    { name: "Spamhaus DBL", checked: b.enrichment.dbl_checked,   hits: b.enrichment.dbl_hits },
    { name: "AbuseIPDB",    checked: b.enrichment.abuse_checked, hits: b.enrichment.abuse_hits },
    { name: "GreyNoise",    checked: b.enrichment.gn_checked,    hits: 0 },
    { name: "SecLookup",    checked: b.enrichment.sec_checked,   hits: 0 },
  ];
  const enrichmentBlock = section(
    "Enrichment Pipeline",
    card(`
      ${thead([{ text: "Engine" }, { text: "Checked", align: "right" }, { text: "Hits", align: "right" }, { text: "Hit Rate", align: "right", width: "70px" }, { text: " ", align: "center", width: "30px" }])}
      ${enrichmentRows.map(e => tr([
        { html: escapeHtml(e.name), mono: true },
        { html: fmt(e.checked), align: "right", mono: true, color: COLOR.textDim },
        { html: fmt(e.hits), align: "right", mono: true, color: e.hits > 0 ? COLOR.amber : COLOR.textMuted, bold: e.hits > 0 },
        { html: pct(e.hits, e.checked), align: "right", mono: true, color: COLOR.textDim },
        { html: e.checked > 0 ? statusDot(COLOR.green) : statusDot(COLOR.amber), align: "center" },
      ])).join("")}
    `),
    { eyebrow: "Section 3" }
  );

  // 7) Agent activity
  const agentBlock = section(
    "Agent Activity (12h)",
    b.agentActivity.length === 0
      ? `<div style="font-size:12px;color:${COLOR.textMuted};font-family:${FONT_MONO};">No agent activity in window.</div>`
      : card(`
        ${thead([{ text: "Agent" }, { text: "Runs", align: "right", width: "60px" }, { text: "Last Run", align: "right" }, { text: " ", align: "center", width: "30px" }])}
        ${b.agentActivity.slice(0, 12).map(a => {
          const lr = a.last_run ? new Date(a.last_run).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC" : "—";
          return tr([
            { html: escapeHtml(a.agent_id), mono: true },
            { html: fmt(a.runs), align: "right", mono: true, color: COLOR.amber },
            { html: lr, align: "right", mono: true, color: COLOR.textDim },
            { html: statusDot(COLOR.green), align: "center" },
          ]);
        }).join("")}
      `),
    { eyebrow: "Section 4" }
  );

  // 8) Spam trap + honeypot — compact summary cards side by side
  const spamTrapCard = card(`
    <tr><td style="padding:14px 16px;">
      <div style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.22em;color:${COLOR.amber};text-transform:uppercase;margin-bottom:6px;">Spam Trap</div>
      <div style="font-size:12px;color:${COLOR.text};line-height:1.8;">
        Seeds: <strong style="color:${COLOR.amber};">${fmt(b.spamTrap.totalSeeds)}</strong><br>
        Captures: <strong style="color:${COLOR.amber};">${fmt(b.spamTrap.totalCaptures)}</strong>
        <span style="color:${COLOR.textDim};">(${fmt(b.spamTrap.captures12h)} new in 12h)</span>
      </div>
    </td></tr>
  `);
  const honeypotCard = card(`
    <tr><td style="padding:14px 16px;">
      <div style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.22em;color:${COLOR.amber};text-transform:uppercase;margin-bottom:6px;">Honeypot</div>
      <div style="font-size:12px;color:${COLOR.text};line-height:1.8;">
        Visits: <strong style="color:${COLOR.amber};">${fmt(b.honeypot.totalVisits)}</strong>
        <span style="color:${COLOR.textDim};">(${fmt(b.honeypot.botVisits)} bots · ${fmt(b.honeypot.humanVisits)} humans)</span><br>
        Last 12h: <strong style="color:${COLOR.amber};">${fmt(b.honeypot.visits12h)}</strong>
      </div>
    </td></tr>
  `);
  const trapsBlock = `
  <tr><td style="padding:22px 28px 6px;">
    <div style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.22em;color:${COLOR.amber};text-transform:uppercase;margin-bottom:2px;">Section 5</div>
    <div style="font-size:13px;font-weight:700;letter-spacing:0.04em;color:${COLOR.text};">Traps &amp; Honeypots</div>
  </td></tr>
  <tr><td style="padding:0 28px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td width="50%" style="padding:0 6px 0 0;vertical-align:top;">${spamTrapCard}</td>
        <td width="50%" style="padding:0 0 0 6px;vertical-align:top;">${honeypotCard}</td>
      </tr>
    </table>
  </td></tr>`;

  const suspiciousHits = b.honeypot.suspiciousHumans.slice(0, 4).map(h => {
    const label = h.reason === "bait" ? "Bait hit" : "Recon probe";
    const time = h.visited_at
      ? new Date(h.visited_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC"
      : "—";
    const asn = h.asn ? ` AS${escapeHtml(h.asn)}` : "";
    return `<div style="font-family:${FONT_MONO};font-size:11px;color:${COLOR.orange};margin-top:6px;line-height:1.5;">⚠ ${label}: ${escapeHtml(h.country || "??")}${asn} → ${escapeHtml(h.page)} at ${time}</div>`;
  }).join("");
  const suspiciousBlock = suspiciousHits ? `
  <tr><td style="padding:6px 28px 4px;">
    <div style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.22em;color:${COLOR.textDim};text-transform:uppercase;margin-top:6px;">Recon &amp; Bait Hits (7d)</div>
    ${suspiciousHits}
  </td></tr>` : "";

  // 9) Top targeted brands — compact
  const topBrandsBlock = section(
    "Top Targeted Brands (24h)",
    b.topTargetedBrands.length === 0
      ? `<div style="font-size:12px;color:${COLOR.textMuted};font-family:${FONT_MONO};">No brand-attributed threats in window.</div>`
      : card(b.topTargetedBrands.slice(0, 10).map((brand, i) => tr([
          { html: `<span style="color:${COLOR.textMuted};font-family:${FONT_MONO};">${(i + 1).toString().padStart(2, "0")}</span>`, width: "32px" },
          { html: escapeHtml(brand.name), bold: true },
          { html: fmt(brand.threats_24h), align: "right", mono: true, color: COLOR.amber, bold: true, width: "80px" },
        ])).join("")),
    { eyebrow: "Section 6" }
  );

  // 10) Anomalies & status
  const anomalies: string[] = [];
  const oks: string[] = [];
  if (b.enrichment.gn_checked === 0)
    anomalies.push("GreyNoise: 0 enrichments — API may not be returning data");
  if (b.enrichment.sec_checked === 0)
    anomalies.push("SecLookup: 0 enrichments — API may not be returning data");
  if (b.newCapabilities.certstream === 0)
    anomalies.push("CertStream: alive but 0 captures");
  for (const f of b.feedHealth.degradedFeeds)
    anomalies.push(`${f.feed_name}: degraded — ${f.last_error ?? "unknown"}`);

  if (b.agentActivity.length > 0)
    oks.push(`All ${b.agentActivity.length} agents running normally`);
  const producingEngines = [
    b.enrichment.surbl_checked, b.enrichment.vt_checked, b.enrichment.gsb_checked,
    b.enrichment.dbl_checked, b.enrichment.abuse_checked, b.enrichment.gn_checked,
    b.enrichment.sec_checked,
  ].filter(v => v > 0).length;
  oks.push(`Enrichment pipeline operational (${producingEngines} of 7 engines producing)`);
  if (b.newCapabilities.typosquat_new > 0)
    oks.push(`Typosquat scanner active — ${fmt(b.newCapabilities.typosquat_new)} new domains`);
  else if (b.newCapabilities.typosquat_total > 0)
    oks.push(`Typosquat scanner active — ${fmt(b.newCapabilities.typosquat_total)} total domains`);
  if (b.newCapabilities.appstore_new > 0)
    oks.push(`App-store monitor — ${fmt(b.newCapabilities.appstore_new)} new (${fmt(b.newCapabilities.appstore_total)} active)`);
  if (b.newCapabilities.darkweb_new > 0)
    oks.push(`Dark-web monitor — ${fmt(b.newCapabilities.darkweb_new)} new (${fmt(b.newCapabilities.darkweb_total)} active)`);

  const anomaliesBlock = section(
    "Status",
    `
    <div style="display:block;">
      ${anomalies.map(text => `<div style="font-family:${FONT_MONO};font-size:11px;color:${COLOR.amber};line-height:1.6;padding:4px 0;">⚠ ${escapeHtml(text)}</div>`).join("")}
      ${oks.map(text => `<div style="font-family:${FONT_MONO};font-size:11px;color:${COLOR.green};line-height:1.6;padding:4px 0;">✓ ${escapeHtml(text)}</div>`).join("")}
    </div>
    `,
    { eyebrow: "Section 7" }
  );

  // 11) Brand coverage — compact one-liner
  const brandCoverageBlock = b.brandCoverage.length === 0 ? "" : `
  <tr><td style="padding:22px 28px 6px;">
    <div style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.22em;color:${COLOR.amber};text-transform:uppercase;margin-bottom:2px;">Section 8</div>
    <div style="font-size:13px;font-weight:700;letter-spacing:0.04em;color:${COLOR.text};">Brand Coverage</div>
  </td></tr>
  <tr><td style="padding:0 28px 18px;">
    <div style="font-family:${FONT_MONO};font-size:12px;color:${COLOR.textDim};line-height:1.7;">
      ${fmt(p.brandsMonitored)} monitored · ${fmt(p.brandsClassified)} classified<br>
      <span style="color:${COLOR.text};">Top sectors:</span>
      ${b.brandCoverage.slice(0, 5).map(c => `<span style="color:${COLOR.text};">${escapeHtml(c.sector)}</span> <span style="color:${COLOR.textDim};">(${fmt(c.brands)})</span>`).join(" · ")}
    </div>
  </td></tr>`;

  // CTA back to dashboard
  const ctaBlock = `
  <tr><td style="padding:10px 28px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
      <a class="av-cta" href="https://averrow.com/v2/admin" style="display:inline-block;padding:13px 28px;background:linear-gradient(180deg,${COLOR.amber} 0%,#B8821F 100%);color:#0B1320;font-family:${FONT_MONO};font-size:11px;font-weight:700;letter-spacing:0.16em;text-decoration:none;border-radius:8px;text-transform:uppercase;">Open Admin Dashboard</a>
    </td></tr></table>
  </td></tr>`;

  return [
    titleBlock,
    geoBlock,
    overviewGrid,
    newThreatsBody,
    feedsBlock,
    enrichmentBlock,
    agentBlock,
    trapsBlock,
    suspiciousBlock,
    topBrandsBlock,
    anomaliesBlock,
    brandCoverageBlock,
    ctaBlock,
  ].join("");
}

function buildBriefingHtml(b: ComprehensiveBriefing, title: string): string {
  const ok = b.statusBadge === "OPERATIONAL";
  return emailShell({
    title: `${title} — Averrow`,
    preheader: `${b.statusBadge}: ${fmt(b.platformOverview.last24h)} new threats · ${fmt(b.platformOverview.brandsMonitored)} brands monitored`,
    accent: ok ? "#E5A832" : "#FB923C",
    tagline: "INTELLIGENCE BRIEFING",
    headerBadge: headerStatusBadge(b.statusBadge, ok ? "ok" : "warn"),
    body: buildBriefingBody(b),
    footerNote: `Generated ${new Date(b.generatedAt).toLocaleString("en-US", { timeZone: "UTC", hour12: false })} UTC · Next briefing 08:00 ET`,
  });
}

// ─── Public API ────────────────────────────────────────────────

export async function sendBriefingEmail(
  env: Env,
  briefing: ComprehensiveBriefing,
  title: string,
): Promise<{ sent: boolean; id?: string; error?: string; recipient: string }> {
  const recipient = (env.BRIEFING_RECIPIENT?.trim() || RECIPIENT_DEFAULT);

  if (!env.RESEND_API_KEY) {
    logger.warn("briefing_email_skip", { reason: "RESEND_API_KEY not configured" });
    return { sent: false, error: "RESEND_API_KEY not configured", recipient };
  }

  const subject = `${briefing.statusBadge === "DEGRADED" ? "[DEGRADED] " : ""}${title}`;
  const html = buildBriefingHtml(briefing, title);

  const result = await sendViaResend(env, env.RESEND_API_KEY, recipient, subject, html);
  if (result.ok) {
    logger.info("briefing_email_sent", { to: recipient, resendId: result.id });
  } else {
    logger.error("briefing_email_failed", {
      to: recipient,
      error: result.error,
      statusCode: result.statusCode,
      errorName: result.errorName,
    });
  }
  return { sent: result.ok, id: result.id, error: result.error, recipient };
}

// Exported for the preview/render scripts to render the body without sending.
export function renderBriefingHtmlForPreview(
  briefing: ComprehensiveBriefing,
  title: string,
): string {
  return buildBriefingHtml(briefing, title);
}
