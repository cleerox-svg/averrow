/**
 * Averrow — Public Incident Detail Page
 *
 * Served at /status/incidents/:id. No auth. Permalink for sharing a
 * specific incident with customers / partners. The /status banner and
 * each card on /status link here.
 *
 * Visibility gate: identical to the public-incidents endpoint —
 * only renders if the incident's `visibility='public'` AND
 * `public_title` is set. Per-update text is the sanitized
 * `public_message`; never the internal `message`. (See
 * lib/incidents.toPublicShape.)
 *
 * Returns 404 if the incident is missing, internal-only, or has no
 * public_title — no information leak about whether the id exists.
 */
import { wrapPage } from "./shared";
import {
  getIncident,
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

// severity → banner color
const SEVERITY_PILL: Record<PublicIncident["severity"], PalettePill> = {
  critical: STATUS_PILL.outage,
  high:     STATUS_PILL.outage,
  medium:   STATUS_PILL.degraded,
  low:      STATUS_PILL.degraded,
  info:     STATUS_PILL.operational,
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c] ?? c));
}

function statusLabel(status: PublicIncident["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusPill(status: PublicIncident["status"]): PalettePill {
  if (status === "resolved") return STATUS_PILL.operational;
  if (status === "monitoring") return STATUS_PILL.degraded;
  return STATUS_PILL.outage;
}

function renderUpdates(updates: PublicIncident["updates"]): string {
  if (updates.length === 0) {
    return `<div class="incident-detail-empty">No public updates yet.</div>`;
  }
  // Newest first reads better on a permalink — operators land on the
  // most recent state immediately, can scroll back for context.
  const ordered = [...updates].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return ordered.map((u) => {
    const pill = u.status ? statusPill(u.status) : null;
    return `
      <div class="incident-detail-update">
        <div class="incident-detail-update-meta">
          <span>${escapeHtml(new Date(u.created_at).toUTCString())}</span>
          ${u.status ? `<span class="incident-detail-update-status" style="color:${pill!.text}">${escapeHtml(statusLabel(u.status))}</span>` : ""}
        </div>
        <div class="incident-detail-update-body">${escapeHtml(u.message)}</div>
      </div>`;
  }).join("");
}

function renderNotFound(): string {
  return wrapPage(
    "Incident — Averrow",
    "Public incident detail.",
    `
<style>
.notfound-shell { max-width: 600px; margin: 6rem auto 4rem; padding: 0 1.5rem; text-align: center; }
.notfound-title { font-family: var(--font-display); font-size: 28px; font-weight: 700; margin-bottom: 0.5rem; color: var(--text-primary); }
.notfound-sub { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); letter-spacing: 0.04em; }
.notfound-link { display: inline-block; margin-top: 1.5rem; font-family: var(--font-mono); font-size: 13px; color: var(--accent, var(--amber, #E5A832)); text-decoration: none; border-bottom: 1px dashed currentColor; }
@media (max-width: 600px) { .notfound-shell { margin: 5rem auto 3rem; padding: 0 1rem; } }
</style>
<div class="notfound-shell">
  <h1 class="notfound-title">Incident not found</h1>
  <p class="notfound-sub">This incident is no longer published or never existed.</p>
  <a href="/status" class="notfound-link">Back to status page →</a>
</div>
`,
  );
}

export interface IncidentDetailRender {
  html: string;
  found: boolean;
}

export async function renderIncidentDetailPage(env: Env, id: string): Promise<IncidentDetailRender> {
  if (!id || id.length > 200) {
    return { html: renderNotFound(), found: false };
  }

  let publicShape: PublicIncident | null = null;
  try {
    const incident = await getIncident(env, id);
    if (!incident) return { html: renderNotFound(), found: false };
    const updates = await listIncidentUpdates(env, id);
    const publicUpdates = updates.filter((u) => u.visibility === "public");
    publicShape = toPublicShape(incident, publicUpdates);
  } catch {
    publicShape = null;
  }

  if (!publicShape) {
    return { html: renderNotFound(), found: false };
  }

  const sevPill = SEVERITY_PILL[publicShape.severity];
  const stPill = statusPill(publicShape.status);
  const isResolved = publicShape.status === "resolved";

  const html = wrapPage(
    `${publicShape.title} — Averrow Status`,
    publicShape.details ?? "Public incident detail.",
    `
<style>
.incident-detail-shell { max-width: 760px; margin: 0 auto; padding: 6rem 1.5rem 4rem; box-sizing: border-box; width: 100%; }
.incident-detail-shell, .incident-detail-shell * { box-sizing: border-box; }

.incident-detail-back { font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); text-decoration: none; letter-spacing: 0.06em; }
.incident-detail-back:hover { color: var(--text-secondary); }

.incident-detail-header { margin-top: 1rem; margin-bottom: 1.25rem; }
.incident-detail-title { font-family: var(--font-display); font-size: clamp(24px, 3.5vw, 36px); font-weight: 700; color: var(--text-primary); margin: 0 0 0.5rem; line-height: 1.2; }
.incident-detail-pills { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.incident-detail-pill { font-family: var(--font-mono); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 10px; border-radius: 100px; }

.incident-detail-summary { background: var(--bg-card, rgba(22,30,48,0.65)); border: 1px solid var(--border-base, rgba(255,255,255,0.08)); border-radius: 12px; padding: 1.1rem 1.25rem; margin-bottom: 1.25rem; backdrop-filter: blur(8px); }
.incident-detail-summary-text { font-size: 14px; color: var(--text-secondary); line-height: 1.6; margin: 0; }

.incident-detail-meta { display: flex; gap: 1.5rem; flex-wrap: wrap; font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px dashed rgba(255,255,255,0.06); letter-spacing: 0.04em; }
.incident-detail-meta strong { color: var(--text-secondary); font-weight: 700; }

.incident-detail-section-title { font-family: var(--font-display); font-size: 16px; font-weight: 700; color: var(--text-primary); margin: 1.5rem 0 0.75rem; }

.incident-detail-update { background: var(--bg-card, rgba(22,30,48,0.55)); border: 1px solid var(--border-base, rgba(255,255,255,0.06)); border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; }
.incident-detail-update-meta { font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; margin-bottom: 6px; letter-spacing: 0.04em; }
.incident-detail-update-status { font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.08em; }
.incident-detail-update-body { font-size: 14px; color: var(--text-primary); line-height: 1.55; }
.incident-detail-empty { font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary); padding: 14px; text-align: center; }

[data-theme="light"] .incident-detail-summary,
[data-theme="light"] .incident-detail-update { background: rgba(255,255,255,0.6); border-color: rgba(26,31,46,0.08); }

@media (max-width: 600px) {
  .incident-detail-shell { padding: 5rem 12px 3rem; max-width: 100%; }
  .incident-detail-summary { padding: 14px; }
  .incident-detail-update { padding: 11px 12px; }
}
</style>

<div class="incident-detail-shell">
  <a href="/status" class="incident-detail-back">← Status</a>

  <div class="incident-detail-header">
    <h1 class="incident-detail-title">${escapeHtml(publicShape.title)}</h1>
    <div class="incident-detail-pills">
      <span class="incident-detail-pill" style="background:${sevPill.bg};border:1px solid ${sevPill.border};color:${sevPill.text}">
        ${escapeHtml(publicShape.severity)}
      </span>
      <span class="incident-detail-pill" style="background:${stPill.bg};border:1px solid ${stPill.border};color:${stPill.text}">
        ${escapeHtml(statusLabel(publicShape.status))}
      </span>
    </div>
  </div>

  ${publicShape.details ? `
  <div class="incident-detail-summary">
    <p class="incident-detail-summary-text">${escapeHtml(publicShape.details)}</p>
    <div class="incident-detail-meta">
      <span><strong>Started:</strong> ${escapeHtml(new Date(publicShape.started_at).toUTCString())}</span>
      ${isResolved && publicShape.resolved_at ? `<span><strong>Resolved:</strong> ${escapeHtml(new Date(publicShape.resolved_at).toUTCString())}</span>` : ""}
    </div>
  </div>
  ` : ""}

  <h2 class="incident-detail-section-title">Updates</h2>
  ${renderUpdates(publicShape.updates)}
</div>
`,
  );
  return { html, found: true };
}
