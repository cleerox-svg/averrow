// Server-rendered HTML for the prospect scan report (Brand Risk Plan).
//
// Renders the snapshotted ReportPayload into a print-friendly page.
// `@media print` rules collapse the chrome so users can save as PDF
// without further tooling. No external CSS/JS — fully self-contained
// so the share link works even when CDN access is restricted.
//
// Prospect-facing: no feed/source names, no ASNs, no vendor names, no
// social-media section, no unsourced statistics.
//
// A "scan_only" payload (auto-delivered from the lead form) has no
// active_threats / infrastructure blocks; those sections are not rendered
// at all — not even as "none on record", which would itself be a claim
// about Averrow's threat data.

import type { ReportPayload as ReportPayloadCurrent } from "../handlers/qualifiedReport";

// Stored payloads from before the 2026-10-05 rework still carry
// source_feed, ASN and breach-prevention fields; this renderer simply
// never reads them, so old share links are clean too.
type ReportPayload = Omit<ReportPayloadCurrent, "roi"> & {
  roi: Pick<ReportPayloadCurrent["roi"], "analyst_hours_saved_per_year" | "analyst_dollars_saved_per_year" | "takedowns_per_year_projected">;
};

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function fmtUsd(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function gradeColor(grade: string): string {
  if (grade === "CRITICAL") return "#C83C3C";
  if (grade === "HIGH") return "#E5A832";
  if (grade === "MODERATE") return "#0A8AB5";
  return "#3CB878";
}

function severityChip(sev: string | null): string {
  const v = (sev ?? "unknown").toLowerCase();
  const colors: Record<string, string> = {
    critical: "#C83C3C", high: "#E5A832", medium: "#0A8AB5", low: "#3CB878",
  };
  return `<span style="background:${colors[v] ?? "#666"};color:#fff;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;text-transform:uppercase;">${escapeHtml(v)}</span>`;
}

function spfLabel(v: string | null): string {
  switch (v) {
    case "-all": case "pass": case "hardfail": return "Enforced (-all)";
    case "~all": case "soft": case "softfail": return "Soft fail (~all) — not enforced";
    case "?all": case "neutral": case "+all": case "none": return "Neutral — does not restrict senders";
    case null: case "missing": case "": return "Not configured";
    default: return v;
  }
}

function dmarcLabel(v: string | null): string {
  switch (v) {
    case "reject": return "Reject — spoofed mail is blocked";
    case "quarantine": return "Quarantine — spoofed mail goes to spam";
    case "none": return "None — monitoring only, nothing blocked";
    case null: case "missing": case "": return "Not configured";
    default: return v;
  }
}

export function renderQualifiedReportHTML(p: ReportPayload): string {
  const brandName = p.brand.name ?? p.brand.domain;
  const generated = new Date(p.generated_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const grade = p.executive_summary.risk_grade;
  const gColor = gradeColor(grade);

  const findings = p.executive_summary.key_findings.map((f) => `<li>${escapeHtml(f)}</li>`).join("");

  const scanOnly = p.content === "scan_only";
  const threats = scanOnly ? undefined : p.active_threats;
  const infra = scanOnly ? undefined : p.infrastructure;
  const threatRows = (threats?.samples ?? []).slice(0, 25).map((t) => `
    <tr>
      <td>${severityChip(t.severity)}</td>
      <td>${escapeHtml(t.threat_type)}</td>
      <td><code>${escapeHtml(t.malicious_domain ?? t.ip_address ?? "—")}</code></td>
      <td>${escapeHtml(t.country_code ?? "—")}</td>
      <td>${escapeHtml(new Date(t.first_seen).toLocaleDateString())}</td>
    </tr>
  `).join("");

  const providers = infra?.top_hosting_providers ?? [];
  const countries = infra?.top_countries ?? [];
  const campaigns = infra?.campaigns_caught_in ?? [];
  const hasInfra = providers.length > 0 || countries.length > 0 || campaigns.length > 0;
  const providerRows = providers.map((hp) => `
    <tr><td>${escapeHtml(hp.name)}</td><td style="text-align:right;">${hp.threat_count}</td></tr>
  `).join("") || `<tr><td colspan="2" style="color:#888;font-style:italic;">None recorded</td></tr>`;
  const countryRows = countries.map((c) => `
    <tr><td>${escapeHtml(c.country)}</td><td style="text-align:right;">${c.threat_count}</td></tr>
  `).join("") || `<tr><td colspan="2" style="color:#888;font-style:italic;">None recorded</td></tr>`;
  const campaignRows = campaigns.map((c) => `
    <tr><td>${escapeHtml(c.name)}</td><td style="text-align:right;">${c.threat_count}</td></tr>
  `).join("");

  const lookalikeNames = p.lookalikes.names ?? [];
  const lookalikeList = lookalikeNames.map((d) => `<li><code>${escapeHtml(d)}</code></li>`).join("");
  const watchItems = (p.watch_list ?? []).map((w) => `<li>${escapeHtml(w)}</li>`).join("");

  // Convert remediation plan markdown-ish numbered list to <ol>
  const planItems = p.remediation_plan.split(/\n+/).filter((l) => l.trim()).map((l) => l.replace(/^\d+[.)]\s*/, "").trim());
  const planList = planItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  let n = 0;
  const h = (title: string) => `<h2>${++n} · ${title}</h2>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Brand Risk Plan — ${escapeHtml(brandName)}</title>
  <style>
    :root {
      --bg: #060A14;
      --panel: rgba(22,30,48,0.85);
      --text: rgba(255,255,255,0.92);
      --text-secondary: rgba(255,255,255,0.60);
      --text-tertiary: rgba(255,255,255,0.40);
      --amber: #E5A832;
      --red: #C83C3C;
      --blue: #0A8AB5;
      --green: #3CB878;
      --border: rgba(255,255,255,0.08);
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 0;
      line-height: 1.6;
    }
    .container { max-width: 920px; margin: 0 auto; padding: 60px 40px; }
    .header { border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 32px; }
    .header h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: -0.3px; }
    .header .meta { color: var(--text-secondary); font-size: 13px; }
    .header .averrow { color: var(--amber); font-weight: 600; letter-spacing: 2px; font-size: 12px; text-transform: uppercase; margin-bottom: 16px; }
    .grade-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-left: 4px solid ${gColor};
      border-radius: 6px;
      padding: 24px;
      margin: 24px 0;
    }
    .grade-card .label { color: var(--text-tertiary); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
    .grade-card .grade { font-size: 32px; font-weight: 700; color: ${gColor}; margin: 4px 0; }
    section { margin: 40px 0; }
    section h2 {
      font-size: 18px;
      margin: 0 0 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
      color: var(--amber);
      letter-spacing: 0.3px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
    th { color: var(--text-secondary); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
    code { background: rgba(255,255,255,0.05); padding: 1px 6px; border-radius: 3px; font-size: 12px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 16px 0; }
    .stat { background: var(--panel); padding: 16px; border-radius: 6px; border: 1px solid var(--border); }
    .stat .label { color: var(--text-tertiary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat .value { font-size: 24px; font-weight: 700; color: var(--amber); margin-top: 4px; }
    .stat .value.green { color: var(--green); }
    .stat .value.red { color: var(--red); }
    .narrative { font-size: 15px; line-height: 1.7; color: var(--text); }
    .plan-list { padding-left: 20px; }
    .plan-list li { margin: 12px 0; line-height: 1.6; }
    .footer { margin-top: 60px; padding-top: 24px; border-top: 1px solid var(--border); color: var(--text-tertiary); font-size: 12px; text-align: center; }

    @media print {
      body { background: #fff; color: #111; }
      .panel, .grade-card, .stat { background: #f7f7f7; border-color: #ddd; }
      th { color: #555; }
      .header { border-color: #ccc; }
      section h2 { color: #b07c00; }
    }
    @media (max-width: 720px) {
      .container { padding: 32px 16px; }
      .grid-2 { grid-template-columns: 1fr; }
      .stat-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="averrow">Averrow · Brand Risk Plan</div>
      <h1>${escapeHtml(brandName)}</h1>
      <div class="meta"><code>${escapeHtml(p.brand.domain)}</code> · Generated ${escapeHtml(generated)}</div>
    </div>

    <div class="grade-card">
      <div class="label">Overall Risk Grade</div>
      <div class="grade">${escapeHtml(grade)}</div>
      <ul style="margin: 12px 0 0; padding-left: 20px;">${findings}</ul>
    </div>

    <section>
      ${h("Email Security")}
      <div class="grid-2">
        <div class="stat"><div class="label">Email Security Grade</div><div class="value">${escapeHtml(p.email_security.grade)}</div></div>
        <div class="stat"><div class="label">Mail Servers (MX)</div><div class="value">${p.email_security.mx_count > 0 ? "Present" : "Not found"}</div></div>
      </div>
      <div class="panel">
        <table>
          <tr><th>Control</th><th>Posture</th></tr>
          <tr><td>SPF</td><td>${escapeHtml(spfLabel(p.email_security.spf))}</td></tr>
          <tr><td>DMARC</td><td>${escapeHtml(dmarcLabel(p.email_security.dmarc))}</td></tr>
          <tr><td>DKIM</td><td>${p.email_security.dkim_found ? "Found" : "Not found on common selectors"}</td></tr>
          ${p.email_security.bimi_present == null ? "" : `<tr><td>BIMI</td><td>${p.email_security.bimi_present ? "Published" : "Not published"}</td></tr>`}
        </table>
      </div>
    </section>

    <section>
      ${h("Registered Lookalike Domains")}
      ${lookalikeNames.length > 0 ? `
      <div class="panel">
        <div style="color:var(--text-secondary);margin-bottom:8px;font-size:13px;">These domains resemble ${escapeHtml(p.brand.domain)} and are registered. Registration alone is not proof of abuse.</div>
        <ul style="margin:0;padding-left:20px;columns:2;">${lookalikeList}</ul>
        ${p.lookalikes.registered_count > lookalikeNames.length ? `<div style="color:var(--text-tertiary);font-size:12px;margin-top:8px;">Showing ${lookalikeNames.length} of ${p.lookalikes.registered_count}.</div>` : ""}
      </div>` : p.lookalikes.registered_count > 0
        ? `<div class="panel">${p.lookalikes.registered_count} registered lookalike domain${p.lookalikes.registered_count === 1 ? "" : "s"} found.</div>`
        : `<div class="panel" style="color:var(--text-secondary);">No registered lookalike domains were found.</div>`}
    </section>

    ${threats ? `
    <section>
      ${h(`Active Threats Targeting ${escapeHtml(p.brand.domain)}`)}
      ${threats.total > 0 ? `
      <div class="stat-grid">
        <div class="stat"><div class="label">Total Active</div><div class="value red">${threats.total}</div></div>
        <div class="stat"><div class="label">Critical / High</div><div class="value red">${(threats.by_severity.critical ?? 0) + (threats.by_severity.high ?? 0)}</div></div>
      </div>
      ${threats.samples.length > 0 ? `
      <div class="panel">
        <table>
          <thead><tr><th>Severity</th><th>Type</th><th>Indicator</th><th>Country</th><th>First Seen</th></tr></thead>
          <tbody>${threatRows}</tbody>
        </table>
        ${threats.total > 25 ? `<div style="color:var(--text-tertiary);font-size:12px;margin-top:8px;">Showing the 25 most recent of ${threats.total} active threats.</div>` : ""}
      </div>` : ""}
      ` : `<div class="panel" style="color:var(--text-secondary);">No active threats targeting this domain are on record.</div>`}
    </section>` : ""}

    ${hasInfra ? `
    <section>
      ${h("Hosting Infrastructure")}
      <div class="grid-2">
        <div class="panel">
          <table>
            <thead><tr><th>Hosting Provider</th><th style="text-align:right;">Threats</th></tr></thead>
            <tbody>${providerRows}</tbody>
          </table>
        </div>
        <div class="panel">
          <table>
            <thead><tr><th>Country</th><th style="text-align:right;">Threats</th></tr></thead>
            <tbody>${countryRows}</tbody>
          </table>
        </div>
      </div>
      ${campaigns.length > 0 ? `
      <div class="panel" style="margin-top: 16px;">
        <div style="color:var(--text-secondary);margin-bottom:8px;font-size:13px;">Active campaigns these threats belong to:</div>
        <table>
          <thead><tr><th>Campaign</th><th style="text-align:right;">Threats</th></tr></thead>
          <tbody>${campaignRows}</tbody>
        </table>
      </div>` : ""}
    </section>` : ""}

    <section>
      ${h("Summary")}
      <div class="panel narrative">${escapeHtml(p.narrative).replace(/\n/g, "<br>")}</div>
    </section>

    <section>
      ${h("Recommended Next Steps")}
      <div class="panel">
        <ol class="plan-list">${planList}</ol>
      </div>
    </section>

    ${watchItems ? `
    <section>
      ${h("What Averrow Would Watch")}
      <div class="panel"><ul class="plan-list">${watchItems}</ul></div>
    </section>` : ""}

    <section>
      ${h("Analyst Time (Estimate)")}
      <div class="stat-grid">
        <div class="stat"><div class="label">Analyst Hours / yr</div><div class="value green">${p.roi.analyst_hours_saved_per_year.toLocaleString()}</div></div>
        <div class="stat"><div class="label">Analyst Cost / yr</div><div class="value green">${fmtUsd(p.roi.analyst_dollars_saved_per_year)}</div></div>
      </div>
      <div style="color:var(--text-secondary);font-size:12px;">Illustrative estimate: about ${p.roi.analyst_hours_saved_per_year.toLocaleString()} hours a year of impersonation monitoring and takedown work at $75/hour. Your figures will depend on your team and volume.</div>
    </section>

    <div class="footer">
      Averrow · LRX Enterprises Inc. · This report is confidential and intended for ${escapeHtml(brandName)}.<br>
      Snapshot generated ${escapeHtml(p.generated_at)}. Future scans may show different findings as the threat landscape evolves.
    </div>
  </div>
</body>
</html>`;
}
