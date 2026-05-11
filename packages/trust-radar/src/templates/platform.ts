/**
 * Averrow — Platform Overview Page
 * Served at /platform
 */
import { wrapPage } from "./shared";
import { generateSpiderTraps } from "../seeders/spider-injector";

export function renderPlatformPage(): string {
  return wrapPage(
    "Platform — Averrow",
    "AI-powered brand protection. Six agents defending your brand across every attack surface. Radar sweep, email security posture, social airspace monitoring, and the full Agent Squadron.",
    `
<style>
/* === FADE-IN === */
.fade-in-up { opacity: 0; transform: translateY(24px); transition: opacity 0.65s ease, transform 0.65s ease; }
.fade-in-up.visible { opacity: 1; transform: translateY(0); }
.fade-in-up.d1 { transition-delay: 0.1s; }
.fade-in-up.d2 { transition-delay: 0.2s; }
.fade-in-up.d3 { transition-delay: 0.3s; }
@media (prefers-reduced-motion: reduce) {
  .fade-in-up { opacity: 1; transform: none; transition: none; }
}

/* === KEYFRAMES === */
@keyframes pulse { 0%,100% { opacity:1; box-shadow:0 0 0 0 rgba(200,60,60,0.4); } 50% { opacity:0.8; box-shadow:0 0 0 6px rgba(200,60,60,0); } }
@keyframes radarRotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes radarBlink { 0%,100% { opacity:1; } 50% { opacity:0.2; } }
@keyframes flowDash { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
@keyframes shimmer { to { left: 120%; } }

/* === HERO === */
.plat-hero { padding: 5rem 0 3rem; text-align: center; background: var(--gradient-hero); position: relative; overflow: hidden; }
.plat-hero h1 { font-family: var(--font-display); font-size: clamp(36px, 5vw, 64px); font-weight: 800; margin-bottom: 1rem; line-height: 1.05; }
.plat-hero h1 .hero-accent { color: var(--amber); }
.plat-hero p { font-size: 18px; color: var(--text-secondary); max-width: 620px; margin: 0 auto 2.25rem; line-height: 1.6; }
.plat-hero-section-label { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--amber); letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 0.85rem; }

/* === SQUADRON STATUS PANEL === */
.squadron-status {
  max-width: 720px;
  margin: 0 auto;
  padding: 1rem 1.25rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--glass-card-bg, rgba(22,30,48,0.55));
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
  text-align: left;
  font-family: var(--font-mono);
}
.squadron-status-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--amber);
  margin-bottom: 12px;
}
.squadron-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #3CB878;
  box-shadow: 0 0 0 0 rgba(60,184,120,0.55);
  animation: squadron-pulse 1.8s ease-out infinite;
}
@keyframes squadron-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(60,184,120,0.55); }
  70%  { box-shadow: 0 0 0 8px rgba(60,184,120,0); }
  100% { box-shadow: 0 0 0 0 rgba(60,184,120,0); }
}
.squadron-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 16px;
  font-size: 12px;
  color: var(--text-secondary);
}
.squadron-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
}
[data-theme="light"] .squadron-row { background: rgba(0,0,0,0.025); }
.squadron-name { color: var(--text-primary); font-weight: 600; letter-spacing: 0.04em; }
.squadron-state { color: #3CB878; font-size: 11px; letter-spacing: 0.06em; }
@media (prefers-reduced-motion: reduce) {
  .squadron-status-dot { animation: none; box-shadow: 0 0 0 4px rgba(60,184,120,0.2); }
}
@media (max-width: 720px) {
  .squadron-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 480px) {
  .squadron-grid { grid-template-columns: 1fr; }
}

/* === CAP NAV === */
.cap-nav { position: sticky; top: 64px; z-index: 50; background: var(--bg-secondary); border-bottom: 1px solid var(--border); padding: 0.6rem 0; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
[data-theme="light"] .cap-nav { background: rgba(248,247,245,0.8); border-bottom-color: rgba(226,221,213,0.5); }
.cap-nav-inner { max-width: 1400px; margin: 0 auto; padding: 0 2rem; display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }
.cap-tab { font-family: var(--font-mono); font-size: 13px; font-weight: 500; padding: 0.5rem 1.25rem; border-radius: 100px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); cursor: pointer; text-decoration: none; transition: all 0.2s; }
.cap-tab:hover, .cap-tab.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }

/* === CAPABILITY SECTIONS — alternating gradient backgrounds === */
.cap-section { padding: 3rem 0; position: relative; }
.cap-section:nth-of-type(odd)  { background: linear-gradient(180deg, var(--bg-primary) 0%, var(--bg-secondary) 100%); }
.cap-section:nth-of-type(even) { background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%); }
.cap-row { max-width: 1400px; margin: 0 auto; padding: 0 2rem; display: grid; grid-template-columns: 1fr 1fr; gap: 2.5rem; align-items: center; }
.cap-row.reversed { direction: rtl; }
.cap-row.reversed > * { direction: ltr; }
.cap-text .section-label { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--accent-section, var(--accent)); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 0.75rem; }
.cap-text h2 { font-family: var(--font-display); font-size: clamp(24px, 3vw, 36px); font-weight: 700; margin-bottom: 1rem; }
.cap-text p { font-size: 16px; color: var(--text-secondary); line-height: 1.7; margin-bottom: 1.5rem; }
.cap-features { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.cap-features li { display: flex; align-items: center; gap: 0.5rem; font-size: 15px; color: var(--text-secondary); }
.cap-features li::before { content: '✓'; color: #28A050; font-weight: 700; }
.cap-features li.alert::before { color: #C83C3C; }
.callout { background: var(--accent-bg); border: 1px solid rgba(200,60,60,0.15); border-radius: var(--radius-md); padding: 1rem 1.25rem; font-size: 0.85rem; color: var(--accent); font-weight: 500; margin-top: 1rem; }

/* === CAP VISUAL — glassmorphism === */
.cap-visual { background: rgba(14,26,43,0.55); border: 1px solid rgba(120,160,200,0.12); border-radius: var(--radius-lg); padding: 1.5rem; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); box-shadow: 0 8px 32px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.04); }
[data-theme="light"] .cap-visual { background: rgba(255,255,255,0.72); border-color: rgba(26,31,46,0.08); box-shadow: 0 8px 32px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.9); }

/* === RADAR SWEEP === */
.radar-container { display: flex; flex-direction: column; align-items: center; gap: 1.25rem; }
.radar-svg-wrap { width: 180px; height: 180px; flex-shrink: 0; }
.radar-sweep-group { transform-origin: 90px 90px; animation: radarRotate 3s linear infinite; }
.radar-dot { animation: radarBlink 2s ease-in-out infinite; }
.radar-dot-2 { animation: radarBlink 2s ease-in-out 0.65s infinite; }
.radar-dot-3 { animation: radarBlink 2s ease-in-out 1.3s infinite; }
.radar-dot-4 { animation: radarBlink 2s ease-in-out 0.3s infinite; }
.feed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; width: 100%; }
.feed-badge { display: flex; align-items: stretch; background: var(--bg-tertiary); border-radius: var(--radius-sm); font-size: 0.78rem; font-weight: 500; overflow: hidden; border: 1px solid var(--border); }
.feed-badge-bar { width: 3px; flex-shrink: 0; }
.feed-badge-text { padding: 0.5rem 0.75rem; }

/* === EMAIL GRADE RING === */
.email-item { display: flex; justify-content: space-between; align-items: center; padding: 0.72rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
.email-item:last-child { border-bottom: none; }
.email-pass { font-family: var(--font-mono); font-size: 0.75rem; color: #28A050; font-weight: 600; }
.email-fail { font-family: var(--font-mono); font-size: 0.75rem; color: #C83C3C; font-weight: 600; }
.email-grade-wrap { display: flex; justify-content: center; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.email-grade-ring { position: relative; width: 96px; height: 96px; }
.email-grade-ring svg { width: 96px; height: 96px; }
.grade-ring-track { fill: none; stroke: rgba(40,160,80,0.12); stroke-width: 6; }
.grade-ring-fill { fill: none; stroke: #28A050; stroke-width: 6; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 48px 48px; stroke-dasharray: 263.9; stroke-dashoffset: 263.9; transition: stroke-dashoffset 1.5s cubic-bezier(0.4,0,0.2,1); filter: drop-shadow(0 0 5px rgba(40,160,80,0.45)); }
.grade-ring-fill.animated { stroke-dashoffset: 13.2; }
.email-grade-inner { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.email-grade-letter { font-family: var(--font-display); font-size: 2rem; font-weight: 800; color: #28A050; line-height: 1; }
.email-grade-sub { font-family: var(--font-mono); font-size: 0.58rem; color: rgba(40,160,80,0.65); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; margin-top: 1px; }

/* === SOCIAL PLATFORM ICONS === */
.social-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; }
.social-item { text-align: center; padding: 1rem 0.75rem; background: var(--bg-tertiary); border-radius: var(--radius-md); border: 1px solid var(--border); transition: all 0.25s; }
.social-item:hover { border-color: rgba(120,160,200,0.25); transform: translateY(-2px); }
.social-icon-wrap { width: 36px; height: 36px; margin: 0 auto 0.5rem; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); background: rgba(120,160,200,0.07); }
.social-icon-wrap svg { width: 18px; height: 18px; }
.social-name { font-family: var(--font-mono); font-size: 0.68rem; font-weight: 600; margin-bottom: 0.3rem; text-transform: uppercase; letter-spacing: 0.05em; }
.social-status { font-family: var(--font-mono); font-size: 0.62rem; display: flex; align-items: center; justify-content: center; gap: 0.3rem; }
.social-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.social-dot.green { background: #28A050; box-shadow: 0 0 4px rgba(40,160,80,0.5); }
.social-dot.amber { background: #E8923C; box-shadow: 0 0 4px rgba(232,146,60,0.4); }
.social-dot.red { background: #C83C3C; box-shadow: 0 0 4px rgba(200,60,60,0.5); animation: pulse 2s infinite; }
.social-dot.grey { background: var(--text-tertiary); }

/* === AGENT CARDS WITH ICONS === */
.agent-grid { display: flex; flex-direction: column; gap: 0; }
.agent-card { margin-bottom: 0.6rem; padding: 0.875rem 1rem 0.875rem 1.25rem; background: rgba(14,26,43,0.45); border-radius: var(--radius-md); border-left: 3px solid transparent; border-top: 1px solid rgba(255,255,255,0.03); border-right: 1px solid rgba(255,255,255,0.03); border-bottom: 1px solid rgba(255,255,255,0.03); display: flex; align-items: flex-start; gap: 0.875rem; transition: all 0.2s; backdrop-filter: blur(8px); }
.agent-card:hover { transform: translateX(3px); background: rgba(14,26,43,0.7); }
[data-theme="light"] .agent-card { background: rgba(255,255,255,0.6); border-top-color: rgba(0,0,0,0.04); border-right-color: rgba(0,0,0,0.04); border-bottom-color: rgba(0,0,0,0.04); }
.agent-icon-wrap { flex-shrink: 0; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); background: rgba(255,255,255,0.04); margin-top: 1px; }
.agent-icon-wrap svg { width: 19px; height: 19px; }
.agent-content { flex: 1; min-width: 0; }
.agent-name { font-family: var(--font-mono); font-size: 16px; font-weight: 700; margin-bottom: 0.15rem; text-transform: uppercase; letter-spacing: 0.06em; }
.agent-role { font-family: var(--font-mono); font-size: 0.65rem; font-weight: 500; margin-bottom: 0.3rem; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.08em; }
.agent-desc { font-size: 0.8rem; color: var(--text-secondary); line-height: 1.45; }
.narrative-block { border-left: 3px solid #C83C3C; padding: 1rem 1.25rem; background: rgba(200,60,60,0.05); border-radius: 0 var(--radius-md) var(--radius-md) 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.6; margin-top: 0.5rem; border-top: 1px solid rgba(200,60,60,0.08); border-right: 1px solid rgba(200,60,60,0.08); border-bottom: 1px solid rgba(200,60,60,0.08); }
.narrative-label { font-family: var(--font-mono); font-size: 0.68rem; font-weight: 600; color: #C83C3C; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.35rem; }
.narrative-dot { width: 6px; height: 6px; background: #C83C3C; border-radius: 50%; animation: pulse 2s infinite; }

/* === ARCHITECTURE SVG FLOW === */
.arch-section { padding: 3rem 0; text-align: center; background: linear-gradient(180deg, var(--bg-primary) 0%, var(--bg-secondary) 100%); }
.arch-svg-wrap { max-width: 1400px; margin: 2.5rem auto 0; padding: 0 2rem; overflow-x: auto; }
.arch-svg-wrap svg { min-width: 580px; width: 100%; }
.arch-box { fill: var(--bg-secondary); stroke: var(--border); stroke-width: 1; }
.arch-box-final { fill: var(--accent-bg); stroke: rgba(200,60,60,0.3); stroke-width: 1.5; }
.arch-label { font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 600; fill: var(--text-primary, #F0EDE8); text-anchor: middle; }
.arch-sub { font-family: 'IBM Plex Mono', monospace; font-size: 9px; fill: var(--text-secondary, #78A0C8); text-anchor: middle; }
.arch-flow-line { stroke: rgba(200,60,60,0.6); stroke-width: 1.5; stroke-dasharray: 8 4; animation: flowDash 1.2s linear infinite; }
.arch-arrow { fill: rgba(200,60,60,0.6); }
.arch-icon { fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

/* === INTEGRATIONS === */
.int-section { padding: 3rem 0; text-align: center; background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%); }
.int-group-label { font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-tertiary); margin: 1.5rem auto 0.75rem; max-width: 1400px; padding: 0 2rem; display: flex; align-items: center; gap: 0.75rem; }
.int-group-label::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, var(--border), transparent); }
.int-grid { max-width: 1400px; margin: 0.5rem auto 0; padding: 0 2rem; display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
.int-card { background: rgba(14,26,43,0.5); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 1.5rem 1.25rem; text-align: center; transition: all 0.3s ease; position: relative; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
[data-theme="light"] .int-card { background: rgba(255,255,255,0.6); border-color: rgba(226,221,213,0.5); box-shadow: 0 4px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.9); }
.int-card:hover { border-color: rgba(200,60,60,0.4); transform: translateY(-5px); box-shadow: 0 0 28px rgba(200,60,60,0.14), 0 8px 24px rgba(0,0,0,0.2); }
.int-card-icon { width: 52px; height: 52px; margin: 0 auto 0.875rem; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-md); transition: transform 0.3s; }
.int-card:hover .int-card-icon { transform: scale(1.1); }
.int-card-icon svg { width: 28px; height: 28px; }
.int-card-icon.live { background: var(--green-bg); color: var(--green); }
.int-card-icon.planned { background: var(--accent-bg); color: var(--accent); }
.int-card-name { font-size: 15px; font-weight: 700; margin-bottom: 0.35rem; }
.int-card-desc { font-size: 0.72rem; color: var(--text-tertiary); line-height: 1.4; margin-bottom: 0.5rem; }
.int-card-status { font-family: var(--font-mono); font-size: 0.62rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; padding: 0.2rem 0.5rem; border-radius: 100px; display: inline-block; }
.int-card-status.live { background: var(--green-bg); color: var(--green); }
.int-card-status.planned { background: var(--accent-bg); color: var(--text-tertiary); }

/* === CTA === */
.cta-block { padding: 3rem 0; text-align: center; }
.cta-block h2 { font-family: var(--font-display); font-size: clamp(28px, 3vw, 36px); font-weight: 700; margin-bottom: 1rem; }
.cta-block p { color: var(--text-secondary); max-width: 480px; margin: 0 auto 2rem; }
.cta-actions { display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }

@media (max-width: 768px) {
  .cap-row, .cap-row.reversed { grid-template-columns: 1fr; gap: 2rem; direction: ltr; }
  .social-grid { grid-template-columns: repeat(2, 1fr); }
  .feed-grid { grid-template-columns: 1fr; }
  .int-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>

<section class="plat-hero">
  <div class="container">
    <div class="plat-hero-section-label">The Platform</div>
    <h1>One platform.<br/><span class="hero-accent">Twenty-seven agents.</span><br/>Zero blind spots.</h1>
    <p>Continuous radar across phishing, domains, email, and social — fused into a single brand exposure picture by an AI agent squadron that reasons about threats, not just lists them.</p>
    <div class="squadron-status" aria-label="Live squadron status">
      <div class="squadron-status-label">
        <span class="squadron-status-dot" aria-hidden="true"></span>
        Squadron Status &mdash; All Systems Operational
      </div>
      <div class="squadron-grid">
        <div class="squadron-row"><span class="squadron-name">Sentinel</span><span class="squadron-state">SCANNING</span></div>
        <div class="squadron-row"><span class="squadron-name">ASTRA</span><span class="squadron-state">SCORING</span></div>
        <div class="squadron-row"><span class="squadron-name">Observer</span><span class="squadron-state">WATCHING</span></div>
        <div class="squadron-row"><span class="squadron-name">Navigator</span><span class="squadron-state">PLOTTING</span></div>
        <div class="squadron-row"><span class="squadron-name">Blackbox</span><span class="squadron-state">RECORDING</span></div>
        <div class="squadron-row"><span class="squadron-name">Pathfinder</span><span class="squadron-state">SEEKING</span></div>
      </div>
    </div>
  </div>
</section>

<div class="cap-nav">
  <div class="cap-nav-inner">
    <a href="#radar-sweep" class="cap-tab active">Radar Sweep</a>
    <a href="#email-posture" class="cap-tab">Email Posture Engine</a>
    <a href="#social-airspace" class="cap-tab">Social Airspace</a>
    <a href="#agent-squadron" class="cap-tab">Agent Squadron</a>
  </div>
</div>

<!-- Capability 1: Radar Sweep -->
<section class="cap-section" id="radar-sweep">
  <div class="cap-row">
    <div class="cap-text fade-in-up">
      <div class="section-label">Capability 01</div>
      <h2>Radar Sweep — Continuous Brand Monitoring</h2>
      <p>Sentinel sweeps phishing databases, malware feeds, CT logs, and DNS intelligence on a 360&deg; loop — surfacing anyone targeting your brand the moment they appear in the open feed network.</p>
      <ul class="cap-features">
        <li>Continuous scanning across all radar feeds</li>
        <li>Parallel feed processing for speed</li>
        <li>Automatic deduplication and false positive filtering</li>
        <li>Safe domains allowlist to reduce noise</li>
        <li>AI-powered threat assessment on detection</li>
      </ul>
    </div>
    <div class="cap-visual fade-in-up d1">
      <div class="radar-container">
        <div class="radar-svg-wrap">
          <svg viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <radialGradient id="radarTrailGrad" cx="50%" cy="50%" r="50%" gradientUnits="objectBoundingBox">
                <stop offset="0%" stop-color="#28A050" stop-opacity="0.35"/>
                <stop offset="70%" stop-color="#28A050" stop-opacity="0.1"/>
                <stop offset="100%" stop-color="#28A050" stop-opacity="0"/>
              </radialGradient>
              <filter id="sweepGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="2" result="blur"/>
                <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>
            <!-- Background -->
            <circle cx="90" cy="90" r="88" fill="rgba(4,8,16,0.75)"/>
            <!-- Concentric rings -->
            <circle cx="90" cy="90" r="22" fill="none" stroke="rgba(120,160,200,0.18)" stroke-width="0.75"/>
            <circle cx="90" cy="90" r="44" fill="none" stroke="rgba(120,160,200,0.14)" stroke-width="0.75"/>
            <circle cx="90" cy="90" r="66" fill="none" stroke="rgba(120,160,200,0.10)" stroke-width="0.75"/>
            <circle cx="90" cy="90" r="87" fill="none" stroke="rgba(120,160,200,0.08)" stroke-width="1"/>
            <!-- Crosshairs -->
            <line x1="3" y1="90" x2="177" y2="90" stroke="rgba(120,160,200,0.07)" stroke-width="0.5"/>
            <line x1="90" y1="3" x2="90" y2="177" stroke="rgba(120,160,200,0.07)" stroke-width="0.5"/>
            <!-- Rotating sweep group: trail sector + arm -->
            <g class="radar-sweep-group">
              <path d="M 90 90 L 90 4 A 86 86 0 0 0 15.5 47 Z" fill="url(#radarTrailGrad)"/>
              <line x1="90" y1="90" x2="90" y2="4" stroke="#28A050" stroke-width="3" opacity="0.12"/>
              <line x1="90" y1="90" x2="90" y2="4" stroke="#28A050" stroke-width="1.5" opacity="0.95" filter="url(#sweepGlow)"/>
            </g>
            <!-- Contact dots -->
            <circle cx="118" cy="52" r="3.5" fill="#C83C3C" class="radar-dot"/>
            <circle cx="50" cy="120" r="3"   fill="#E8923C" class="radar-dot-2"/>
            <circle cx="133" cy="110" r="3"  fill="#DCAA32" class="radar-dot-3"/>
            <circle cx="68" cy="44" r="2.5"  fill="#78A0C8" class="radar-dot-4"/>
            <!-- Center -->
            <circle cx="90" cy="90" r="3" fill="#28A050" opacity="0.9"/>
            <circle cx="90" cy="90" r="7" fill="none" stroke="#28A050" stroke-width="0.75" opacity="0.3"/>
          </svg>
        </div>
        <div class="feed-grid">
          <div class="feed-badge"><span class="feed-badge-bar" style="background:#C83C3C"></span><span class="feed-badge-text">Phishing databases</span></div>
          <div class="feed-badge"><span class="feed-badge-bar" style="background:#E8923C"></span><span class="feed-badge-text">Malware URL feeds</span></div>
          <div class="feed-badge"><span class="feed-badge-bar" style="background:#DCAA32"></span><span class="feed-badge-text">Threat intel feeds</span></div>
          <div class="feed-badge"><span class="feed-badge-bar" style="background:#78A0C8"></span><span class="feed-badge-text">CT logs</span></div>
          <div class="feed-badge"><span class="feed-badge-bar" style="background:#28A050"></span><span class="feed-badge-text">DNS intelligence</span></div>
          <div class="feed-badge"><span class="feed-badge-bar" style="background:#C83C3C"></span><span class="feed-badge-text">Breach intel</span></div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Capability 2: Email Security Posture Engine -->
<section class="cap-section" id="email-posture">
  <div class="cap-row reversed">
    <div class="cap-text fade-in-up">
      <div class="section-label">Capability 02</div>
      <h2>Email Security Posture Engine</h2>
      <p>Most companies don't know their email can be spoofed. Averrow grades your SPF, DKIM, DMARC, and MX configuration on an A+ through F scale — and tells you exactly which gap an attacker would exploit first.</p>
      <ul class="cap-features">
        <li>SPF record validation</li>
        <li>DKIM multi-selector verification (12+ enterprise selectors)</li>
        <li>DMARC policy assessment</li>
        <li>MX provider detection and scoring</li>
        <li>A+ through F grading methodology</li>
      </ul>
      <div class="callout">Designed for AI-powered threats that exploit email authentication gaps.</div>
    </div>
    <div class="cap-visual fade-in-up d1" id="email-posture-visual">
      <div class="email-item"><span>SPF Record</span><span class="email-pass">PASS ✓</span></div>
      <div class="email-item"><span>DKIM (google)</span><span class="email-pass">PASS ✓</span></div>
      <div class="email-item"><span>DKIM (proofpoint)</span><span class="email-pass">PASS ✓</span></div>
      <div class="email-item"><span>DMARC Policy</span><span class="email-pass">reject ✓</span></div>
      <div class="email-item" style="border-bottom:none;"><span>MX Provider</span><span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text-secondary);">Google Workspace</span></div>
      <div class="email-grade-wrap">
        <div class="email-grade-ring">
          <svg viewBox="0 0 96 96">
            <circle class="grade-ring-track" cx="48" cy="48" r="42"/>
            <circle class="grade-ring-fill" cx="48" cy="48" r="42"/>
          </svg>
          <div class="email-grade-inner">
            <div class="email-grade-letter">A+</div>
            <div class="email-grade-sub">Grade</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Capability 3: Social Airspace Monitoring -->
<section class="cap-section" id="social-airspace">
  <div class="cap-row">
    <div class="cap-text fade-in-up">
      <div class="section-label">Capability 03</div>
      <h2>Social Airspace Monitoring</h2>
      <p>Impersonation on social is the fastest-growing attack vector. Averrow monitors six platforms for fake accounts, handle squatting, and unauthorized brand usage &mdash; with AI confidence scoring so you only see what actually warrants a takedown.</p>
      <ul class="cap-features">
        <li>AI-powered profile assessment (confidence scoring)</li>
        <li>Auto-discovery of brand accounts from company websites</li>
        <li>Cross-correlation with threat intelligence feeds</li>
        <li>Manual classification and takedown evidence generation</li>
        <li>Handle permutation generation and monitoring</li>
        <li>Executive name monitoring across platforms</li>
      </ul>
    </div>
    <div class="cap-visual fade-in-up d1">
      <div style="font-family:var(--font-mono);font-size:0.7rem;font-weight:600;color:var(--text-tertiary);margin-bottom:1rem;text-transform:uppercase;letter-spacing:0.1em;">Airspace Status</div>
      <div class="social-grid">

        <div class="social-item">
          <div class="social-icon-wrap">
            <!-- X / Twitter -->
            <svg viewBox="0 0 24 24" fill="currentColor" style="color:#78A0C8"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.631L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </div>
          <div class="social-name">Twitter/X</div>
          <div class="social-status"><span class="social-dot green"></span>Verified</div>
        </div>

        <div class="social-item">
          <div class="social-icon-wrap">
            <!-- LinkedIn -->
            <svg viewBox="0 0 24 24" fill="currentColor" style="color:#78A0C8"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
          </div>
          <div class="social-name">LinkedIn</div>
          <div class="social-status"><span class="social-dot green"></span>Verified</div>
        </div>

        <div class="social-item">
          <div class="social-icon-wrap">
            <!-- Instagram -->
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:#E8923C"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="0.75" fill="currentColor" stroke="none"/></svg>
          </div>
          <div class="social-name">Instagram</div>
          <div class="social-status"><span class="social-dot amber"></span>Unclaimed</div>
        </div>

        <div class="social-item">
          <div class="social-icon-wrap">
            <!-- TikTok -->
            <svg viewBox="0 0 24 24" fill="currentColor" style="color:#78A0C8;opacity:0.5"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.34 6.34 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.18 8.18 0 004.78 1.52V6.73a4.85 4.85 0 01-1.01-.04z"/></svg>
          </div>
          <div class="social-name">TikTok</div>
          <div class="social-status"><span class="social-dot grey"></span>N/A</div>
        </div>

        <div class="social-item">
          <div class="social-icon-wrap">
            <!-- GitHub -->
            <svg viewBox="0 0 24 24" fill="currentColor" style="color:#78A0C8"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>
          </div>
          <div class="social-name">GitHub</div>
          <div class="social-status"><span class="social-dot green"></span>Verified</div>
        </div>

        <div class="social-item">
          <div class="social-icon-wrap">
            <!-- YouTube -->
            <svg viewBox="0 0 24 24" fill="currentColor" style="color:#C83C3C"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
          </div>
          <div class="social-name">YouTube</div>
          <div class="social-status"><span class="social-dot red"></span>Squatted</div>
        </div>

      </div>
    </div>
  </div>
</section>

<!-- Capability 4: Agent Squadron -->
<section class="cap-section" id="agent-squadron">
  <div class="cap-row reversed">
    <div class="cap-text fade-in-up">
      <div class="section-label">Capability 04</div>
      <h2>Agent Squadron</h2>
      <p>Six core agents don't just detect threats &mdash; they reason about them. They cross-reference signals across email, domains, social, and radar feeds to produce a single Brand Exposure Score and natural-language briefings your team can act on.</p>
      <ul class="cap-features">
        <li>Cross-system signal fusion (email + social + threats + domains)</li>
        <li>Social intelligence correlation in risk scoring</li>
        <li>Composite Brand Exposure Score</li>
        <li>Natural language intercept reports</li>
        <li>Automated takedown evidence generation</li>
        <li>Daily intelligence briefings from Observer</li>
      </ul>
    </div>
    <div class="cap-visual fade-in-up d1">
      <div class="agent-grid">

        <div class="agent-card" style="border-left-color:#C83C3C;">
          <div class="agent-icon-wrap">
            <!-- Sentinel: radar rings + sweep arm -->
            <svg viewBox="0 0 24 24" fill="none" stroke="#C83C3C" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="2.5" stroke-width="1.5"/>
              <circle cx="12" cy="12" r="6" stroke-width="1" opacity="0.55"/>
              <circle cx="12" cy="12" r="10" stroke-width="0.75" opacity="0.3"/>
              <line x1="12" y1="12" x2="12" y2="2" stroke-width="1.5" opacity="0.85"/>
              <circle cx="16" cy="6" r="1" fill="#C83C3C" stroke="none" opacity="0.8"/>
            </svg>
          </div>
          <div class="agent-content">
            <div class="agent-name" style="color:#C83C3C;">Sentinel</div>
            <div class="agent-role" style="color:#C83C3C;">Threat Detection</div>
            <div class="agent-desc">Continuous radar sweep across all feeds. The first to detect contacts crossing into airspace.</div>
          </div>
        </div>

        <div class="agent-card" style="border-left-color:#E8923C;">
          <div class="agent-icon-wrap">
            <!-- ASTRA: targeting diamond + crosshair -->
            <svg viewBox="0 0 24 24" fill="none" stroke="#E8923C" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12,2 22,12 12,22 2,12" stroke-width="1.5"/>
              <line x1="12" y1="2" x2="12" y2="22" stroke-width="0.75" opacity="0.45"/>
              <line x1="2" y1="12" x2="22" y2="12" stroke-width="0.75" opacity="0.45"/>
              <circle cx="12" cy="12" r="2" fill="#E8923C" stroke="none"/>
            </svg>
          </div>
          <div class="agent-content">
            <div class="agent-name" style="color:#E8923C;">ASTRA</div>
            <div class="agent-role" style="color:#E8923C;">Fire Control</div>
            <div class="agent-desc">Classifies, scores, and prioritizes threat severity. Named after the Arrow's fire control system.</div>
          </div>
        </div>

        <div class="agent-card" style="border-left-color:#78A0C8;">
          <div class="agent-icon-wrap">
            <!-- Observer: stylized eye with iris -->
            <svg viewBox="0 0 24 24" fill="none" stroke="#78A0C8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke-width="1.5"/>
              <circle cx="12" cy="12" r="3.5" stroke-width="1.25"/>
              <circle cx="12" cy="12" r="1.5" fill="#78A0C8" stroke="none"/>
            </svg>
          </div>
          <div class="agent-content">
            <div class="agent-name" style="color:#78A0C8;">Observer</div>
            <div class="agent-role" style="color:#78A0C8;">Strategic Intel</div>
            <div class="agent-desc">The eye in the sky. Daily briefings, macro trend analysis, and weekly summaries.</div>
          </div>
        </div>

        <div class="agent-card" style="border-left-color:#5A80A8;">
          <div class="agent-icon-wrap">
            <!-- Navigator: globe wireframe + pin -->
            <svg viewBox="0 0 24 24" fill="none" stroke="#5A80A8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" stroke-width="1.5"/>
              <ellipse cx="12" cy="12" rx="4" ry="10" stroke-width="1" opacity="0.6"/>
              <line x1="2" y1="12" x2="22" y2="12" stroke-width="0.75" opacity="0.5"/>
              <circle cx="12" cy="7" r="1.75" fill="#5A80A8" stroke="none"/>
              <line x1="12" y1="8.75" x2="12" y2="11.5" stroke-width="1.5"/>
            </svg>
          </div>
          <div class="agent-content">
            <div class="agent-name" style="color:#5A80A8;">Navigator</div>
            <div class="agent-role" style="color:#5A80A8;">Geo Mapping</div>
            <div class="agent-desc">Plots threat origins, enriches IP infrastructure, maps attack geography.</div>
          </div>
        </div>

        <div class="agent-card" style="border-left-color:#8A8F9C;">
          <div class="agent-icon-wrap">
            <!-- Blackbox: recorder with EKG waveform + REC dot -->
            <svg viewBox="0 0 24 24" fill="none" stroke="#8A8F9C" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" stroke-width="1.5"/>
              <polyline points="5,12 7,9 9,15 11.5,10 14,12 16,12 18,12" stroke="#C83C3C" stroke-width="1.25" fill="none"/>
              <circle cx="19" cy="6.5" r="1.25" fill="#C83C3C" stroke="none"/>
            </svg>
          </div>
          <div class="agent-content">
            <div class="agent-name" style="color:#8A8F9C;">Blackbox</div>
            <div class="agent-role" style="color:#8A8F9C;">Flight Recorder</div>
            <div class="agent-desc">Captures threat event history and timelines as narrative. The record that never lies.</div>
          </div>
        </div>

        <div class="agent-card" style="border-left-color:#28A050;margin-bottom:0.5rem;">
          <div class="agent-icon-wrap">
            <!-- Pathfinder: delta path + waypoints -->
            <svg viewBox="0 0 24 24" fill="none" stroke="#28A050" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12,2 21,19 3,19" stroke-width="1.5"/>
              <circle cx="12" cy="2" r="1.75" fill="#28A050" stroke="none"/>
              <circle cx="21" cy="19" r="1.5" fill="#28A050" stroke="none" opacity="0.6"/>
              <circle cx="3" cy="19" r="1.5" fill="#28A050" stroke="none" opacity="0.6"/>
              <circle cx="12" cy="12" r="2" stroke-width="1" fill="none"/>
            </svg>
          </div>
          <div class="agent-content">
            <div class="agent-name" style="color:#28A050;">Pathfinder</div>
            <div class="agent-role" style="color:#28A050;">Target Acquisition</div>
            <div class="agent-desc">Identifies high-value prospects from platform data and generates personalized outreach.</div>
          </div>
        </div>

      </div>
      <div class="narrative-block">
        <div class="narrative-label"><span class="narrative-dot"></span> Blackbox — Flight Recorder</div>
        "A phishing domain matching your brand was registered 48 hours ago with active MX records, combined with your current DKIM gap on the proofpoint selector. This creates a HIGH-severity compound risk — attackers can send spoofed emails that pass basic checks."
      </div>
    </div>
  </div>
</section>

<!-- Architecture -->
<section class="arch-section">
  <div class="container">
    <div class="section-label" style="text-align:center;">Architecture</div>
    <h2 class="fade-in-up" style="font-family:var(--font-display);font-size:2rem;font-weight:700;margin-bottom:0.5rem;">How Data Flows Through Averrow</h2>
    <p class="fade-in-up d1" style="color:var(--text-secondary);margin-bottom:0;">From ingestion to intelligence in minutes.</p>
  </div>
  <div class="arch-svg-wrap fade-in-up d2">
    <svg viewBox="0 0 800 110" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="boxGlow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>

      <!-- Box 1: Radar Feeds -->
      <rect x="10" y="15" width="165" height="78" rx="8" class="arch-box"/>
      <!-- Signal icon -->
      <g transform="translate(84,34)" stroke="#C83C3C" fill="none" stroke-linecap="round" class="arch-icon">
        <path d="M-8,-6 A10,10 0 0,1 8,-6" stroke-width="1.75"/>
        <path d="M-12,-10 A16,16 0 0,1 12,-10" stroke-width="1.25" opacity="0.55"/>
        <circle cx="0" cy="0" r="2.5" fill="#C83C3C" stroke="none"/>
      </g>
      <text x="92" y="70" class="arch-label">Radar Feeds</text>
      <text x="92" y="83" class="arch-sub">Continuous ingestion</text>

      <!-- Connector 1 -->
      <line x1="175" y1="54" x2="213" y2="54" class="arch-flow-line"/>
      <polygon points="213,50 222,54 213,58" class="arch-arrow"/>

      <!-- Box 2: Scanners -->
      <rect x="222" y="15" width="165" height="78" rx="8" class="arch-box"/>
      <!-- Crosshair icon -->
      <g transform="translate(305,34)" stroke="#E8923C" fill="none" stroke-linecap="round" class="arch-icon">
        <circle cx="0" cy="0" r="7" stroke-width="1.5"/>
        <circle cx="0" cy="0" r="3" stroke-width="1.25"/>
        <line x1="0" y1="-10" x2="0" y2="-8" stroke-width="1.5"/>
        <line x1="0" y1="8" x2="0" y2="10" stroke-width="1.5"/>
        <line x1="-10" y1="0" x2="-8" y2="0" stroke-width="1.5"/>
        <line x1="8" y1="0" x2="10" y2="0" stroke-width="1.5"/>
      </g>
      <text x="305" y="70" class="arch-label">Scanners</text>
      <text x="305" y="83" class="arch-sub">Parallel processing</text>

      <!-- Connector 2 -->
      <line x1="387" y1="54" x2="425" y2="54" class="arch-flow-line"/>
      <polygon points="425,50 434,54 425,58" class="arch-arrow"/>

      <!-- Box 3: Agent Squadron -->
      <rect x="434" y="15" width="165" height="78" rx="8" class="arch-box"/>
      <!-- Six-dot formation icon -->
      <g transform="translate(517,34)" fill="#78A0C8">
        <circle cx="-7" cy="-4" r="2.5"/>
        <circle cx="0"  cy="-4" r="2.5"/>
        <circle cx="7"  cy="-4" r="2.5"/>
        <circle cx="-7" cy="4"  r="2.5" opacity="0.6"/>
        <circle cx="0"  cy="4"  r="2.5" opacity="0.6"/>
        <circle cx="7"  cy="4"  r="2.5" opacity="0.6"/>
      </g>
      <text x="517" y="70" class="arch-label">Agent Squadron</text>
      <text x="517" y="83" class="arch-sub">AI reasoning layer</text>

      <!-- Connector 3 -->
      <line x1="599" y1="54" x2="637" y2="54" class="arch-flow-line"/>
      <polygon points="637,50 646,54 637,58" class="arch-arrow"/>

      <!-- Box 4: Observatory (highlighted) -->
      <rect x="646" y="15" width="148" height="78" rx="8" class="arch-box-final" filter="url(#boxGlow)"/>
      <!-- Eye icon -->
      <g transform="translate(720,34)" stroke="#C83C3C" fill="none" stroke-linecap="round" class="arch-icon">
        <path d="M-9,0 C-6,-6 6,-6 9,0 C6,6 -6,6 -9,0Z" stroke-width="1.5"/>
        <circle cx="0" cy="0" r="3" stroke-width="1.25"/>
        <circle cx="0" cy="0" r="1.25" fill="#C83C3C" stroke="none"/>
      </g>
      <text x="720" y="70" class="arch-label" style="fill:#C83C3C">Observatory</text>
      <text x="720" y="83" class="arch-sub">Intelligence output</text>
    </svg>
  </div>
</section>

<!-- Integrations -->
<section class="int-section">
  <div class="container">
    <div class="section-label" style="text-align:center;">Integrations</div>
    <h2 style="font-family:var(--font-display);font-size:2rem;font-weight:700;margin-bottom:0.5rem;">Works With Your Existing Stack</h2>
    <p style="color:var(--text-secondary);margin-bottom:0;">Export data and receive alerts in the tools you already use.</p>
  </div>

  <div class="int-group-label">Live Today</div>
  <div class="int-grid">
    <div class="int-card fade-in-up">
      <div class="int-card-icon live"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>
      <div class="int-card-name">STIX/TAXII</div>
      <div class="int-card-desc">Standard threat intelligence export</div>
      <span class="int-card-status live">Live</span>
    </div>
    <div class="int-card fade-in-up d1">
      <div class="int-card-icon live"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>
      <div class="int-card-name">REST API</div>
      <div class="int-card-desc">Full programmatic access</div>
      <span class="int-card-status live">Live</span>
    </div>
    <div class="int-card fade-in-up d2">
      <div class="int-card-icon live"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></div>
      <div class="int-card-name">Webhooks</div>
      <div class="int-card-desc">Real-time event notifications</div>
      <span class="int-card-status live">Live</span>
    </div>
    <div class="int-card fade-in-up d3">
      <div class="int-card-icon live"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div>
      <div class="int-card-name">Email</div>
      <div class="int-card-desc">Alert delivery and digests</div>
      <span class="int-card-status live">Live</span>
    </div>
  </div>

  <div class="int-group-label">On the Roadmap</div>
  <div class="int-grid">
    <div class="int-card fade-in-up">
      <div class="int-card-icon planned"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg></div>
      <div class="int-card-name">Slack</div>
      <div class="int-card-desc">Team alert channels</div>
      <span class="int-card-status planned">Coming Soon</span>
    </div>
    <div class="int-card fade-in-up d1">
      <div class="int-card-icon planned"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg></div>
      <div class="int-card-name">Splunk</div>
      <div class="int-card-desc">SIEM data integration</div>
      <span class="int-card-status planned">Coming Soon</span>
    </div>
    <div class="int-card fade-in-up d2">
      <div class="int-card-icon planned"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><line x1="2" y1="12" x2="22" y2="12"/></svg></div>
      <div class="int-card-name">QRadar</div>
      <div class="int-card-desc">Security analytics feed</div>
      <span class="int-card-status planned">Coming Soon</span>
    </div>
    <div class="int-card fade-in-up d3">
      <div class="int-card-icon planned"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 12 15 16 10"/></svg></div>
      <div class="int-card-name">Microsoft Sentinel</div>
      <div class="int-card-desc">Cloud SIEM integration</div>
      <span class="int-card-status planned">Coming Soon</span>
    </div>
  </div>
</section>

<!-- CTA -->
<section class="cta-block">
  <div class="container">
    <h2>See what's already targeting your brand.</h2>
    <p>Run a free exposure scan in under five minutes &mdash; no signup, no credit card.</p>
    <div class="cta-actions">
      <a href="/scan" class="btn btn-primary btn-lg">Launch Free Scan</a>
      <a href="/pricing" class="btn btn-outline btn-lg">See Pricing</a>
    </div>
  </div>
</section>
<script>
(function() {
  // Fade-in on scroll
  var fadeEls = document.querySelectorAll('.fade-in-up');
  var fadeObs = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) { e.target.classList.add('visible'); fadeObs.unobserve(e.target); }
    });
  }, { threshold: 0.12 });
  fadeEls.forEach(function(el) { fadeObs.observe(el); });

  // Email grade ring — animate on scroll into view
  var emailVisual = document.getElementById('email-posture-visual');
  if (emailVisual) {
    var ringObs = new IntersectionObserver(function(entries) {
      entries.forEach(function(e) {
        if (e.isIntersecting) {
          var fill = e.target.querySelector('.grade-ring-fill');
          if (fill) { setTimeout(function() { fill.classList.add('animated'); }, 200); }
          ringObs.unobserve(e.target);
        }
      });
    }, { threshold: 0.4 });
    ringObs.observe(emailVisual);
  }

  // Cap-nav active tab on scroll
  var sections = ['radar-sweep','email-posture','social-airspace','agent-squadron'];
  var tabs = document.querySelectorAll('.cap-tab');
  var secObs = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) {
        tabs.forEach(function(t) { t.classList.remove('active'); });
        var active = document.querySelector('.cap-tab[href="#' + e.target.id + '"]');
        if (active) active.classList.add('active');
      }
    });
  }, { threshold: 0.4 });
  sections.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) secObs.observe(el);
  });
})();
</script>
${generateSpiderTraps("averrow.com", "platform")}
`
  );
}
