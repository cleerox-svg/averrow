/**
 * Averrow — 404 Not Found Page
 *
 * Centered, minimal page with large 404 display,
 * subtitle, description, and two action buttons.
 *
 * Facelift Phase 4: R3 logo, indigo primary, graphite dark palette, system
 * font stack (no Google Fonts). See ./brand.ts.
 */

import { r3MarkSvg, r3WordmarkSvg, R3_FAVICON_DATA_URI, FONT_SANS_STACK, FONT_MONO_STACK } from "./brand";

export function renderNotFoundPage(): string {
  return `
<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Page Not Found — Averrow</title>
<meta name="description" content="The page you're looking for doesn't exist or has been moved.">
<link rel="icon" href="${R3_FAVICON_DATA_URI}" type="image/svg+xml">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --font-display: ${FONT_SANS_STACK};
  --font-body: ${FONT_SANS_STACK};
  --font-mono: ${FONT_MONO_STACK};
  /* Primary — indigo (fill). --primary-text is the AA text colour. */
  --accent: #3250f0;
  --accent-hover: #2941d9;
  --accent-light: #2a44d3;
  --accent-ultra: #8f9dff;
  --primary-text: #2a44d3;
  --accent-bg: rgba(50, 80, 240, 0.06);
  --accent-bg-strong: rgba(50, 80, 240, 0.12);
  --coral: #E8923C;
  --coral-bg: rgba(232, 146, 60, 0.08);
  --green: #3CB878;
  --green-bg: rgba(60, 184, 120, 0.08);
  --red: #C83C3C;
  --red-bg: rgba(200, 60, 60, 0.08);
  --amber: #E5A832; /* status only */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-xl: 24px;
}

[data-theme="light"] {
  --bg-primary: #f0f2f8;
  --bg-secondary: #ffffff;
  --bg-tertiary: #f6f8fb;
  --bg-code: #f6f8fb;
  --bg-elevated: #ffffff;
  --text-primary: #0f1216;
  --text-secondary: #383b40;
  --text-tertiary: #4c4e54;
  --text-inverse: #ffffff;
  --border: rgba(18, 22, 29, 0.14);
  --border-strong: rgba(18, 22, 29, 0.24);
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.06);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.08);
  --shadow-glow: 0 0 40px rgba(50,80,240,0.12);
  --gradient-hero: linear-gradient(135deg, #f0f2f8 0%, #f6f8fb 50%, #f0f2f8 100%);
  --nav-bg: rgba(240,242,248,0.85);
}

[data-theme="dark"] {
  --accent: #4c5cf8;
  --accent-hover: #4f60ff;
  --accent-light: #96acff;
  --accent-ultra: #b9c6ff;
  --primary-text: #96acff;
  --accent-bg: rgba(76, 92, 248, 0.10);
  --accent-bg-strong: rgba(76, 92, 248, 0.18);
  --bg-primary: #0a0b0e;
  --bg-secondary: #151619;
  --bg-tertiary: #0f1013;
  --bg-code: #0f1013;
  --bg-elevated: #1f2024;
  --text-primary: #f6f7f7;
  --text-secondary: #c2c2c4;
  --text-tertiary: #a1a1a3;
  --text-inverse: #151619;
  --border: rgba(245, 245, 246, 0.09);
  --border-strong: rgba(245, 245, 246, 0.16);
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.3);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.4);
  --shadow-glow: 0 0 60px rgba(76,92,248,0.16);
  --gradient-hero: linear-gradient(135deg, #0a0b0e 0%, #151619 50%, #0a0b0e 100%);
  --nav-bg: rgba(10,11,14,0.85);
}

html { scroll-behavior: smooth; }

body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--font-body);
  line-height: 1.65;
  transition: background 0.4s, color 0.3s;
  overflow-x: hidden;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

a { color: inherit; text-decoration: none; }
img { max-width: 100%; }

.container {
  max-width: 1200px;
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
  transition: background 0.3s, border 0.3s;
}

.nav-inner {
  max-width: 1200px;
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
  /* R3 wordmark SVG (fill: currentColor) */
  display: block;
  line-height: 0;
  color: var(--text-primary);
}

.nav-brand-sub {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  color: var(--text-tertiary);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  display: block;
  margin-top: -2px;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  list-style: none;
}

.nav-links a {
  padding: 0.5rem 0.85rem;
  font-size: 0.88rem;
  font-weight: 500;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  transition: all 0.2s;
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
  color: var(--primary-text);
}

/* ── BUTTONS ── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1.4rem;
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: 0.88rem;
  font-weight: 600;
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
  box-shadow: 0 0 20px rgba(76,92,248,0.35);
  transform: translateY(-1px);
}

.btn-outline {
  background: transparent;
  color: var(--text-primary);
  border: 1.5px solid var(--border-strong);
}

.btn-outline:hover {
  border-color: var(--accent);
  color: var(--primary-text);
}

.btn-lg {
  padding: 0.85rem 2rem;
  font-size: 0.95rem;
}

/* ── 404 PAGE ── */
.not-found-wrapper {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10rem 2rem 6rem;
}

.not-found-content {
  text-align: center;
  max-width: 520px;
}

.not-found-code {
  font-family: var(--font-display);
  font-size: 6rem;
  font-weight: 800;
  color: var(--primary-text);
  line-height: 1;
  letter-spacing: -0.04em;
  margin-bottom: 1rem;
  background: linear-gradient(135deg, var(--accent), var(--accent-ultra));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.not-found-subtitle {
  font-family: var(--font-display);
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 0.75rem;
}

.not-found-desc {
  font-size: 1.05rem;
  color: var(--text-secondary);
  line-height: 1.7;
  margin-bottom: 2.5rem;
}

.not-found-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  flex-wrap: wrap;
}

/* ── FOOTER ── */
.footer {
  padding: 5rem 0 2.5rem;
  border-top: 1px solid var(--border);
  transition: border 0.3s;
}

.footer-grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
  gap: 3rem;
  margin-bottom: 4rem;
}

.footer-brand-block p {
  font-size: 0.88rem;
  color: var(--text-secondary);
  line-height: 1.7;
  margin-top: 1rem;
  max-width: 280px;
}

.footer-col-title {
  font-family: var(--font-display);
  font-size: 0.82rem;
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
  font-size: 0.85rem;
  color: var(--text-secondary);
  transition: color 0.2s;
}

.footer-col a:hover { color: var(--primary-text); }

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

/* ── RESPONSIVE ── */
@media (max-width: 1024px) {
  .footer-grid { grid-template-columns: 1fr 1fr; gap: 2rem; }
}

@media (max-width: 768px) {
  .nav-links { display: none; }
  .footer-grid { grid-template-columns: 1fr; }
  .not-found-wrapper { padding: 8rem 1.5rem 4rem; }
  .not-found-code { font-size: 4.5rem; }
  .not-found-subtitle { font-size: 1.35rem; }
  .not-found-desc { font-size: 0.95rem; }
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
.nav-hamburger:hover { border-color: var(--accent); color: var(--primary-text); }

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
.mobile-menu a:hover { background: var(--accent-bg); color: var(--primary-text); }

@media (max-width: 768px) {
  .nav-hamburger { display: flex; }
  .nav-links { display: none !important; }
  .nav-right .btn { display: none; }
  .nav-right .theme-toggle { order: 2; }
  .nav-right .nav-hamburger { order: 1; }
}
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-brand">
      ${r3MarkSvg({ size: 28, tile: false, decorative: true })}
      <div>
        <span class="nav-brand-text">${r3WordmarkSvg(16)}</span>
        <span class="nav-brand-sub">Threat Intelligence</span>
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
</div>

<div class="not-found-wrapper">
  <div class="not-found-content">
    <div class="not-found-code">404</div>
    <h1 class="not-found-subtitle">Page not found</h1>
    <p class="not-found-desc">The page you're looking for doesn't exist or has been moved.</p>
    <div class="not-found-actions">
      <a href="/" class="btn btn-primary btn-lg">Go Home</a>
      <a href="/scan" class="btn btn-outline btn-lg">Run a Free Scan</a>
    </div>
  </div>
</div>

<footer class="footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand-block">
        <a href="/" class="nav-brand" style="margin-bottom:0.5rem">
          ${r3MarkSvg({ size: 24, tile: false, decorative: true })}
          <div>
            <span class="nav-brand-text">${r3WordmarkSvg(14)}</span>
          </div>
        </a>
        <p>AI-powered threat intelligence platform by LRX Enterprises Inc. Continuous monitoring for brand impersonation, phishing, and domain abuse.</p>
        <p style="margin-top:1rem;font-size:0.82rem;color:var(--text-tertiary)">
          <a href="mailto:hello@averrow.com" style="color:var(--text-tertiary);transition:color 0.2s;" onmouseover="this.style.color='var(--primary-text)'" onmouseout="this.style.color='var(--text-tertiary)'">hello@averrow.com</a>
        </p>
      </div>
      <div class="footer-col">
        <div class="footer-col-title">Product</div>
        <ul>
          <li><a href="/platform">Platform</a></li>
          <li><a href="/pricing">Pricing</a></li>
          <li><a href="/scan">Free Scan</a></li>
          <li><a href="#">Changelog</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <div class="footer-col-title">Resources</div>
        <ul>
          <li><a href="/blog">Blog</a></li>
          <li><a href="#">Documentation</a></li>
          <li><a href="#">API Reference</a></li>
          <li><a href="/security">Security</a></li>
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
          <li><a href="#">DPA</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span class="footer-legal">&copy; 2026 LRX Enterprises Inc. All rights reserved.</span>
    </div>
  </div>
</footer>

<script>
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  document.getElementById('theme-icon').textContent = next === 'light' ? '\\u2600' : '\\u263E';
  localStorage.setItem('av-theme', next);
}

// Load saved theme
const saved = localStorage.getItem('av-theme');
if (saved) {
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('theme-icon').textContent = saved === 'light' ? '\\u2600' : '\\u263E';
}

// Mobile menu
function toggleMobileMenu() {
  const menu = document.getElementById('mobileMenu');
  if (menu) menu.classList.toggle('open');
}
</script>

</body>
</html>`;
}
