export interface ScanRecord {
  id: string;
  url: string;
  domain: string;
  trust_score: number;
  risk_level: string;
  flags: Array<{ type: string; severity: string; detail: string }>;
  metadata: {
    ssl_valid?: boolean;
    virustotal?: { malicious: number; suspicious: number; harmless: number; undetected: number };
    ai_insight?: { summary?: string; explanation?: string; recommendations?: string[] };
  };
  geo_city?: string | null;
  geo_country?: string | null;
  cached: number | boolean;
  created_at: string;
}

/**
 * Escape user/AI/DB-derived strings before HTML interpolation.
 * Escapes `"` and `'` as well so the helper is safe in attribute
 * contexts (e.g. <meta content="...">). Same pattern as the local
 * escapeHtml helpers in incident-detail.ts / qualifiedReport.ts.
 */
function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] ?? c));
}

function hasFlag(flags: ScanRecord["flags"], type: string): boolean {
  return flags.some((f) => f.type === type);
}

function getFlag(flags: ScanRecord["flags"], type: string) {
  return flags.find((f) => f.type === type);
}

export function renderScanResult(scan: ScanRecord): string {
  const score = scan.trust_score;

  // Averrow defense grade scale
  const cls =
    score >= 85 ? "a" :
    score >= 70 ? "b" :
    score >= 55 ? "c" :
    score >= 40 ? "d" : "f";
  const gradeColor =
    score >= 85 ? "#28A050" :
    score >= 70 ? "#78A0C8" :
    score >= 55 ? "#DCAA32" :
    score >= 40 ? "#E8923C" : "#C83C3C";
  const verdict =
    score >= 85 ? "All Clear" :
    score >= 70 ? "Low Risk" :
    score >= 55 ? "Suspicious" :
    score >= 40 ? "High Risk" : "Critical Risk";
  const verdictIcon = score >= 85 ? "✓" : score >= 70 ? "▲" : score >= 55 ? "⚠" : "✗";

  const vtData = scan.metadata?.virustotal;
  const vtDetections = vtData?.malicious ?? 0;
  const vtSuspicious = vtData?.suspicious ?? 0;
  const aiInsight = scan.metadata?.ai_insight;

  const signals = [
    {
      label: "SSL / HTTPS",
      value: scan.metadata?.ssl_valid !== false && !hasFlag(scan.flags, "no_ssl") ? "Valid" : "Invalid or missing",
      status: scan.metadata?.ssl_valid !== false && !hasFlag(scan.flags, "no_ssl") ? "pass" : "fail",
      detail: hasFlag(scan.flags, "no_ssl") ? "Site does not use HTTPS" : "",
    },
    {
      label: "VirusTotal",
      value: vtDetections > 0 ? `${vtDetections} detection${vtDetections > 1 ? "s" : ""}` : vtSuspicious > 0 ? `${vtSuspicious} suspicious` : "Clean",
      status: vtDetections > 0 ? "fail" : vtSuspicious > 0 ? "warn" : vtData ? "pass" : "info",
      detail: vtDetections > 0 ? `Flagged as malicious by ${vtDetections} engine${vtDetections > 1 ? "s" : ""}` :
              vtSuspicious > 0 ? `Flagged as suspicious by ${vtSuspicious} engine${vtSuspicious > 1 ? "s" : ""}` : "",
    },
    {
      label: "Domain Pattern",
      value: hasFlag(scan.flags, "typosquatting") ? "Typosquatting detected" :
             hasFlag(scan.flags, "ip_domain") ? "IP address URL" : "Normal",
      status: hasFlag(scan.flags, "typosquatting") ? "fail" : hasFlag(scan.flags, "ip_domain") ? "warn" : "pass",
      detail: getFlag(scan.flags, "typosquatting")?.detail ?? getFlag(scan.flags, "ip_domain")?.detail ?? "",
    },
    {
      label: "Threat Intelligence",
      value: hasFlag(scan.flags, "malicious_url") ? "Known malicious" :
             hasFlag(scan.flags, "suspicious_url") ? "Flagged suspicious" : "No matches",
      status: hasFlag(scan.flags, "malicious_url") ? "fail" : hasFlag(scan.flags, "suspicious_url") ? "warn" : "pass",
      detail: getFlag(scan.flags, "malicious_url")?.detail ?? getFlag(scan.flags, "suspicious_url")?.detail ?? "",
    },
    {
      label: "Scan Origin",
      value: scan.geo_city && scan.geo_country ? `${scan.geo_city}, ${scan.geo_country}` : "Unknown",
      status: "info",
      detail: "",
    },
    {
      label: "Cached Result",
      value: scan.cached ? "Yes (within 24h)" : "Fresh scan",
      status: "info",
      detail: "",
    },
  ];

  const signalDotColor: Record<string, string> = {
    pass: "#28A050", fail: "#C83C3C", warn: "#DCAA32", info: "#78A0C8",
  };

  const allFlags = scan.flags.filter(
    (f) => !["no_ssl", "malicious_url", "suspicious_url", "ip_domain", "typosquatting"].includes(f.type)
  );

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Scan Report: ${escapeHtml(scan.domain)} — Averrow</title>
  <meta name="description" content="Defense Grade ${score}/100 for ${escapeHtml(scan.domain)}. ${verdict}."/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --red: #C83C3C; --red-hover: #A82E2E;
      --amber: #E8923C; --gold: #DCAA32;
      --green: #28A050; --blue: #78A0C8;
      --cockpit: #080E18; --instrument: #0E1A2B; --console: #142236;
      --border: rgba(120,160,200,0.08);
      --text: #F0EDE8; --subtext: #78A0C8;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: var(--cockpit); color: var(--text); font-family: 'Plus Jakarta Sans', sans-serif; min-height: 100vh; }

    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 32px; height: 60px; border-bottom: 1px solid var(--border);
      position: sticky; top: 0; z-index: 100; background: var(--cockpit);
    }
    .nav-logo { font-family: 'IBM Plex Mono', monospace; font-size: 15px; font-weight: 700; color: var(--text); text-decoration: none; letter-spacing: 0.14em; text-transform: uppercase; }
    .nav-logo span { color: var(--red); }
    .nav-back { font-size: 13px; color: var(--subtext); text-decoration: none; transition: color 0.2s; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
    .nav-back:hover { color: var(--text); }

    .page { max-width: 760px; margin: 0 auto; padding: 48px 24px; }

    /* ── HEADER ── */
    .report-header { margin-bottom: 32px; }
    .report-label {
      font-family: 'IBM Plex Mono', monospace; font-size: 10px;
      letter-spacing: 0.2em; text-transform: uppercase; color: var(--red); margin-bottom: 12px;
    }
    .report-url {
      font-family: 'IBM Plex Mono', monospace; font-size: 13px;
      color: var(--blue); word-break: break-all; margin-bottom: 6px;
    }
    .report-meta { font-size: 12px; color: var(--subtext); font-family: 'IBM Plex Mono', monospace; }

    /* ── SCORE CARD ── */
    .score-card {
      background: var(--instrument); border: 1px solid var(--border);
      border-radius: 12px; padding: 28px 24px;
      display: flex; align-items: center; gap: 24px;
      margin-bottom: 20px;
    }
    .score-ring {
      width: 100px; height: 100px; border-radius: 50%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      border: 4px solid; flex-shrink: 0;
    }
    .score-ring.a { border-color: #28A050; }
    .score-ring.b { border-color: #78A0C8; }
    .score-ring.c { border-color: #DCAA32; }
    .score-ring.d { border-color: #E8923C; }
    .score-ring.f { border-color: #C83C3C; }
    .score-num {
      font-family: 'IBM Plex Mono', monospace; font-size: 32px;
      font-weight: 700; line-height: 1;
    }
    .score-ring.a .score-num { color: #28A050; }
    .score-ring.b .score-num { color: #78A0C8; }
    .score-ring.c .score-num { color: #DCAA32; }
    .score-ring.d .score-num { color: #E8923C; }
    .score-ring.f .score-num { color: #C83C3C; }
    .score-denom { font-size: 10px; color: var(--subtext); font-family: 'IBM Plex Mono', monospace; letter-spacing: 0.06em; text-transform: uppercase; }
    .score-meta { flex: 1; }
    .score-verdict { font-size: 22px; font-weight: 700; margin-bottom: 6px; font-family: 'Plus Jakarta Sans', sans-serif; }
    .score-domain { font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: var(--subtext); }

    /* ── AI INSIGHT ── */
    .ai-insight {
      background: var(--instrument); border: 1px solid rgba(200,60,60,0.2);
      border-radius: 10px; padding: 20px 22px; margin-bottom: 20px;
    }
    .ai-label {
      font-family: 'IBM Plex Mono', monospace; font-size: 10px;
      letter-spacing: 0.2em; text-transform: uppercase; color: var(--red);
      margin-bottom: 10px; display: flex; align-items: center; gap: 8px;
    }
    .ai-summary { font-size: 14px; line-height: 1.65; color: var(--text); margin-bottom: 10px; }
    .ai-explanation { font-size: 13px; line-height: 1.6; color: var(--subtext); }
    .ai-recs { margin-top: 12px; }
    .ai-recs-label { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 8px; font-family: 'IBM Plex Mono', monospace; letter-spacing: 0.06em; text-transform: uppercase; font-size: 10px; }
    .ai-rec {
      font-size: 12px; color: var(--subtext); padding: 4px 0;
      display: flex; gap: 8px; align-items: flex-start;
    }
    .ai-rec::before { content: '→'; color: var(--red); flex-shrink: 0; }

    /* ── SIGNALS ── */
    .signals-card {
      background: var(--instrument); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px 22px; margin-bottom: 20px;
    }
    .signals-title {
      font-family: 'IBM Plex Mono', monospace; font-size: 10px;
      letter-spacing: 0.2em; text-transform: uppercase; color: var(--red);
      margin-bottom: 16px;
    }
    .signal-row {
      display: grid; grid-template-columns: 8px 140px 1fr;
      align-items: center; gap: 12px;
      padding: 9px 0; border-bottom: 1px solid var(--border);
    }
    .signal-row:last-child { border-bottom: none; }
    .signal-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .signal-label { font-size: 13px; font-weight: 500; color: var(--text); }
    .signal-value-wrap { display: flex; flex-direction: column; gap: 2px; }
    .signal-value { font-size: 13px; color: var(--subtext); font-family: 'IBM Plex Mono', monospace; }
    .signal-detail { font-size: 11px; color: var(--subtext); opacity: 0.7; font-family: 'IBM Plex Mono', monospace; }

    /* ── OTHER FLAGS ── */
    .flags-card {
      background: var(--instrument); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px 22px; margin-bottom: 20px;
    }
    .flag-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px;
    }
    .flag-row:last-child { border-bottom: none; }
    .flag-severity {
      font-size: 9px; font-family: 'IBM Plex Mono', monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      padding: 2px 6px; border-radius: 4px; flex-shrink: 0; margin-top: 1px; font-weight: 600;
    }
    .flag-severity.critical { background: rgba(200,60,60,0.15); color: #C83C3C; border: 1px solid rgba(200,60,60,0.3); }
    .flag-severity.high     { background: rgba(232,146,60,0.15); color: #E8923C; border: 1px solid rgba(232,146,60,0.3); }
    .flag-severity.medium   { background: rgba(220,170,50,0.15); color: #DCAA32; border: 1px solid rgba(220,170,50,0.3); }
    .flag-severity.low      { background: rgba(40,160,80,0.15);  color: #28A050; border: 1px solid rgba(40,160,80,0.3); }

    /* ── ACTIONS ── */
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
    .btn-ghost {
      padding: 8px 16px; border-radius: 6px;
      border: 1px solid rgba(200,60,60,0.4); background: transparent; color: var(--text);
      font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 600;
      letter-spacing: 0.06em; text-transform: uppercase;
      cursor: pointer; text-decoration: none; display: inline-flex; align-items: center;
      transition: all 0.2s;
    }
    .btn-ghost:hover { border-color: var(--red); color: var(--red); }
    .btn-primary {
      padding: 8px 18px; border-radius: 6px; border: none;
      background: var(--red); color: #F0EDE8;
      font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 600;
      letter-spacing: 0.06em; text-transform: uppercase;
      cursor: pointer; text-decoration: none; display: inline-flex; align-items: center;
      transition: opacity 0.15s;
    }
    .btn-primary:hover { background: var(--red-hover); }
  </style>
</head>
<body>

<nav>
  <a href="/" class="nav-logo">A<span>V</span>ARROW</a>
  <a href="/" class="nav-back">← Back to scanner</a>
</nav>

<div class="page">

  <div class="report-header">
    <div class="report-label">Intercept Report</div>
    <div class="report-url">${escapeHtml(scan.url)}</div>
    <div class="report-meta">Scanned ${escapeHtml(new Date(scan.created_at).toLocaleString())} · ID: ${escapeHtml(scan.id.slice(0, 8))}</div>
  </div>

  <div class="score-card">
    <div class="score-ring ${cls}">
      <div class="score-num">${score}</div>
      <div class="score-denom">Defense Grade</div>
    </div>
    <div class="score-meta">
      <div class="score-verdict" style="color:${gradeColor}">${verdictIcon} ${verdict}</div>
      <div class="score-domain">${escapeHtml(scan.domain)}</div>
    </div>
  </div>

  ${aiInsight ? `
  <div class="ai-insight">
    <div class="ai-label">⚡ ASTRA Analysis</div>
    ${aiInsight.summary ? `<div class="ai-summary">${escapeHtml(aiInsight.summary)}</div>` : ""}
    ${aiInsight.explanation ? `<div class="ai-explanation">${escapeHtml(aiInsight.explanation)}</div>` : ""}
    ${aiInsight.recommendations?.length ? `
    <div class="ai-recs">
      <div class="ai-recs-label">Recommendations</div>
      ${aiInsight.recommendations.map((r) => `<div class="ai-rec">${escapeHtml(r)}</div>`).join("")}
    </div>` : ""}
  </div>` : ""}

  <div class="signals-card">
    <div class="signals-title">Signal Breakdown</div>
    ${signals.map((s) => `
    <div class="signal-row">
      <div class="signal-dot" style="background:${signalDotColor[s.status] ?? "#78A0C8"}"></div>
      <div class="signal-label">${s.label}</div>
      <div class="signal-value-wrap">
        <div class="signal-value">${escapeHtml(s.value)}</div>
        ${s.detail ? `<div class="signal-detail">${escapeHtml(s.detail)}</div>` : ""}
      </div>
    </div>`).join("")}
  </div>

  ${allFlags.length > 0 ? `
  <div class="flags-card">
    <div class="signals-title">Additional Flags</div>
    ${allFlags.map((f) => `
    <div class="flag-row">
      <span class="flag-severity ${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span>
      <span>${escapeHtml(f.detail || f.type)}</span>
    </div>`).join("")}
  </div>` : ""}

  <div class="actions">
    <a href="/" class="btn-primary">Scan another URL</a>
    <button class="btn-ghost" onclick="copyLink()">Copy Report Link</button>
    <a href="/register" class="btn-ghost">Sign up for full history</a>
  </div>

</div>

<script>
function copyLink() {
  navigator.clipboard.writeText(window.location.href)
    .then(() => { const btn = event.target; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy Report Link', 2000); })
    .catch(() => {});
}
</script>
</body></html>`;
}
