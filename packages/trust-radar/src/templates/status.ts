/**
 * Averrow — Public Platform Status Page
 *
 * Served at /status. No auth. Surfaces the same 30-day uptime rollup
 * the Home banner reads (lib/platform-status), with a per-day bar
 * timeline for each of the three categories (Feeds, Agents,
 * Processing).
 *
 * Server-rendered with the status data baked into the HTML so the
 * first paint shows real numbers — no flash of empty state. A small
 * inline script re-fetches /api/v1/public/platform-status every 60s
 * and re-renders the bars + headline without a full page reload, so
 * a long-resident tab stays accurate without putting load on D1.
 *
 * Designed to keep working when the React app is broken — pure HTML
 * + a single fetch, no module imports, no auth dependencies.
 */
import { wrapPage } from "./shared";
import { computePlatformStatus } from "../lib/platform-status";
import {
  listIncidents,
  listIncidentUpdates,
  toPublicShape,
  type PublicIncident,
} from "../lib/incidents";
import type {
  PlatformStatus,
  CategoryStatus,
  CategoryRollup,
  DailyPoint,
} from "@averrow/shared";
import { CATEGORY_LABELS } from "@averrow/shared";
import type { Env } from "../types";

interface PalettePill {
  bg: string;
  border: string;
  text: string;
}

const STATUS_PILL: Record<CategoryStatus, PalettePill> = {
  operational: { bg: "rgba(34,197,94,0.10)",  border: "rgba(34,197,94,0.35)",  text: "#22c55e" },
  degraded:    { bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.35)", text: "#fbbf24" },
  outage:      { bg: "rgba(248,113,113,0.10)", border: "rgba(248,113,113,0.35)", text: "#f87171" },
};

const STATUS_HEADLINE: Record<CategoryStatus, string> = {
  operational: "All Systems Operational",
  degraded:    "Some Services Degraded",
  outage:      "Service Disruption",
};

const BAR_COLOR: Record<CategoryStatus, string> = {
  operational: "#22c55e",
  degraded:    "#fbbf24",
  outage:      "#f87171",
};

function renderBars(daily: DailyPoint[]): string {
  return daily.map(d => {
    const tooltip = `${d.date} — ${d.status} (${d.uptime_pct}% uptime${d.note ? ` · ${d.note.replace(/"/g, "&quot;")}` : ""})`;
    return `<div class="status-bar" data-status="${d.status}" data-tooltip="${tooltip}" style="background:${BAR_COLOR[d.status]}"></div>`;
  }).join("");
}

function renderRow(rollup: CategoryRollup): string {
  const label = CATEGORY_LABELS[rollup.category];
  const pill = STATUS_PILL[rollup.realtime];
  const realtimeNote = rollup.realtime_note.replace(/"/g, "&quot;");
  const oldestDate = rollup.daily[0]?.date ?? "";
  const newestDate = rollup.daily[rollup.daily.length - 1]?.date ?? "";
  return `
  <div class="status-row">
    <div class="status-row-head">
      <div class="status-row-title">${label}</div>
      <div class="status-row-pill" style="background:${pill.bg};border:1px solid ${pill.border};color:${pill.text}" title="${realtimeNote}">
        ${rollup.realtime === "operational" ? "Operational" : rollup.realtime === "degraded" ? "Degraded" : "Outage"}
      </div>
    </div>
    <div class="status-bars" data-category="${rollup.category}">${renderBars(rollup.daily)}</div>
    <div class="status-row-foot">
      <span>${oldestDate}</span>
      <span class="status-row-uptime">${rollup.uptime_30d_pct.toFixed(2)}% uptime</span>
      <span>${newestDate}</span>
    </div>
  </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c] ?? c));
}

function renderBanner(status: PlatformStatus, openIncident: PublicIncident | null): string {
  // An open critical/high incident takes over the banner — the
  // headline reads as the incident, not the platform-wide rollup.
  // Lower-severity incidents render in the recent-incidents list
  // below without hijacking the headline.
  if (openIncident && (openIncident.severity === "critical" || openIncident.severity === "high")) {
    const pill = STATUS_PILL.outage;
    const sevLabel = openIncident.severity === "critical" ? "CRITICAL" : "HIGH";
    return `
  <div id="status-banner" class="status-banner" data-overall="incident" style="background:${pill.bg};border:1px solid ${pill.border};color:${pill.text}">
    <div class="status-banner-headline">${sevLabel} INCIDENT — ${escapeHtml(openIncident.title)}</div>
    <div class="status-banner-sub">
      Status: ${openIncident.status} · Started ${new Date(openIncident.started_at).toUTCString()}
      &nbsp;·&nbsp;<a href="/status/incidents/${openIncident.id}" style="color:inherit;border-bottom:1px dashed currentColor">Details →</a>
    </div>
  </div>`;
  }

  const pill = STATUS_PILL[status.overall];
  const headline = STATUS_HEADLINE[status.overall];
  return `
  <div id="status-banner" class="status-banner" data-overall="${status.overall}" style="background:${pill.bg};border:1px solid ${pill.border};color:${pill.text}">
    <div class="status-banner-headline">${headline}</div>
    ${status.overall !== "operational"
      ? `<div class="status-banner-sub">${escapeHtml(status.overall_note)}</div>`
      : ""}
  </div>`;
}

function renderIncidentCard(inc: PublicIncident): string {
  const isResolved = inc.status === "resolved";
  const pill = isResolved ? STATUS_PILL.operational : STATUS_PILL.outage;
  const startedLabel = new Date(inc.started_at).toUTCString();
  const updates = inc.updates.length > 0
    ? `<div class="incident-updates">
         ${inc.updates.slice(-3).map((u) => `
           <div class="incident-update">
             <span class="incident-update-time">${new Date(u.created_at).toUTCString()}</span>
             ${u.status ? `<span class="incident-update-status">${escapeHtml(u.status)}</span>` : ""}
             <span class="incident-update-msg">${escapeHtml(u.message)}</span>
           </div>
         `).join("")}
       </div>`
    : "";
  return `
  <div class="incident-card">
    <div class="incident-card-head">
      <a href="/status/incidents/${escapeHtml(inc.id)}" class="incident-card-title-link">
        <div class="incident-card-title">${escapeHtml(inc.title)}</div>
      </a>
      <div class="incident-card-pill" style="background:${pill.bg};border:1px solid ${pill.border};color:${pill.text}">
        ${isResolved ? "Resolved" : escapeHtml(inc.status)}
      </div>
    </div>
    ${inc.details ? `<div class="incident-card-details">${escapeHtml(inc.details)}</div>` : ""}
    <div class="incident-card-foot">
      Started ${startedLabel}${inc.resolved_at ? ` · Resolved ${new Date(inc.resolved_at).toUTCString()}` : ""}
    </div>
    ${updates}
  </div>`;
}

function renderIncidentsSection(incidents: PublicIncident[]): string {
  if (incidents.length === 0) return "";
  return `
  <h2 class="incidents-section-title">Recent Incidents</h2>
  <div class="incidents-list">
    ${incidents.map(renderIncidentCard).join("")}
  </div>
  <div class="incidents-archive-link">
    <a href="/status/incidents">View full incident history →</a>
  </div>`;
}

async function loadPublicIncidents(env: Env): Promise<PublicIncident[]> {
  // Pull every public incident, then narrow to:
  //   - all open (status != 'resolved')
  //   - the 5 most recent resolved
  // so the page shows context without scrolling forever.
  try {
    const rows = await listIncidents(env, { visibility: "public", limit: 50 });
    const out: PublicIncident[] = [];
    for (const row of rows) {
      const updates = await listIncidentUpdates(env, row.id);
      const publicUpdates = updates.filter((u) => u.visibility === "public");
      const shape = toPublicShape(row, publicUpdates);
      if (shape) out.push(shape);
    }
    const open = out.filter((i) => i.status !== "resolved");
    const resolved = out.filter((i) => i.status === "resolved").slice(0, 5);
    return [...open, ...resolved];
  } catch {
    return [];
  }
}

export async function renderStatusPage(env: Env): Promise<string> {
  // Fail soft: if the calculator throws (D1 hiccup), render the
  // shell with a "checking…" banner so the page itself never goes
  // down. The polling script will retry every 60s.
  let status: PlatformStatus | null = null;
  try {
    status = await computePlatformStatus(env);
  } catch {
    status = null;
  }

  const incidents = await loadPublicIncidents(env);
  const openIncident = incidents.find((i) => i.status !== "resolved") ?? null;

  const inlineData = status
    ? `<script id="status-data" type="application/json">${JSON.stringify(status).replace(/</g, "\\u003c")}</script>`
    : "";

  const initialBanner = status
    ? renderBanner(status, openIncident)
    : `<div id="status-banner" class="status-banner" data-overall="loading" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);color:var(--text-secondary)">
        <div class="status-banner-headline">Checking platform status…</div>
       </div>`;

  const initialRows = status
    ? status.categories.map(renderRow).join("")
    : `<div class="status-row"><div class="status-row-head"><div class="status-row-title">Loading…</div></div></div>`;

  const incidentsSection = renderIncidentsSection(incidents);

  const lastChecked = status?.generated_at ?? new Date().toISOString();

  return wrapPage(
    "Status — Averrow",
    "Real-time uptime for Averrow's threat intelligence platform — feeds, agents, and processing.",
    `
<style>
/* Top padding clears the fixed marketing nav (~64px) — same pattern
   the /platform and /security pages use. box-sizing keeps the inner
   max-width math honest when the viewport is narrower than 760px. */
.status-shell { max-width: 760px; margin: 0 auto; padding: 6rem 1.5rem 4rem; box-sizing: border-box; width: 100%; }
.status-shell, .status-shell * { box-sizing: border-box; }
.status-title { font-family: var(--font-display); font-size: clamp(28px, 4vw, 40px); font-weight: 700; margin: 0 0 0.25rem; color: var(--text-primary); }
.status-sub { font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary); letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 2rem; }

.status-banner { padding: 1.25rem 1.5rem; border-radius: 12px; margin-bottom: 2rem; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
.status-banner-headline { font-family: var(--font-display); font-size: 22px; font-weight: 700; }
.status-banner-sub { margin-top: 0.4rem; font-size: 13px; color: var(--text-secondary); font-family: var(--font-mono); }

.status-row { background: var(--bg-card, rgba(22,30,48,0.65)); border: 1px solid var(--border-base, rgba(255,255,255,0.08)); border-radius: 12px; padding: 1.1rem 1.25rem; margin-bottom: 0.9rem; backdrop-filter: blur(8px); }
.status-row-head { display:flex; align-items:center; justify-content:space-between; margin-bottom: 0.85rem; }
.status-row-title { font-family: var(--font-display); font-size: 17px; font-weight: 600; color: var(--text-primary); }
.status-row-pill { font-family: var(--font-mono); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 10px; border-radius: 100px; }

.status-bars { display: grid; grid-template-columns: repeat(30, 1fr); gap: 3px; height: 32px; margin-bottom: 0.6rem; }
.status-bar { border-radius: 2px; cursor: pointer; transition: transform 0.12s ease, opacity 0.12s ease; opacity: 0.85; }
.status-bar:hover { transform: scaleY(1.08); opacity: 1; }

.status-row-foot { display:flex; justify-content:space-between; font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); letter-spacing: 0.05em; }
.status-row-uptime { color: var(--text-secondary); font-weight: 600; }

.status-tooltip { position: fixed; pointer-events: none; padding: 6px 10px; background: rgba(20,26,38,0.97); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--text-primary); white-space: nowrap; z-index: 1000; opacity: 0; transition: opacity 0.1s ease; }
.status-tooltip.visible { opacity: 1; }

.status-meta { font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); text-align: center; margin-top: 1.5rem; letter-spacing: 0.05em; }
.status-meta a { color: var(--accent, var(--amber, #E5A832)); text-decoration: none; border-bottom: 1px dashed currentColor; }

/* ── Incidents section ─────────────────────────────────────────── */
.incidents-section-title { font-family: var(--font-display); font-size: 16px; font-weight: 700; color: var(--text-primary); margin: 2rem 0 0.75rem; letter-spacing: -0.01em; }
.incidents-archive-link { margin-top: 12px; text-align: right; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.06em; }
.incidents-archive-link a { color: var(--accent, var(--amber, #E5A832)); text-decoration: none; border-bottom: 1px dashed currentColor; }
.incidents-list { display: flex; flex-direction: column; gap: 8px; }
.incident-card { background: var(--bg-card, rgba(22,30,48,0.65)); border: 1px solid var(--border-base, rgba(255,255,255,0.08)); border-radius: 10px; padding: 14px 16px; backdrop-filter: blur(8px); }
.incident-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.incident-card-title-link { text-decoration: none; color: inherit; flex: 1; min-width: 0; }
.incident-card-title-link:hover .incident-card-title { color: var(--accent, var(--amber, #E5A832)); }
.incident-card-title { font-family: var(--font-display); font-size: 14px; font-weight: 600; color: var(--text-primary); transition: color 0.15s ease; }
.incident-card-pill { font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 8px; border-radius: 100px; flex-shrink: 0; }
.incident-card-details { font-size: 13px; color: var(--text-secondary); margin: 4px 0 8px; line-height: 1.5; }
.incident-card-foot { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); letter-spacing: 0.04em; }
.incident-updates { margin-top: 10px; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.06); display: flex; flex-direction: column; gap: 4px; }
.incident-update { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
.incident-update-time { color: var(--text-tertiary); }
.incident-update-status { color: var(--amber); font-weight: 700; text-transform: uppercase; font-size: 9px; letter-spacing: 0.08em; }
.incident-update-msg { flex: 1; min-width: 0; }
[data-theme="light"] .incident-card { background: rgba(255,255,255,0.6); border-color: rgba(26,31,46,0.08); }

[data-theme="light"] .status-row { background: rgba(255,255,255,0.6); border-color: rgba(26,31,46,0.08); }
[data-theme="light"] .status-bar { opacity: 0.9; }

@media (max-width: 600px) {
  .status-shell { padding: 5rem 12px 3rem; max-width: 100%; }
  .status-row { padding: 14px 14px; margin-bottom: 10px; border-radius: 10px; }
  .status-bars { gap: 2px; height: 26px; }
  .status-banner-headline { font-size: 17px; }
  .status-banner { padding: 14px 14px; }
  .status-row-foot { font-size: 10px; }
  .status-title { font-size: 24px; }
  .status-row-pill { font-size: 9px; padding: 3px 8px; }
}

/* Sub-360px (small Android phones / iPhone SE in landscape preview) —
   give the rows breathing room so the day labels don't truncate. */
@media (max-width: 360px) {
  .status-shell { padding: 5rem 8px 2.5rem; }
  .status-row { padding: 12px 10px; }
  .status-banner { padding: 12px 12px; }
}
</style>

<div class="status-shell">
  <h1 class="status-title">Averrow Platform Status</h1>
  <p class="status-sub">Live uptime for the threat intelligence platform · Updated every minute</p>

  <div id="status-banner-host">${initialBanner}</div>
  <div id="status-rows">${initialRows}</div>

  <div id="status-incidents-host">${incidentsSection}</div>

  <div class="status-meta">
    Last checked: <span id="status-last-checked">${lastChecked}</span>
    &middot; <a href="/status/feed.xml">Subscribe (RSS)</a>
  </div>
</div>

<div class="status-tooltip" id="status-tooltip" role="tooltip"></div>

${inlineData}

<script>
(function () {
  var BAR_COLOR = {
    operational: '#22c55e',
    degraded:    '#fbbf24',
    outage:      '#f87171'
  };
  var HEADLINE = {
    operational: 'All Systems Operational',
    degraded:    'Some Services Degraded',
    outage:      'Service Disruption'
  };
  var PILL = {
    operational: { bg: 'rgba(34,197,94,0.10)',  border: 'rgba(34,197,94,0.35)',  text: '#22c55e' },
    degraded:    { bg: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.35)', text: '#fbbf24' },
    outage:      { bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.35)', text: '#f87171' }
  };
  var LABELS = ${JSON.stringify(CATEGORY_LABELS)};

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]); }); }

  function pillFor(s) {
    return PILL[s] || { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.12)', text: 'var(--text-secondary)' };
  }

  function renderBanner(status) {
    var p = pillFor(status.overall);
    var sub = status.overall !== 'operational' && status.overall_note
      ? '<div class="status-banner-sub">' + escapeHtml(status.overall_note) + '</div>'
      : '';
    return '<div id="status-banner" class="status-banner" data-overall="' + status.overall +
      '" style="background:' + p.bg + ';border:1px solid ' + p.border + ';color:' + p.text + '">' +
      '<div class="status-banner-headline">' + (HEADLINE[status.overall] || 'Checking platform status…') + '</div>' +
      sub +
      '</div>';
  }

  function renderRow(rollup) {
    var bars = rollup.daily.map(function (d) {
      var tip = d.date + ' — ' + d.status + ' (' + d.uptime_pct + '% uptime' + (d.note ? ' · ' + d.note : '') + ')';
      return '<div class="status-bar" data-status="' + d.status + '" data-tooltip="' + escapeHtml(tip) + '" style="background:' + (BAR_COLOR[d.status] || '#9ca3af') + '"></div>';
    }).join('');
    var p = pillFor(rollup.realtime);
    var pillLabel = rollup.realtime === 'operational' ? 'Operational' : rollup.realtime === 'degraded' ? 'Degraded' : 'Outage';
    var oldest = rollup.daily.length > 0 ? rollup.daily[0].date : '';
    var newest = rollup.daily.length > 0 ? rollup.daily[rollup.daily.length - 1].date : '';
    return '<div class="status-row">' +
      '<div class="status-row-head">' +
        '<div class="status-row-title">' + (LABELS[rollup.category] || rollup.category) + '</div>' +
        '<div class="status-row-pill" style="background:' + p.bg + ';border:1px solid ' + p.border + ';color:' + p.text + '" title="' + escapeHtml(rollup.realtime_note || '') + '">' + pillLabel + '</div>' +
      '</div>' +
      '<div class="status-bars" data-category="' + rollup.category + '">' + bars + '</div>' +
      '<div class="status-row-foot">' +
        '<span>' + oldest + '</span>' +
        '<span class="status-row-uptime">' + rollup.uptime_30d_pct.toFixed(2) + '% uptime</span>' +
        '<span>' + newest + '</span>' +
      '</div>' +
    '</div>';
  }

  function applyStatus(status) {
    var bannerHost = document.getElementById('status-banner-host');
    var rows = document.getElementById('status-rows');
    var lastChecked = document.getElementById('status-last-checked');
    if (bannerHost) bannerHost.innerHTML = renderBanner(status);
    if (rows) rows.innerHTML = (status.categories || []).map(renderRow).join('');
    if (lastChecked) lastChecked.textContent = status.generated_at;
    bindTooltips();
  }

  // Tooltip — single floating element so we don't pay 90 separate
  // listeners. Re-bound after every re-render.
  var tip = document.getElementById('status-tooltip');
  function bindTooltips() {
    var bars = document.querySelectorAll('.status-bar');
    bars.forEach(function (el) {
      el.addEventListener('mouseenter', function () {
        if (!tip) return;
        tip.textContent = el.getAttribute('data-tooltip') || '';
        tip.classList.add('visible');
      });
      el.addEventListener('mousemove', function (ev) {
        if (!tip) return;
        var x = ev.clientX + 14;
        var y = ev.clientY - 8;
        tip.style.left = x + 'px';
        tip.style.top  = y + 'px';
      });
      el.addEventListener('mouseleave', function () {
        if (tip) tip.classList.remove('visible');
      });
    });
  }
  bindTooltips();

  // Keep the page accurate without a full reload. 60s mirrors the
  // KV cache TTL on the worker; the request short-circuits at the
  // edge most of the time.
  function refresh() {
    fetch('/api/v1/public/platform-status', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data && data.categories) applyStatus(data); })
      .catch(function () { /* swallow — next tick will retry */ });
  }
  setInterval(refresh, 60000);
})();
</script>
    `,
  );
}
