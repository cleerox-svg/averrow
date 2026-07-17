// Server-rendered HTML for the sales-qualified Brand Risk Plan.
//
// Renders the snapshotted ReportPayload into a print-friendly page.
// `@media print` rules collapse the chrome so users can save as PDF
// without further tooling. No external CSS/JS — fully self-contained
// so the share link works even when CDN access is restricted.

interface ReportPayload {
  brand: { domain: string; name: string | null };
  generated_at: string;
  executive_summary: { risk_grade: string; key_findings: string[] };
  email_security: { grade: string; spf: string | null; dmarc: string | null; dkim_found: boolean; mx_count: number };
  active_threats: {
    total: number;
    by_severity: Record<string, number>;
    samples: Array<{ id: string; threat_type: string; severity: string | null; source_feed: string; malicious_domain: string | null; ip_address: string | null; country_code: string | null; first_seen: string }>;
  };
  infrastructure: {
    top_hosting_providers: Array<{ name: string; asn: string | null; threat_count: number }>;
    top_countries: Array<{ country: string; threat_count: number }>;
    campaigns_caught_in: Array<{ id: string; name: string; threat_count: number }>;
  };
  lookalikes: { registered_count: number; possible_count: number };
  narrative: string;
  remediation_plan: string;
  roi: {
    analyst_hours_saved_per_year: number;
    analyst_dollars_saved_per_year: number;
    takedowns_per_year_projected: number;
    breach_prevention_value_per_year: number;
    total_value_per_year: number;
  };
}

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

export function renderQualifiedReportHTML(p: ReportPayload): string {
  const brandName = p.brand.name ?? p.brand.domain;
  const generated = new Date(p.generated_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const grade = p.executive_summary.risk_grade;
  const gColor = gradeColor(grade);

  const findings = p.executive_summary.key_findings.map((f) => `<li>${escapeHtml(f)}</li>`).join("");

  const threatRows = p.active_threats.samples.slice(0, 25).map((t) => `
    <tr>
      <td>${severityChip(t.severity)}</td>
      <td>${escapeHtml(t.threat_type)}</td>
      <td><code>${escapeHtml(t.malicious_domain ?? t.ip_address ?? "—")}</code></td>
      <td>${escapeHtml(t.source_feed)}</td>
      <td>${escapeHtml(t.country_code ?? "—")}</td>
      <td>${escapeHtml(new Date(t.first_seen).toLocaleDateString())}</td>
    </tr>
  `).join("");

  const providerRows = p.infrastructure.top_hosting_providers.map((hp) => `
    <tr><td>${escapeHtml(hp.name)}</td><td>${escapeHtml(hp.asn ?? "—")}</td><td style="text-align:right;">${hp.threat_count}</td></tr>
  `).join("") || `<tr><td colspan="3" style="color:#888;font-style:italic;">None observed</td></tr>`;

  const countryRows = p.infrastructure.top_countries.map((c) => `
    <tr><td>${escapeHtml(c.country)}</td><td style="text-align:right;">${c.threat_count}</td></tr>
  `).join("") || `<tr><td colspan="2" style="color:#888;font-style:italic;">None</td></tr>`;

  const campaignRows = p.infrastructure.campaigns_caught_in.map((c) => `
    <tr><td>${escapeHtml(c.name)}</td><td style="text-align:right;">${c.threat_count}</td></tr>
  `).join("") || `<tr><td colspan="2" style="color:#888;font-style:italic;">No active campaigns observed</td></tr>`;

  // Convert remediation plan markdown-ish numbered list to <ol>
  const planItems = p.remediation_plan.split(/\n+/).filter((l) => l.trim()).map((l) => l.replace(/^\d+[.)]\s*/, "").trim());
  const planList = planItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

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
      <h2>1 · Email Security Audit</h2>
      <div class="grid-2">
        <div class="stat"><div class="label">Email Security Grade</div><div class="value">${escapeHtml(p.email_security.grade)}</div></div>
        <div class="stat"><div class="label">MX Records</div><div class="value">${p.email_security.mx_count}</div></div>
      </div>
      <div class="panel">
        <table>
          <tr><th>Control</th><th>Posture</th></tr>
          <tr><td>SPF</td><td><code>${escapeHtml(p.email_security.spf ?? "Not configured")}</code></td></tr>
          <tr><td>DMARC</td><td><code>${escapeHtml(p.email_security.dmarc ?? "Not configured")}</code></td></tr>
          <tr><td>DKIM</td><td>${p.email_security.dkim_found ? "Configured" : "Not detected"}</td></tr>
        </table>
      </div>
    </section>

    <section>
      <h2>2 · Active Threats Targeting ${escapeHtml(p.brand.domain)}</h2>
      <div class="stat-grid">
        <div class="stat"><div class="label">Total Active</div><div class="value ${p.active_threats.total > 0 ? "red" : "green"}">${p.active_threats.total}</div></div>
        <div class="stat"><div class="label">Critical / High</div><div class="value red">${(p.active_threats.by_severity.critical ?? 0) + (p.active_threats.by_severity.high ?? 0)}</div></div>
      </div>
      ${p.active_threats.samples.length > 0 ? `
      <div class="panel">
        <table>
          <thead><tr><th>Severity</th><th>Type</th><th>Indicator</th><th>Source</th><th>Country</th><th>First Seen</th></tr></thead>
          <tbody>${threatRows}</tbody>
        </table>
        ${p.active_threats.total > 25 ? `<div style="color:var(--text-tertiary);font-size:12px;margin-top:8px;">Showing top 25 of ${p.active_threats.total} active threats. Full list available in customer dashboard.</div>` : ""}
      </div>
      ` : `<div class="panel" style="color:var(--text-secondary);">No active threats currently detected.</div>`}
    </section>

    <section>
      <h2>3 · Infrastructure Map</h2>
      <div class="grid-2">
        <div class="panel">
          <table>
            <thead><tr><th>Hosting Provider</th><th>ASN</th><th style="text-align:right;">Threats</th></tr></thead>
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
      <div class="panel" style="margin-top: 16px;">
        <div style="color:var(--text-secondary);margin-bottom:8px;font-size:13px;">Active campaign clusters this brand is targeted by:</div>
        <table>
          <thead><tr><th>Campaign</th><th style="text-align:right;">Threats</th></tr></thead>
          <tbody>${campaignRows}</tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>4 · Lookalike Domain Inventory</h2>
      <div class="stat-grid">
        <div class="stat"><div class="label">Registered Lookalikes</div><div class="value ${p.lookalikes.registered_count > 0 ? "red" : "green"}">${p.lookalikes.registered_count}</div></div>
        <div class="stat"><div class="label">Permutations Tracked</div><div class="value">${p.lookalikes.possible_count}</div></div>
      </div>
    </section>

    <section>
      <h2>5 · Threat Actor Briefing</h2>
      <div class="panel narrative">${escapeHtml(p.narrative).replace(/\n/g, "<br>")}</div>
    </section>

    <section>
      <h2>6 · Recommended Remediation Plan</h2>
      <div class="panel">
        <ol class="plan-list">${planList}</ol>
      </div>
    </section>

    <section>
      <h2>7 · Projected Annual Value (ROI)</h2>
      <div class="stat-grid">
        <div class="stat"><div class="label">Analyst Hours Saved / yr</div><div class="value green">${p.roi.analyst_hours_saved_per_year.toLocaleString()}</div></div>
        <div class="stat"><div class="label">Analyst $ Saved / yr</div><div class="value green">${fmtUsd(p.roi.analyst_dollars_saved_per_year)}</div></div>
        <div class="stat"><div class="label">Takedowns / yr Projected</div><div class="value">${p.roi.takedowns_per_year_projected}</div></div>
        <div class="stat"><div class="label">Breach Prevention Value / yr</div><div class="value green">${fmtUsd(p.roi.breach_prevention_value_per_year)}</div></div>
      </div>
      <div class="panel" style="text-align:center;background:rgba(60,184,120,0.08);border-color:rgba(60,184,120,0.3);">
        <div style="color:var(--text-tertiary);font-size:12px;text-transform:uppercase;letter-spacing:1px;">Total Projected Annual Value</div>
        <div style="font-size:36px;font-weight:700;color:var(--green);margin-top:4px;">${fmtUsd(p.roi.total_value_per_year)}</div>
        <div style="color:var(--text-secondary);font-size:12px;margin-top:8px;max-width:520px;margin-left:auto;margin-right:auto;">Calculation basis: replaces 2-3 SOC analyst headcount on impersonation/takedown work + measurable contribution to breach-prevention probability (IBM 2024 cost-of-breach reference: $4.45M average).</div>
      </div>
    </section>

    <div class="footer">
      Averrow · LRX Enterprises Inc. · This report is confidential and intended for ${escapeHtml(brandName)}.<br>
      Snapshot generated ${escapeHtml(p.generated_at)}. Future scans may show different findings as the threat landscape evolves.
    </div>
  </div>
</body>
</html>`;
}
