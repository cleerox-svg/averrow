/**
 * Averrow — Public Incident Archive
 *
 * Served at /status/incidents. No auth. Lists all public incidents
 * (open + resolved), newest first. /status itself only shows the
 * five most recent resolved — this page is the long-tail view for
 * customers who want to see the full history.
 *
 * Visibility gate is identical to /status: only rows with
 * visibility='public' AND public_title set appear, and per-update
 * text uses public_message via toPublicShape.
 *
 * Server-rendered. No JS, no auth, no SPA dependency — keeps
 * working when the React app is broken.
 */
import { wrapPage } from "./shared";
import {
  listIncidents,
  listIncidentUpdates,
  toPublicShape,
  type PublicIncident,
} from "../lib/incidents";
import type { Env } from "../types";

interface PalettePill {
  bg: string;
  border: string;
  text: string;
}

const STATUS_PILL: Record<"operational" | "degraded" | "outage", PalettePill> = {
  operational: { bg: "rgba(34,197,94,0.10)",  border: "rgba(34,197,94,0.35)",  text: "#22c55e" },
  degraded:    { bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.35)", text: "#fbbf24" },
  outage:      { bg: "rgba(248,113,113,0.10)", border: "rgba(248,113,113,0.35)", text: "#f87171" },
};

function statusPillFor(status: PublicIncident["status"]): PalettePill {
  if (status === "resolved") return STATUS_PILL.operational;
  if (status === "monitoring") return STATUS_PILL.degraded;
  return STATUS_PILL.outage;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c] ?? c));
}

function statusLabel(status: PublicIncident["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function renderArchiveCard(inc: PublicIncident): string {
  const stPill = statusPillFor(inc.status);
  const startedLabel = new Date(inc.started_at).toUTCString();
  const resolvedLabel = inc.resolved_at ? new Date(inc.resolved_at).toUTCString() : null;
  return `
  <a href="/status/incidents/${escapeHtml(inc.id)}" class="archive-card">
    <div class="archive-card-head">
      <div class="archive-card-title">${escapeHtml(inc.title)}</div>
      <div class="archive-card-pill" style="background:${stPill.bg};border:1px solid ${stPill.border};color:${stPill.text}">
        ${escapeHtml(statusLabel(inc.status))}
      </div>
    </div>
    ${inc.details ? `<div class="archive-card-details">${escapeHtml(inc.details)}</div>` : ""}
    <div class="archive-card-foot">
      <span>Started ${escapeHtml(startedLabel)}</span>
      ${resolvedLabel ? `<span>· Resolved ${escapeHtml(resolvedLabel)}</span>` : ""}
    </div>
  </a>`;
}

function groupByMonth(incidents: PublicIncident[]): Array<{ month: string; rows: PublicIncident[] }> {
  const buckets = new Map<string, PublicIncident[]>();
  for (const inc of incidents) {
    const d = new Date(inc.started_at);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(inc);
  }
  // Newest month first; descending across the map.
  return [...buckets.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, rows]) => {
      const [yyyy, mm] = key.split("-");
      const monthName = new Date(`${yyyy}-${mm}-01T00:00:00Z`)
        .toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      return { month: monthName, rows };
    });
}

export async function renderIncidentArchivePage(env: Env): Promise<string> {
  // Pull a generous slice. Public incident volume is low enough
  // that one query covers months of history.
  let publics: PublicIncident[] = [];
  try {
    const rows = await listIncidents(env, { visibility: "public", limit: 200 });
    for (const row of rows) {
      const updates = await listIncidentUpdates(env, row.id);
      const publicUpdates = updates.filter((u) => u.visibility === "public");
      const shape = toPublicShape(row, publicUpdates);
      if (shape) publics.push(shape);
    }
  } catch {
    publics = [];
  }

  // Newest first.
  publics.sort((a, b) => b.started_at.localeCompare(a.started_at));

  const grouped = groupByMonth(publics);

  const body = grouped.length === 0
    ? `<div class="archive-empty">No public incidents on record.</div>`
    : grouped.map((g) => `
        <h2 class="archive-month">${escapeHtml(g.month)}</h2>
        <div class="archive-list">
          ${g.rows.map(renderArchiveCard).join("")}
        </div>
      `).join("");

  return wrapPage(
    "Incident History — Averrow Status",
    "Full history of public incidents on the Averrow threat intelligence platform.",
    `
<style>
.archive-shell { max-width: 760px; margin: 0 auto; padding: 6rem 1.5rem 4rem; box-sizing: border-box; width: 100%; }
.archive-shell, .archive-shell * { box-sizing: border-box; }

.archive-back { font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); text-decoration: none; letter-spacing: 0.06em; }
.archive-back:hover { color: var(--text-secondary); }

.archive-title { font-family: var(--font-display); font-size: clamp(28px, 4vw, 40px); font-weight: 700; margin: 1rem 0 0.25rem; color: var(--text-primary); }
.archive-sub { font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary); letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 1.5rem; }

.archive-month { font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--text-secondary); letter-spacing: 0.04em; text-transform: uppercase; margin: 1.5rem 0 0.5rem; padding-bottom: 0.4rem; border-bottom: 1px dashed rgba(255,255,255,0.06); }

.archive-list { display: flex; flex-direction: column; gap: 8px; }

.archive-card { display: block; background: var(--bg-card, rgba(22,30,48,0.55)); border: 1px solid var(--border-base, rgba(255,255,255,0.06)); border-radius: 10px; padding: 14px 16px; text-decoration: none; color: inherit; transition: border-color 0.15s ease, transform 0.15s ease; }
.archive-card:hover { border-color: rgba(229,168,50,0.30); transform: translateY(-1px); }
.archive-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.archive-card-title { font-family: var(--font-display); font-size: 14px; font-weight: 600; color: var(--text-primary); flex: 1; min-width: 0; }
.archive-card-pill { font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 8px; border-radius: 100px; flex-shrink: 0; }
.archive-card-details { font-size: 13px; color: var(--text-secondary); margin: 4px 0 8px; line-height: 1.5; }
.archive-card-foot { display: flex; gap: 8px; font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); letter-spacing: 0.04em; flex-wrap: wrap; }

.archive-empty { font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary); padding: 2rem; text-align: center; background: var(--bg-card, rgba(22,30,48,0.4)); border: 1px solid var(--border-base, rgba(255,255,255,0.06)); border-radius: 10px; }

[data-theme="light"] .archive-card,
[data-theme="light"] .archive-empty { background: rgba(255,255,255,0.6); border-color: rgba(26,31,46,0.08); }

@media (max-width: 600px) {
  .archive-shell { padding: 5rem 12px 3rem; max-width: 100%; }
  .archive-card { padding: 12px 14px; }
}
</style>

<div class="archive-shell">
  <a href="/status" class="archive-back">← Status</a>
  <h1 class="archive-title">Incident History</h1>
  <p class="archive-sub">Full record · ${publics.length} public incident${publics.length === 1 ? "" : "s"}</p>
  ${body}
</div>
`,
  );
}
