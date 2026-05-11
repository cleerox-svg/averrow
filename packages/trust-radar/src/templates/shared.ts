/**
 * Averrow — Shared Components
 * Reusable nav, footer, head, and page wrapper for the corporate site.
 */

/* ──────────────────────────────────────────────────────────
   renderNav — sticky glassmorphic navigation bar
   ────────────────────────────────────────────────────────── */
export function renderNav(): string {
  return `
<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-brand">
      <svg width="28" height="28" viewBox="0 0 32 32" style="flex-shrink:0" class="averrow-mark">
        <defs>
          <linearGradient id="deep-arrow-nav" x1="16" y1="5" x2="16" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#6B1010"/>
            <stop offset="100%" stop-color="#C83C3C"/>
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="6" fill="#080E18"/>
        <path d="M16 5L26 26H18L16 21L14 26H6Z" fill="url(#deep-arrow-nav)"/>
        <path d="M14.5 22H17.5L16 18Z" fill="#080E18"/>
      </svg>
      <div>
        <span class="nav-brand-text">AVERROW</span>
        <span class="nav-brand-sub">THREAT INTERCEPTOR</span>
      </div>
    </a>
    <ul class="nav-links">
      <li><a href="/platform">Platform</a></li>
      <li><a href="/pricing">Pricing</a></li>
      <li><a href="/about">About</a></li>
      <li><a href="/security">Security</a></li>
      <li><a href="/blog">Blog</a></li>
      <li><a href="/contact">Contact</a></li>
    </ul>
    <div class="nav-right">
      <button class="nav-hamburger" onclick="toggleMobileMenu()" aria-label="Toggle menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
      <button class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme">
        <span id="theme-icon">\u2600</span>
      </button>
      <a href="/login" class="btn btn-outline" style="font-size:0.82rem;padding:0.45rem 1rem;">Login</a>
      <a href="/scan" class="btn btn-primary" style="font-size:0.82rem;padding:0.45rem 1rem;">Free Scan</a>
    </div>
  </div>
</nav>
<div class="mobile-menu" id="mobileMenu">
  <a href="/platform">Platform</a>
  <a href="/pricing">Pricing</a>
  <a href="/about">About</a>
  <a href="/security">Security</a>
  <a href="/blog">Blog</a>
  <a href="/contact">Contact</a>
  <a href="/login">Login</a>
  <a href="/scan">Free Scan</a>
</div>`;
}

/* ──────────────────────────────────────────────────────────
   renderFooter — 4-column footer
   ────────────────────────────────────────────────────────── */
export function renderFooter(): string {
  return `
<footer class="footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand-block">
        <a href="/" class="nav-brand" style="margin-bottom:0.5rem">
          <svg width="24" height="24" viewBox="0 0 32 32" style="flex-shrink:0" class="averrow-mark">
            <defs>
              <linearGradient id="deep-arrow-foot" x1="16" y1="5" x2="16" y2="26" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#6B1010"/>
                <stop offset="100%" stop-color="#C83C3C"/>
              </linearGradient>
            </defs>
            <rect width="32" height="32" rx="6" fill="#080E18"/>
            <path d="M16 5L26 26H18L16 21L14 26H6Z" fill="url(#deep-arrow-foot)"/>
            <path d="M14.5 22H17.5L16 18Z" fill="#080E18"/>
          </svg>
          <div>
            <span class="nav-brand-text" style="font-size:18px">AVERROW</span>
          </div>
        </a>
        <p>AI-powered brand protection by LRX Enterprises Inc. Continuous airspace defense against impersonation, phishing, and social media abuse.</p>
        <p style="margin-top:1rem;font-size:0.82rem;color:var(--text-tertiary)">
          <a href="mailto:hello@averrow.com" style="color:var(--text-tertiary);transition:color 0.2s;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-tertiary)'">hello@averrow.com</a>
        </p>
        <svg width="36" height="36" viewBox="0 0 32 32" class="footer-orbital-mark" aria-hidden="true">
          <defs>
            <linearGradient id="deep-arrow-foot-mark" x1="16" y1="5" x2="16" y2="26" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#6B1010"/>
              <stop offset="100%" stop-color="#C83C3C"/>
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="6" fill="#080E18"/>
          <path d="M16 5L26 26H18L16 21L14 26H6Z" fill="url(#deep-arrow-foot-mark)"/>
          <path d="M14.5 22H17.5L16 18Z" fill="#080E18"/>
        </svg>
      </div>
      <div class="footer-col">
        <div class="footer-col-title">Product</div>
        <ul>
          <li><a href="/platform">Platform</a></li>
          <li><a href="/pricing">Pricing</a></li>
          <li><a href="/scan">Free Scan</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <div class="footer-col-title">Resources</div>
        <ul>
          <li><a href="/blog">Blog</a></li>
          <li><a href="/changelog">Changelog</a></li>
          <li><a href="/security">Security</a></li>
          <li><a href="/status">Status</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <div class="footer-col-title">Company</div>
        <ul>
          <li><a href="/about">About</a></li>
          <li><a href="/contact">Contact</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <div class="footer-col-title">Legal</div>
        <ul>
          <li><a href="/privacy">Privacy</a></li>
          <li><a href="/terms">Terms</a></li>
          <li><a href="/privacy">DPA</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span class="footer-legal">&copy; 2026 LRX Enterprises Inc. All rights reserved.</span>
    </div>
  </div>
</footer>`;
}

/* ──────────────────────────────────────────────────────────
   renderHead — <head> content with full design-system CSS
   ────────────────────────────────────────────────────────── */
export function renderHead(title: string, description: string): string {
  return `
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-192.svg">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<noscript>
  <style>
    /* JS off: force reveal patterns visible so crawlers and no-JS users
       see every section. Matches the @media reduced-motion override. */
    .fade-in-section, .reveal,
    .platform-card, .feature-row, .price-card, .fact-card {
      opacity: 1 !important;
      transform: none !important;
    }
  </style>
</noscript>
<style>
/* ═══════════════════════════════════════════════════════════
   AVERROW — DESIGN SYSTEM
   LRX Enterprises Inc.
   ═══════════════════════════════════════════════════════════ */

*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

/* ── THEME TOKENS ──
   Aligned with platform tokens (CLAUDE.md §5). Marketing keeps its own
   variable names so existing call sites stay valid; only values shift. */
:root {
  --font-display: 'Plus Jakarta Sans', sans-serif;
  --font-body: 'Plus Jakarta Sans', sans-serif;
  --font-mono: 'IBM Plex Mono', monospace;

  /* Accent — Signal Red (matches platform --red) */
  --accent: #C83C3C;
  --accent-hover: #A82E2E;
  --accent-light: #E87070;
  --accent-bg: rgba(200, 60, 60, 0.08);
  --accent-bg-strong: rgba(200, 60, 60, 0.15);

  /* Platform palette parity */
  --red: #C83C3C;
  --red-dim: #8B1A1A;
  --red-bg: rgba(200, 60, 60, 0.08);
  --amber: #E5A832;        /* was #E8923C — aligned with platform gold */
  --amber-dim: #B8821F;
  --green: #3CB878;        /* was #28A050 — aligned with platform */
  --green-dim: #1A6B3C;
  --green-bg: rgba(60, 184, 120, 0.08);
  --blue: #0A8AB5;         /* was #78A0C8 — aligned with platform */
  --blue-dim: #065A78;

  /* Severity (platform parity) */
  --sev-critical: #f87171;
  --sev-high: #fb923c;
  --sev-medium: #fbbf24;
  --sev-low: #60a5fa;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-xl: 24px;
}

[data-theme="light"] {
  --bg-primary: #F8F7F5;
  --bg-secondary: #FFFFFF;
  --bg-tertiary: #FAFAF8;
  --bg-code: #F0EDE8;
  --bg-elevated: #FFFFFF;
  --text-primary: #1A1F2E;
  --text-secondary: #5A6170;
  --text-tertiary: #8A8F9C;
  --text-inverse: #F0EDE8;
  --border: #E2DDD5;
  --border-strong: rgba(226,221,213,0.6);
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 24px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.8);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.08);
  --shadow-glow: 0 0 40px rgba(181,48,48,0.12);
  --gradient-hero: linear-gradient(135deg, #F8F7F5 0%, #FAFAF8 50%, #F8F7F5 100%);
  --illustration-fill: #1A1F2E;
  --illustration-stroke: #B53030;
  --accent: #B53030;
  --accent-hover: #9A2828;
  --accent-bg: rgba(181,48,48,0.06);
  --accent-bg-strong: rgba(181,48,48,0.12);
  --accent-section: #C88B1E;
  --nav-bg: rgba(248,247,245,0.8);

  /* Glass card tokens */
  --glass-card-bg: rgba(255,255,255,0.6);
  --glass-card-border: rgba(226,221,213,0.5);
  --glass-card-shadow: 0 4px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.9);
  --glass-card-hover-shadow: 0 8px 32px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.9);
}

[data-theme="dark"] {
  --bg-primary: #060A14;     /* matches platform --bg-page */
  --bg-secondary: #0E1A2B;
  --bg-tertiary: #142236;
  --bg-code: #0C1420;
  --bg-elevated: #1A2E48;
  --text-primary: rgba(255,255,255,0.92);  /* matches platform --text-primary */
  --text-secondary: rgba(255,255,255,0.60);
  --text-tertiary: rgba(255,255,255,0.40);
  --text-inverse: #1A1F2E;
  --border: rgba(120, 160, 200, 0.08);
  --border-strong: rgba(120, 160, 200, 0.15);
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.3);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.4);
  --shadow-glow: 0 0 60px rgba(229,168,50,0.18);
  --gradient-hero: linear-gradient(135deg, #060A14 0%, #0E1A2B 50%, #060A14 100%);
  --illustration-fill: #F0EDE8;
  --illustration-stroke: #C83C3C;
  --nav-bg: rgba(6,10,20,0.85);

  /* Glass card tokens (parity with light mode) */
  --glass-card-bg: rgba(22,30,48,0.85);
  --glass-card-border: rgba(120,160,200,0.10);
  --glass-card-shadow: 0 4px 24px rgba(0,0,0,0.30);
  --glass-card-hover-shadow: 0 8px 32px rgba(0,0,0,0.45);
}

html { scroll-behavior: smooth; }

/* ── REVEAL FALLBACKS ──
   The site uses three reveal patterns: .fade-in-section, .reveal, and
   JS-applied inline opacity. All three start hidden on the default code
   path. If JS doesn't run, or the user prefers reduced motion, force
   them visible so crawlers, screenshot tools, and accessibility users
   never see empty pages. */
@media (prefers-reduced-motion: reduce) {
  .fade-in-section,
  .reveal {
    opacity: 1 !important;
    transform: none !important;
    transition: none !important;
  }
}

body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--font-body);
  line-height: 1.65;
  transition: background 0.4s, color 0.3s;
  overflow-x: hidden;
}

a { color: inherit; text-decoration: none; }
img { max-width: 100%; }

.container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 2rem;
}

/* ── NAV ── */
.nav {
  position: fixed;
  top: 0;
  width: 100%;
  z-index: 1000;
  background: var(--nav-bg);
  backdrop-filter: blur(24px) saturate(180%);
  border-bottom: 1px solid var(--border);
  transition: background 0.3s, border 0.3s, backdrop-filter 0.3s;
}
.nav::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, transparent 10%, #C83C3C 50%, transparent 90%, transparent 100%);
  opacity: 0.55;
  pointer-events: none;
}
.nav-scrolled {
  backdrop-filter: blur(40px) saturate(220%);
  background: var(--nav-bg);
}
[data-theme="light"] .nav-scrolled {
  background: rgba(248,247,245,0.85);
  border-bottom-color: rgba(226,221,213,0.5);
}

.nav-inner {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 2rem;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.nav-brand svg { transition: opacity 0.3s; }
.nav-brand:hover svg { opacity: 0.85; }

.nav-brand-text {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 18px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.nav-brand-sub {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-tertiary);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  display: block;
  margin-top: -1px;
  font-weight: 400;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  list-style: none;
}

.nav-links a {
  padding: 0.5rem 0.85rem;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  transition: all 0.2s;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.nav-links a:hover {
  color: var(--text-primary);
  background: var(--accent-bg);
}

.nav-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.theme-toggle {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  transition: all 0.2s;
  color: var(--text-secondary);
}

.theme-toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* ── BUTTONS ── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1.4rem;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
  text-decoration: none;
}

.btn-primary {
  background: var(--accent);
  color: white;
  position: relative;
  overflow: hidden;
}
.btn-primary::after {
  content: '';
  position: absolute;
  top: 0; left: -100%; width: 60%; height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent);
  transition: none;
}
.btn-primary:hover::after {
  animation: shimmer 0.6s forwards;
}
@keyframes shimmer {
  to { left: 120%; }
}

.btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 0 20px rgba(200,60,60,0.3);
  transform: scale(1.02);
}

.btn-outline {
  background: transparent;
  color: var(--text-primary);
  border: 1.5px solid var(--border-strong);
}

.btn-outline:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-bg);
}

.btn-ghost {
  background: transparent;
  color: var(--accent);
  padding: 0.5rem 0.75rem;
}

.btn-ghost:hover { background: var(--accent-bg); }

.btn-lg {
  padding: 0.85rem 2rem;
  font-size: 14px;
}

/* ── SECTIONS ── */
section {
  padding: 3rem 0;
}

.section-label {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-section, var(--accent));
  letter-spacing: 0.2em;
  text-transform: uppercase;
  margin-bottom: 0.5rem;
}

.section-title {
  font-family: var(--font-display);
  font-size: clamp(24px, 3vw, 36px);
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.03em;
  margin-bottom: 0.5rem;
  max-width: 640px;
}

.section-desc {
  font-size: 16px;
  color: var(--text-secondary);
  line-height: 1.7;
  max-width: 560px;
  margin-bottom: 1.25rem;
}

/* ── DIVIDERS ── */
.tr-divider {
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, var(--border) 20%, var(--accent) 50%, var(--border) 80%, transparent 100%);
  border: none;
  margin: 0;
}
.tr-divider-animated {
  height: 1px;
  border: none;
  background: linear-gradient(90deg, transparent, var(--border), var(--accent), var(--border), transparent);
  background-size: 200% 100%;
  animation: dividerSlide 3s linear infinite;
}
@keyframes dividerSlide {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

/* ── PLATFORM CARDS ── */
.platform-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 2rem;
  transition: all 0.3s;
  position: relative;
  overflow: hidden;
}

.platform-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  opacity: 0;
  transition: opacity 0.3s;
}

.platform-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-glow);
  transform: translateY(-2px);
}

.platform-card:hover::before { opacity: 1; }
.platform-card:nth-child(1)::before { background: var(--accent); }
.platform-card:nth-child(2)::before { background: var(--amber); }
.platform-card:nth-child(3)::before { background: var(--green); }

.pc-icon {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 1.5rem;
  font-size: 1.4rem;
}

.pc-icon-teal { background: var(--accent-bg); color: var(--accent); }
.pc-icon-coral { background: rgba(232, 146, 60, 0.08); color: var(--amber); }
.pc-icon-green { background: var(--green-bg); color: var(--green); }

.platform-card h3 {
  font-family: var(--font-display);
  font-size: 1.2rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
}

.platform-card p {
  font-size: 0.92rem;
  color: var(--text-secondary);
  line-height: 1.7;
  margin-bottom: 1.25rem;
}

.pc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.pc-tag {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 500;
  padding: 0.25rem 0.6rem;
  border-radius: 100px;
  background: var(--bg-tertiary);
  color: var(--text-tertiary);
  border: 1px solid var(--border);
  transition: all 0.3s;
}

/* ── FOOTER ── */
.footer {
  position: relative;
  padding: 3rem 0 2rem;
  transition: border 0.3s;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='6'%3E%3Ccircle cx='1.5' cy='1.5' r='0.6' fill='%23888888' fill-opacity='0.05'/%3E%3C/svg%3E");
  background-repeat: repeat;
}
.footer::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, transparent 10%, #C83C3C 50%, transparent 90%, transparent 100%);
  opacity: 0.55;
}
.footer-orbital-mark {
  opacity: 0.35;
  margin-top: 1.25rem;
}

.footer-grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
  gap: 3rem;
  margin-bottom: 2rem;
}

.footer-brand-block p {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin-top: 1rem;
  max-width: 280px;
}

.footer-col-title {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 1rem;
}

.footer-col ul {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.footer-col a {
  font-size: 14px;
  color: var(--text-secondary);
  transition: color 0.2s;
}

.footer-col a:hover { color: var(--accent); }

.footer-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 2rem;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
  gap: 1rem;
}

.footer-legal {
  font-size: 0.78rem;
  color: var(--text-tertiary);
}

.footer-badges {
  display: flex;
  align-items: center;
  gap: 1.5rem;
}

.footer-badge-item {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.fb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

/* ── LIGHT THEME GLASS EFFECTS ── */
[data-theme="light"] .platform-card,
[data-theme="light"] .value-prop-item,
[data-theme="light"] .card {
  background: var(--glass-card-bg, rgba(255,255,255,0.6));
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-color: var(--glass-card-border, rgba(226,221,213,0.5));
  box-shadow: var(--glass-card-shadow);
}
[data-theme="light"] .platform-card:hover,
[data-theme="light"] .value-prop-item:hover,
[data-theme="light"] .card:hover {
  box-shadow: var(--glass-card-hover-shadow);
  border-color: rgba(226,221,213,0.7);
}

[data-theme="light"] .price-card {
  background: rgba(255,255,255,0.7);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(226,221,213,0.5);
  border-radius: 16px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.9);
}
[data-theme="light"] .price-card:hover {
  box-shadow: 0 8px 32px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.9);
}
[data-theme="light"] .price-card.popular {
  border: 2px solid rgba(200,139,30,0.3);
  box-shadow: 0 4px 24px rgba(200,139,30,0.06), inset 0 1px 0 rgba(255,255,255,0.9);
}
[data-theme="light"] .price-card.popular::before {
  background: #C88B1E;
}

[data-theme="light"] .compare-table {
  background: rgba(255,255,255,0.7);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* ── LOGO DARK CONTAINER (LIGHT THEME) ── */
/* Deep Arrow SVG has built-in dark rect — no CSS background needed */

/* ── SCROLL ANIMATIONS ── */
.reveal {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.6s ease, transform 0.6s ease;
}
.revealed {
  opacity: 1;
  transform: translateY(0);
}

/* ── PAGE TRANSITION ── */
.page-content {
  animation: pageIn 0.4s ease;
}
@keyframes pageIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ── CARD SYSTEM ── */
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  transition: all 0.2s ease;
}
.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
  border-color: var(--border-strong);
}

/* ── ANIMATIONS ── */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(200,60,60,0.4); }
  50% { opacity: 0.8; box-shadow: 0 0 0 6px rgba(200,60,60,0); }
}

/* ── RESPONSIVE ── */
@media (max-width: 1024px) {
  .footer-grid { grid-template-columns: 1fr 1fr; gap: 2rem; }
}

@media (max-width: 768px) {
  section { padding: 2rem 0; }
  .nav-links { display: none; }
  .footer-grid { grid-template-columns: 1fr 1fr; gap: 1.5rem; text-align: center; }
  .footer-brand-block { grid-column: 1 / -1; text-align: center; margin-bottom: 1rem; }
  .footer-brand-block a { justify-content: center; }
  .footer-brand-block p { text-align: center; max-width: 100%; }
  .footer-orbital-mark { margin: 0.5rem auto 0; }
  .footer-col { text-align: center; }
  .footer-col ul { align-items: center; }
  .footer-bottom { text-align: center; justify-content: center; padding-top: 1.5rem; gap: 0.5rem; }
}

/* ── MOBILE MENU ── */
.nav-hamburger {
  display: none;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  cursor: pointer;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: all 0.2s;
}
.nav-hamburger:hover { border-color: var(--accent); color: var(--accent); }

.mobile-menu {
  display: none;
  position: fixed;
  top: 64px;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  padding: 1rem 2rem;
  z-index: 999;
  flex-direction: column;
  gap: 0.25rem;
  box-shadow: var(--shadow-lg);
}
.mobile-menu.open { display: flex; }
.mobile-menu a {
  display: block;
  padding: 0.75rem 1rem;
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  transition: all 0.2s;
}
.mobile-menu a:hover { background: var(--accent-bg); color: var(--accent); }

@media (max-width: 768px) {
  .nav-hamburger { display: flex; }
  .nav-links { display: none !important; }
  .nav-right .btn { display: none; }
  .nav-right .theme-toggle { order: 2; }
  .nav-right .nav-hamburger { order: 1; }
}

/* ── TRUST SIGNALS ──
   Sector strip + testimonial. Shared across home + pricing.
   Placeholder content marked for swap when real customer logos
   and testimonials land. */
.trust-signals {
  padding: 56px 24px 32px;
  max-width: 1200px;
  margin: 0 auto;
  text-align: center;
}
.trust-strip-label {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin-bottom: 18px;
}
.trust-strip-grid {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 36px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 14px 24px;
}
.trust-sector {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--text-tertiary);
  opacity: 0.85;
  transition: opacity 0.2s, color 0.2s;
}
.trust-sector:hover { opacity: 1; color: var(--text-secondary); }
.trust-sector-icon {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.trust-sector-icon svg {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.trust-sector-label {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.trust-disclaimer {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-tertiary);
  opacity: 0.6;
  letter-spacing: 0.05em;
  margin-bottom: 36px;
}
.testimonial-card {
  max-width: 720px;
  margin: 0 auto;
  padding: 28px 32px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--glass-card-bg, rgba(22,30,48,0.55));
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
  text-align: left;
  position: relative;
}
.testimonial-quote-mark {
  position: absolute;
  top: 8px;
  left: 18px;
  font-family: var(--font-display);
  font-size: 64px;
  line-height: 1;
  color: var(--amber);
  opacity: 0.18;
  pointer-events: none;
  user-select: none;
}
.testimonial-quote {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 500;
  line-height: 1.55;
  color: var(--text-primary);
  margin-bottom: 18px;
  position: relative;
  z-index: 1;
}
.testimonial-attribution {
  display: flex;
  align-items: center;
  gap: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
}
.testimonial-attribution-divider {
  width: 24px;
  height: 1px;
  background: var(--amber);
  opacity: 0.6;
}
.testimonial-role {
  color: var(--text-primary);
  font-weight: 600;
  letter-spacing: 0.04em;
}
.testimonial-meta {
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
}
@media (max-width: 640px) {
  .trust-strip-grid { gap: 24px; }
  .trust-signals { padding: 40px 16px 24px; }
  .testimonial-card { padding: 22px 22px; }
  .testimonial-quote { font-size: 16px; }
  .testimonial-attribution { flex-direction: column; align-items: flex-start; gap: 6px; }
  .testimonial-attribution-divider { display: none; }
}
</style>`;
}

/* ──────────────────────────────────────────────────────────
   renderTrustSignals — sector strip + testimonial card.
   Placeholder content; swap when real customer logos and
   testimonials land. Wrap in a <section class="trust-signals
   fade-in-section"> at the call site so each page controls
   its own rhythm with surrounding sections.
   ────────────────────────────────────────────────────────── */
export function renderTrustSignals(): string {
  return `
  <div class="trust-strip-label">Trusted by security teams across</div>
  <div class="trust-strip-grid">
    <div class="trust-sector" title="Financial services">
      <div class="trust-sector-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M3 21h18"/>
          <path d="M5 21V10"/>
          <path d="M19 21V10"/>
          <path d="M9 21v-7"/>
          <path d="M15 21v-7"/>
          <path d="M3 10l9-6 9 6"/>
        </svg>
      </div>
      <div class="trust-sector-label">Fintech</div>
    </div>
    <div class="trust-sector" title="Software / SaaS">
      <div class="trust-sector-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect x="3" y="4" width="18" height="14" rx="2"/>
          <path d="M3 10h18"/>
          <path d="M8 18l-2 4"/>
          <path d="M16 18l2 4"/>
        </svg>
      </div>
      <div class="trust-sector-label">SaaS</div>
    </div>
    <div class="trust-sector" title="Healthcare">
      <div class="trust-sector-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M12 21s-7-4.5-7-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.5-7 11-7 11z" transform="translate(-2 0)"/>
          <path d="M9 12h2v-2h2v2h2v2h-2v2h-2v-2H9z"/>
        </svg>
      </div>
      <div class="trust-sector-label">Healthcare</div>
    </div>
    <div class="trust-sector" title="Retail / E-commerce">
      <div class="trust-sector-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
          <path d="M3 6h18"/>
          <path d="M16 10a4 4 0 1 1-8 0"/>
        </svg>
      </div>
      <div class="trust-sector-label">E-commerce</div>
    </div>
    <div class="trust-sector" title="Media / Publishing">
      <div class="trust-sector-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18"/>
          <path d="M9 21V9"/>
        </svg>
      </div>
      <div class="trust-sector-label">Media</div>
    </div>
    <div class="trust-sector" title="Marketing / Agencies">
      <div class="trust-sector-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M3 11l18-7v16l-18-7"/>
          <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>
        </svg>
      </div>
      <div class="trust-sector-label">Marketing</div>
    </div>
  </div>
  <div class="trust-disclaimer">Sample placement &mdash; customer logos publishing in 2026.</div>

  <div class="testimonial-card">
    <div class="testimonial-quote-mark" aria-hidden="true">&ldquo;</div>
    <div class="testimonial-quote">Averrow caught three impersonation domains in our first week &mdash; two of them already had MX records and were ready to send. We had been doing this manually with two analysts, and they were missing this.</div>
    <div class="testimonial-attribution">
      <span class="testimonial-role">VP of Security</span>
      <span class="testimonial-attribution-divider" aria-hidden="true"></span>
      <span class="testimonial-meta">Mid-market SaaS &middot; 800 employees</span>
    </div>
  </div>`;
}

/* ──────────────────────────────────────────────────────────
   wrapPage — full HTML document wrapper
   ────────────────────────────────────────────────────────── */
export function wrapPage(title: string, description: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
${renderHead(title, description)}
<script>
  // Pre-paint theme load — avoids a flash from the dark default to a
  // saved-light preference. Runs before <body> so the variables are set
  // before the first paint.
  (function(){
    try {
      var saved = localStorage.getItem('averrow-theme');
      if (saved === 'light' || saved === 'dark') {
        document.documentElement.setAttribute('data-theme', saved);
      }
    } catch (e) {}
  })();
</script>
</head>
<body>

${renderNav()}

<div class="page-content">
${content}
</div>

${renderFooter()}

<!-- Contact: sp.trap09@trustradar.ca | Webmaster: sp.trap10@averrow.com -->
<div style="position:absolute;left:-9999px;top:-9999px;overflow:hidden;height:0;width:0" aria-hidden="true">
  <a href="mailto:sp.trap01@averrow.com">Email our security team</a>
  <a href="mailto:sp.trap02@trustradar.ca">Contact support</a>
  <a href="mailto:sp.trap03@averrow.com">Report abuse</a>
  <a href="mailto:sp.trap04@trustradar.ca">Business inquiries</a>
  <a href="mailto:sp.trap05@averrow.com">Press contact</a>
  <p>For general inquiries: sp.trap06@averrow.com</p>
  <p>Compliance team: sp.trap07@trustradar.ca</p>
  <p>Recruitment: sp.trap08@averrow.com</p>
</div>

<script>
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = next === 'light' ? '\\u2600' : '\\u263E';
  try { localStorage.setItem('averrow-theme', next); } catch (e) {}
}

// Sync icon to whatever theme the pre-paint script settled on
(function(){
  var theme = document.documentElement.getAttribute('data-theme') || 'dark';
  var icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'light' ? '\\u2600' : '\\u263E';
})();

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// Scroll animations — .reveal class. Skip entirely under reduced-motion.
var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!prefersReducedMotion && 'IntersectionObserver' in window) {
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('revealed');
        revealObserver.unobserve(e.target);
      }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

  // Legacy inline observer for cards without .reveal — only flip cards to
  // hidden when JS + IO + motion are all available. CSS-default is visible.
  const cardObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });

  document.querySelectorAll('.platform-card, .feature-row, .price-card, .fact-card').forEach(el => {
    if (!el.classList.contains('reveal')) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(24px)';
      el.style.transition = 'opacity 0.6s ease, transform 0.6s ease, background 0.3s, border 0.3s, box-shadow 0.3s';
      cardObserver.observe(el);
    }
  });
} else {
  // Reduced motion or no IO: make sure .reveal targets are immediately visible.
  document.querySelectorAll('.reveal').forEach(el => el.classList.add('revealed'));
}

// Nav scroll — stronger blur on scroll
const nav = document.querySelector('.nav');
window.addEventListener('scroll', () => {
  if (window.scrollY > 20) {
    nav && nav.classList.add('nav-scrolled');
  } else {
    nav && nav.classList.remove('nav-scrolled');
  }
}, { passive: true });

// Mobile menu
function toggleMobileMenu() {
  const menu = document.getElementById('mobileMenu');
  if (menu) menu.classList.toggle('open');
}
</script>

</body>
</html>`;
}
