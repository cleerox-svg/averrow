/**
 * Averrow — Free Brand Exposure Scan Page
 *
 * Public tool at /scan that lets anyone scan a domain and get
 * a shareable Brand Exposure Report.
 */

export function renderScanPage(): string {
  return `
<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Free Brand Exposure Report — Averrow</title>
<meta name="description" content="Scan any domain for email security vulnerabilities, lookalike domains, threat feed mentions, and social media impersonation risks. Free Brand Exposure Report by Averrow.">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --font-display: 'Plus Jakarta Sans', system-ui, sans-serif;
  --font-body: 'Plus Jakarta Sans', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', monospace;
  --accent: #C83C3C;
  --accent-hover: #A82E2E;
  --accent-light: #E87070;
  --accent-bg: rgba(200, 60, 60, 0.08);
  --accent-bg-strong: rgba(200, 60, 60, 0.15);
  --green: #28A050;
  --green-bg: rgba(40, 160, 80, 0.08);
  --red: #C83C3C;
  --red-bg: rgba(200, 60, 60, 0.08);
  --amber: #E8923C;
  --amber-bg: rgba(232, 146, 60, 0.08);
  --coral: #E8923C;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
}

[data-theme="light"] {
  --bg-primary: #F8F7F5;
  --bg-secondary: #ffffff;
  --bg-tertiary: #F0EDE8;
  --bg-code: #FAFAF8;
  --bg-elevated: #ffffff;
  --text-primary: #1A1F2E;
  --text-secondary: #5A6170;
  --text-tertiary: #8A8F9C;
  --text-inverse: #ffffff;
  --border: #E2DDD5;
  --border-strong: rgba(226,221,213,0.6);
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 24px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.8);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.08);
  --shadow-glow: 0 0 40px rgba(181,48,48,0.12);
  --accent: #B53030;
  --accent-hover: #9A2828;
  --accent-bg: rgba(181,48,48,0.06);
  --accent-bg-strong: rgba(181,48,48,0.12);
  --nav-bg: rgba(248,247,245,0.8);
}

[data-theme="dark"] {
  --bg-primary: #080E18;
  --bg-secondary: #0C1420;
  --bg-tertiary: #0E1A2B;
  --bg-code: #0C1420;
  --bg-elevated: #142236;
  --text-primary: #F0EDE8;
  --text-secondary: #78A0C8;
  --text-tertiary: #5A80A8;
  --text-inverse: #1A1F2E;
  --border: rgba(120, 160, 200, 0.08);
  --border-strong: rgba(120, 160, 200, 0.15);
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.3);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.4);
  --shadow-glow: 0 0 60px rgba(200,60,60,0.15);
  --nav-bg: rgba(8,14,24,0.9);
}

html { scroll-behavior: smooth; }

body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--font-body);
  line-height: 1.65;
  transition: background 0.4s, color 0.3s;
  min-height: 100vh;
}

/* ── Nav ── */
.nav {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: var(--nav-bg);
  backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border);
  padding: 0 2rem;
  height: 56px;
  display: flex; align-items: center; justify-content: space-between;
}
.nav-brand {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 1rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-primary);
  text-decoration: none;
}
.nav-brand span { color: var(--accent); }
.nav-actions { display: flex; gap: 0.75rem; align-items: center; }
.nav-link {
  font-size: 0.85rem;
  color: var(--text-secondary);
  text-decoration: none;
  padding: 0.4rem 0.75rem;
  border-radius: var(--radius-sm);
  transition: color 0.2s, background 0.2s;
}
.nav-link:hover { color: var(--accent); background: var(--accent-bg); }
.theme-toggle {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.35rem 0.5rem;
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--text-secondary);
  transition: all 0.2s;
}
.theme-toggle:hover { border-color: var(--accent); }

/* ── Container ── */
.container {
  max-width: 800px;
  margin: 0 auto;
  padding: 0 1.5rem;
}

/* ── Hero Section ── */
.hero {
  padding: 7rem 0 3rem;
  text-align: center;
}
.hero h1 {
  font-family: var(--font-display);
  font-size: 2.4rem;
  font-weight: 800;
  line-height: 1.15;
  margin-bottom: 0.75rem;
}
.hero h1 span { color: var(--accent); }
.hero p {
  color: var(--text-secondary);
  font-size: 1.05rem;
  max-width: 520px;
  margin: 0 auto 2rem;
}

/* ── Scan Form ── */
.scan-form {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 2rem;
  box-shadow: var(--shadow-md);
}
.form-row {
  display: flex;
  gap: 0.75rem;
}
.form-input {
  flex: 1;
  padding: 0.85rem 1rem;
  font-family: var(--font-mono);
  font-size: 0.95rem;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.form-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
}
.form-input::placeholder { color: var(--text-tertiary); }
.btn-scan {
  padding: 0.85rem 1.75rem;
  background: var(--accent);
  color: #F0EDE8;
  border: none;
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 0.85rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
  white-space: nowrap;
}
.btn-scan:hover { background: var(--accent-hover); }
.btn-scan:active { transform: scale(0.98); }
.btn-scan:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

/* ── Advanced Options ── */
.advanced-toggle {
  margin-top: 1rem;
  font-size: 0.82rem;
  color: var(--text-tertiary);
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.advanced-toggle:hover { color: var(--accent); }
.advanced-panel {
  display: none;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.advanced-panel.open { display: block; }
.form-group { margin-bottom: 0.75rem; }
.form-group label {
  display: block;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 0.3rem;
}
.form-group input {
  width: 100%;
  padding: 0.65rem 0.85rem;
  font-family: var(--font-display);
  font-size: 0.9rem;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: none;
  transition: border-color 0.2s;
}
.form-group input:focus { border-color: var(--accent); }

/* ── Error Message ── */
.error-msg {
  display: none;
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  background: var(--red-bg);
  color: var(--red);
  border-radius: var(--radius-sm);
  font-size: 0.88rem;
}
.error-msg.visible { display: block; }

/* ── Loading State ── */
.loading {
  display: none;
  text-align: center;
  padding: 3rem 0;
}
.loading.visible { display: block; }
.loading-spinner {
  width: 40px; height: 40px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 1rem;
}
@keyframes spin { to { transform: rotate(360deg); } }
.loading p {
  color: var(--text-secondary);
  font-size: 0.9rem;
}
.loading .loading-detail {
  color: var(--text-tertiary);
  font-size: 0.78rem;
  margin-top: 0.3rem;
}

/* ── Report Card ── */
.report {
  display: none;
  margin-top: 2rem;
}
.report.visible { display: block; }

.report-header {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 2rem;
  text-align: center;
  margin-bottom: 1.25rem;
  box-shadow: var(--shadow-md);
}
.report-header h2 {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.4rem;
  margin-bottom: 0.25rem;
}
.report-domain {
  font-family: var(--font-mono);
  font-size: 0.88rem;
  color: var(--text-tertiary);
}
.score-ring {
  width: 140px; height: 140px;
  margin: 1.5rem auto;
  position: relative;
}
.score-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.score-ring circle {
  fill: none;
  stroke-width: 8;
  stroke-linecap: round;
}
.score-ring .track { stroke: var(--border); }
.score-ring .value { transition: stroke-dashoffset 1s ease-out; }
.score-number {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
}
.score-number .num {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 2.2rem;
  line-height: 1;
}
.score-number .label {
  font-size: 0.7rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.risk-badge {
  display: inline-block;
  padding: 0.3rem 0.85rem;
  border-radius: 20px;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-top: 0.5rem;
}
.risk-LOW { background: var(--green-bg); color: var(--green); }
.risk-MODERATE { background: var(--amber-bg); color: var(--amber); }
.risk-HIGH { background: rgba(249, 115, 22, 0.1); color: var(--coral); }
.risk-CRITICAL { background: var(--red-bg); color: var(--red); }

/* ── Report Sections ── */
.report-section {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1.5rem;
  margin-bottom: 1rem;
  box-shadow: var(--shadow-sm);
}
.section-title {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 1rem;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.section-icon {
  font-size: 1.1rem;
}

/* ── Email Security Grid ── */
.email-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.75rem;
}
.email-item {
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  padding: 0.85rem;
}
.email-item-label {
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.3rem;
}
.email-item-value {
  font-family: var(--font-mono);
  font-size: 0.88rem;
  font-weight: 600;
}
.status-pass { color: var(--green); }
.status-partial { color: var(--amber); }
.status-weak { color: var(--coral); }
.status-missing { color: var(--red); }
.status-present { color: var(--accent); }

/* ── Lookalike Table ── */
.lookalike-list {
  list-style: none;
}
.lookalike-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
}
.lookalike-item:last-child { border-bottom: none; }
.lookalike-domain {
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.lookalike-type {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  background: var(--bg-tertiary);
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-sm);
}
.lookalike-status {
  font-size: 0.72rem;
  font-weight: 600;
}
.lookalike-registered { color: var(--red); }
.lookalike-safe { color: var(--green); }
.lookalike-summary {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-bottom: 0.75rem;
}

/* ── Social Grid ── */
.social-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.6rem;
}
.social-item {
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  padding: 0.65rem 0.85rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.social-platform {
  font-size: 0.82rem;
  font-weight: 500;
  text-transform: capitalize;
}
.social-status {
  font-size: 0.72rem;
  font-weight: 600;
}
.social-claimed { color: var(--green); }
.social-available { color: var(--red); }
.social-unknown { color: var(--text-tertiary); }

/* ── Threat Feeds ── */
.feed-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 0.6rem;
}
.feed-item {
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  padding: 0.65rem 0.85rem;
  text-align: center;
}
.feed-name {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 0.2rem;
}
.feed-count {
  font-family: var(--font-mono);
  font-size: 1.2rem;
  font-weight: 600;
}
.feed-zero { color: var(--green); }
.feed-hits { color: var(--red); }

/* ── AI Assessment ── */
.ai-assessment {
  font-size: 0.92rem;
  line-height: 1.7;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-left: 3px solid var(--accent);
  padding: 1rem 1.25rem;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

/* ── Actions ── */
.report-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 1.5rem;
  justify-content: center;
  flex-wrap: wrap;
}
.btn-secondary {
  padding: 0.7rem 1.25rem;
  background: transparent;
  color: var(--accent);
  border: 1px solid rgba(200, 60, 60, 0.4);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.2s;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.btn-secondary:hover { border-color: var(--accent); background: var(--accent-bg); }
.btn-cta {
  padding: 0.7rem 1.25rem;
  background: var(--accent);
  color: #F0EDE8;
  border: none;
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.2s;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.btn-cta:hover { background: var(--accent-hover); }

/* ── Share Toast ── */
.toast {
  position: fixed;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%) translateY(100px);
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border);
  padding: 0.75rem 1.5rem;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  font-size: 0.85rem;
  transition: transform 0.3s ease;
  z-index: 200;
}
.toast.show { transform: translateX(-50%) translateY(0); }

/* ── Footer ── */
.footer {
  text-align: center;
  padding: 3rem 0 2rem;
  color: var(--text-tertiary);
  font-size: 0.78rem;
}
.footer a { color: var(--accent); text-decoration: none; }
.footer a:hover { text-decoration: underline; }

/* ── Light theme glass effects ── */
[data-theme="light"] .scan-form,
[data-theme="light"] .report-header,
[data-theme="light"] .report-section {
  background: rgba(255,255,255,0.7);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(226,221,213,0.5);
  box-shadow: 0 4px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.9);
}
[data-theme="light"] .nav {
  background: rgba(248,247,245,0.8);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(226,221,213,0.5);
}
[data-theme="light"] .hero h1 span {
  color: #C88B1E;
}

/* ── Responsive ── */
@media (max-width: 600px) {
  .hero h1 { font-size: 1.8rem; }
  .form-row { flex-direction: column; }
  .btn-scan { width: 100%; }
  .container { padding: 0 1rem; }
  .email-grid { grid-template-columns: 1fr 1fr; }
  .report-actions { flex-direction: column; align-items: stretch; }
}
</style>
</head>
<body>

<!-- Nav -->
<nav class="nav">
  <a href="/" class="nav-brand">AVERROW</a>
  <div class="nav-actions">
    <a href="/" class="nav-link">Home</a>
    <a href="/scan" class="nav-link" style="color: var(--accent);">Scan</a>
    <button class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme">
      <span id="themeIcon">&#9790;</span>
    </button>
  </div>
</nav>

<div class="container">

  <!-- Hero -->
  <section class="hero">
    <h1>Free <span>Brand Exposure</span> Report</h1>
    <p>Scan any domain to uncover email security gaps, lookalike domains, threat feed mentions, and social media impersonation risks.</p>
  </section>

  <!-- Scan Form -->
  <div class="scan-form" id="scanForm">
    <div class="form-row">
      <input type="text" class="form-input" id="domainInput" placeholder="example.com" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn-scan" id="scanBtn" onclick="runScan()">Scan Domain</button>
    </div>

    <div class="advanced-toggle" onclick="toggleAdvanced()">
      <span id="advIcon">&#9656;</span> Advanced options
    </div>
    <div class="advanced-panel" id="advPanel">
      <div class="form-group">
        <label for="brandInput">Brand name (optional)</label>
        <input type="text" id="brandInput" placeholder="Auto-detected from domain">
      </div>
    </div>

    <div class="error-msg" id="errorMsg"></div>
  </div>

  <!-- Loading -->
  <div class="loading" id="loading">
    <div class="loading-spinner"></div>
    <p>Running brand scan...</p>
    <p class="loading-detail">Checking email security, lookalike domains, threat feeds, and social handles</p>
  </div>

  <!-- Report -->
  <div class="report" id="report"></div>

  <!-- Footer -->
  <div class="footer">
    <p>Powered by <a href="/">Averrow</a> by LRX Enterprises Inc.</p>
    <p style="margin-top: 0.3rem;">Scans are cached for 24 hours. Data sourced from DNS records, threat intelligence feeds, and public profiles.</p>
  </div>

</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
// ── Theme toggle ──
function getPreferredTheme() {
  const saved = localStorage.getItem('averrow-theme');
  if (saved) return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('themeIcon').textContent = t === 'dark' ? '\\u2600' : '\\u263E';
  localStorage.setItem('averrow-theme', t);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}
applyTheme(getPreferredTheme());

// ── Advanced toggle ──
function toggleAdvanced() {
  const panel = document.getElementById('advPanel');
  const icon = document.getElementById('advIcon');
  const isOpen = panel.classList.toggle('open');
  icon.textContent = isOpen ? '\\u25BE' : '\\u25B6';
}

// ── Toast ──
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Score ring color ──
function scoreColor(score) {
  if (score >= 75) return '#C83C3C';
  if (score >= 50) return '#E8923C';
  if (score >= 25) return '#DCAA32';
  return '#28A050';
}

function statusClass(s) {
  const map = { pass: 'status-pass', partial: 'status-partial', weak: 'status-weak', missing: 'status-missing', present: 'status-present' };
  return map[s] || 'status-present';
}

function socialStatusText(avail) {
  if (avail === true) return { text: 'Available', cls: 'social-available' };
  if (avail === false) return { text: 'Claimed', cls: 'social-claimed' };
  return { text: 'Unknown', cls: 'social-unknown' };
}

// ── Enter key ──
document.getElementById('domainInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') runScan();
});

// ── Share URL ──
function shareReport() {
  const url = window.location.href;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard'));
  } else {
    showToast('Copy this URL to share: ' + url);
  }
}

// ── Run Scan ──
async function runScan() {
  const domainRaw = document.getElementById('domainInput').value.trim();
  const brandName = document.getElementById('brandInput').value.trim();
  const errEl = document.getElementById('errorMsg');
  const loadingEl = document.getElementById('loading');
  const reportEl = document.getElementById('report');
  const btn = document.getElementById('scanBtn');

  errEl.classList.remove('visible');
  reportEl.classList.remove('visible');

  // Normalize domain
  let domain = domainRaw.toLowerCase().replace(/^https?:\\/\\//, '').replace(/\\/.*$/, '').replace(/^www\\./, '');
  if (!domain || !domain.includes('.')) {
    errEl.textContent = 'Please enter a valid domain (e.g., example.com)';
    errEl.classList.add('visible');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Scanning...';  // brief flash before loading panel takes over
  loadingEl.classList.add('visible');

  try {
    // Public scan: call /api/brand-scan/public so the /scan page returns the
    // same brief score+risk shape as the homepage widget (templates/homepage.ts).
    // Single source of truth: lead capture is required for the full report.
    // Previous behavior rendered a full BrandExposureReport here, which exposed
    // far more detail than the public flow is meant to show.
    const res = await fetch('/api/brand-scan/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });

    const json = await res.json();

    if (!res.ok || !json.success) {
      throw new Error(json.error || 'Scan failed');
    }

    renderReport(json.data, brandName);
  } catch (err) {
    errEl.textContent = err.message || 'Something went wrong. Please try again.';
    errEl.classList.add('visible');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan Domain';  // reset after scan completes
    loadingEl.classList.remove('visible');
  }
}

// Free-email providers blocked from the lead-capture form. Mirrors the
// list in templates/homepage.ts — keep them in sync if that one changes.
var FREEMAIL_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','mail.com','protonmail.com','proton.me','yandex.com','zoho.com','gmx.com','fastmail.com','tutanota.com','hey.com','live.com','msn.com','me.com','qq.com','163.com'];

// ── Render Report ──
// Brief render matching templates/homepage.ts's scan widget. Public flow:
// shows score + risk pills + a lead-capture form; full report is gated
// behind a business email submission (POSTed to /api/leads).
function renderReport(data, brandName) {
  const el = document.getElementById('report');
  const score = data.trustScore;
  const color = scoreColor(score);
  const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : score >= 20 ? 'D' : 'F';
  const summary = score >= 80
    ? 'Strong defensive posture. Continue monitoring.'
    : score >= 60
    ? 'Moderate exposure detected. Review below.'
    : score >= 40
    ? 'Significant exposure. Brand impersonation likely possible.'
    : 'Critical exposure. Active brand abuse risk.';

  const risks = [];
  if (data.riskLevel === 'critical' || data.riskLevel === 'high') {
    risks.push({ text: 'Risk: ' + data.riskLevel.toUpperCase(), cls: 'bad' });
  } else if (data.riskLevel === 'medium') {
    risks.push({ text: 'Risk: MEDIUM', cls: 'warn' });
  } else {
    risks.push({ text: 'Risk: LOW', cls: 'ok' });
  }
  if (data.feedMentions) {
    risks.push({ text: 'Active threats detected', cls: 'bad' });
  } else {
    risks.push({ text: 'No active threats', cls: 'ok' });
  }
  if (data.lookalikesPossible > 50) {
    risks.push({ text: data.lookalikesPossible + ' lookalike domains possible', cls: 'warn' });
  }

  el.innerHTML = \`
    <div class="result-card">
      <div class="result-domain">\${esc(brandName || data.domain)}</div>
      <div class="score-ring">
        <svg viewBox="0 0 140 140">
          <circle cx="70" cy="70" r="60" fill="none" stroke="var(--bg-tertiary)" stroke-width="6"/>
          <circle cx="70" cy="70" r="60" fill="none" stroke="\${color}" stroke-width="6" stroke-dasharray="377" stroke-dashoffset="\${377 * (1 - score / 100)}" stroke-linecap="round" transform="rotate(-90 70 70)" style="transition:stroke-dashoffset 1.5s ease"/>
        </svg>
        <div class="score-val" style="color:\${color}">\${score}</div>
      </div>
      <div class="score-grade" style="color:\${color}">Defense Grade: \${grade}</div>
      <div class="score-summary">\${summary}</div>
      <div class="risk-pills">\${risks.map(function(r) { return '<span class="risk-p ' + r.cls + '">' + esc(r.text) + '</span>'; }).join('')}</div>
      <div class="gate-divider">
        <div class="gate-title">Get the Full Intercept Report</div>
        <div class="gate-sub">Detailed assessment with threat actor analysis, infrastructure mapping, and specific remediation steps.</div>
        <form class="gate-form" id="gateForm">
          <input class="gate-input" id="emailInput" name="email" placeholder="Business email address" type="email" required>
          <button class="gate-btn" type="submit" id="gateBtn">Get Report</button>
        </form>
        <div class="gate-note" id="gateNote">Business email required &middot; Free &middot; No credit card</div>
      </div>
    </div>
  \`;

  document.getElementById('gateForm').addEventListener('submit', function(ev) {
    ev.preventDefault();
    const email = document.getElementById('emailInput').value.trim();
    const emailDomain = (email.split('@')[1] || '').toLowerCase();
    if (!email || !email.includes('@')) return;
    if (FREEMAIL_DOMAINS.indexOf(emailDomain) !== -1) {
      document.getElementById('emailInput').style.borderColor = 'var(--accent)';
      const note = document.getElementById('gateNote');
      note.textContent = 'Please use a business email address (no free email providers)';
      note.className = 'gate-note gate-error';
      return;
    }
    const gbtn = document.getElementById('gateBtn');
    gbtn.textContent = 'Sending...';
    gbtn.disabled = true;
    fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, name: email.split('@')[0], domain: data.domain, company: emailDomain }),
    })
    .then(function() {
      gbtn.textContent = '\\u2713 Sent!';
      gbtn.style.background = 'var(--green)';
      const note = document.getElementById('gateNote');
      note.textContent = 'Check your inbox \\u2014 we\\u2019ve confirmed your request. Your Averrow team is preparing your full report.';
      note.style.color = 'var(--green)';
      note.className = 'gate-note';
    })
    .catch(function() {
      gbtn.textContent = 'Get Report';
      gbtn.disabled = false;
    });
  });

  el.classList.add('visible');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


// ── Escape HTML ──
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(s)));
  return d.innerHTML;
}

// ── URL param auto-scan ──
(function() {
  const params = new URLSearchParams(window.location.search);
  const d = params.get('domain') || params.get('d');
  if (d) {
    document.getElementById('domainInput').value = d;
    const b = params.get('brand') || params.get('b');
    if (b) document.getElementById('brandInput').value = b;
    setTimeout(runScan, 200);
  }
})();
</script>
</body>
</html>`;
}
