import { generateSpiderTraps } from "../seeders/spider-injector";
import { wrapPage } from "./shared";
import type { PublicStats } from "../lib/public-stats";

// Static fallback so callers that don't pass stats (legacy, tests) still
// render without crashing. Production calls pass dynamic numbers from
// lib/public-stats.ts (KV-cached).
const STATIC_STATS: PublicStats = {
  agents_deployed: "18",
  feeds_protecting: "33+",
  threats_detected: "210K+",
  brands_monitored: "9.6K+",
  uptime_label: "24/7",
  detection_time_label: "<5min",
};

export function renderHomepage(stats: PublicStats = STATIC_STATS): string {
  const spiderTraps = generateSpiderTraps("averrow.com", "scan");

  const pageStyles = `
<style>
/* ═══════════════════════════════════════════════════════════
   HOMEPAGE — Phase 2A
   ═══════════════════════════════════════════════════════════ */

/* ── HERO ── */
.hero {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 5rem 2rem 2.5rem;
  position: relative;
  overflow: hidden;
}

.hero-bg {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 50% 30%, rgba(200, 60, 60, 0.04) 0%, transparent 70%);
  pointer-events: none;
}

.hero-content {
  position: relative;
  z-index: 2;
  max-width: 720px;
}

.hero-tag {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3em;
  color: var(--accent-section, var(--accent));
  margin-bottom: 16px;
  text-transform: uppercase;
}

.hero-h1 {
  font-family: var(--font-display);
  font-size: clamp(36px, 5vw, 64px);
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: -0.03em;
  margin-bottom: 20px;
  color: var(--text-primary);
}

.hero-p {
  font-size: 20px;
  color: var(--text-secondary);
  line-height: 1.65;
  max-width: 580px;
  margin: 0 auto 28px;
}

/* ── HERO INTERCEPT TICKER ── */
.hero-ticker {
  max-width: 560px;
  margin: 0 auto 28px;
  padding: 14px 18px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--glass-card-bg, rgba(22,30,48,0.55));
  backdrop-filter: blur(12px) saturate(160%);
  text-align: left;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
}
.hero-ticker-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--amber);
  margin-bottom: 10px;
}
.hero-ticker-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--amber);
  box-shadow: 0 0 0 0 rgba(229,168,50,0.6);
  animation: ticker-pulse 1.8s ease-out infinite;
}
@keyframes ticker-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(229,168,50,0.55); }
  70%  { box-shadow: 0 0 0 8px rgba(229,168,50,0); }
  100% { box-shadow: 0 0 0 0 rgba(229,168,50,0); }
}
.hero-ticker-viewport {
  height: 84px;
  overflow: hidden;
  position: relative;
  mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
}
.hero-ticker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  animation: ticker-scroll 18s linear infinite;
}
.hero-ticker-list li {
  display: grid;
  grid-template-columns: 80px 56px 1fr auto;
  align-items: center;
  gap: 12px;
  height: 28px;
  white-space: nowrap;
}
.ti-time     { color: var(--text-tertiary); font-size: 11px; }
.ti-sev      { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-align: center; padding: 2px 0; border-radius: 3px; }
.ti-critical { color: var(--sev-critical); background: rgba(248,113,113,0.10); }
.ti-high     { color: var(--sev-high);     background: rgba(251,146,60,0.10); }
.ti-medium   { color: var(--sev-medium);   background: rgba(251,191,36,0.10); }
.ti-target   { color: var(--text-primary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
.ti-tag      { color: var(--text-secondary); font-size: 11px; }
@keyframes ticker-scroll {
  0%   { transform: translateY(0); }
  100% { transform: translateY(-168px); } /* 6 rows × 28px */
}
@media (prefers-reduced-motion: reduce) {
  .hero-ticker-list { animation: none; }
  .hero-ticker-dot  { animation: none; box-shadow: 0 0 0 4px rgba(229,168,50,0.20); }
}
@media (max-width: 560px) {
  .hero-ticker { font-size: 12px; padding: 12px 14px; }
  .hero-ticker-list li { grid-template-columns: 64px 48px 1fr; }
  .hero-ticker-list li .ti-tag { display: none; }
}
.scan-hint-emphasis {
  color: var(--text-tertiary);
  font-style: italic;
}

/* ── SCAN INPUT ── */
.scan-box {
  display: flex;
  gap: 0;
  max-width: 520px;
  margin: 0 auto;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  background: var(--bg-secondary);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.scan-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 30px rgba(200, 60, 60, 0.1);
}

.scan-input {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 16px;
  padding: 14px 18px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  outline: none;
  letter-spacing: 0.02em;
}

.scan-input::placeholder {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.scan-btn {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.08em;
  padding: 14px 28px;
  border: none;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  transition: all 0.2s;
  text-transform: uppercase;
  position: relative;
  overflow: hidden;
}

.scan-btn::after {
  content: '';
  position: absolute;
  top: 0; left: -100%; width: 60%; height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent);
  transition: none;
}

.scan-btn:hover::after {
  animation: shimmer 0.6s forwards;
}

@keyframes shimmer {
  to { left: 120%; }
}

.scan-btn:hover {
  background: var(--accent-hover);
  box-shadow: 0 0 20px rgba(200, 60, 60, 0.35);
}

.scan-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.scan-hint {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-tertiary);
  margin-top: 12px;
  letter-spacing: 0.04em;
}

/* ── RESULTS ── */
#results-section {
  display: none;
  padding: 5rem 2rem;
  text-align: center;
}

#results-section.visible {
  display: block;
}

.result-card {
  max-width: 600px;
  margin: 0 auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 36px;
  position: relative;
}

.result-domain {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 20px;
}

.score-ring {
  width: 140px;
  height: 140px;
  margin: 0 auto 16px;
  position: relative;
}

.score-ring svg {
  width: 140px;
  height: 140px;
}

.score-val {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 42px;
}

.score-grade {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 8px;
}

.score-summary {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 400px;
  margin: 0 auto 20px;
}

.risk-pills {
  display: flex;
  gap: 6px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 24px;
}

.risk-p {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.risk-p.bad {
  background: rgba(200, 60, 60, 0.1);
  color: var(--accent);
}

.risk-p.warn {
  background: rgba(232, 146, 60, 0.1);
  color: var(--amber);
}

.risk-p.ok {
  background: rgba(40, 160, 80, 0.1);
  color: var(--green);
}

.gate-divider {
  border-top: 1px solid var(--border);
  margin: 24px 0;
  padding-top: 20px;
}

.gate-title {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 4px;
}

.gate-sub {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 16px;
}

.gate-form {
  display: flex;
  gap: 8px;
  max-width: 400px;
  margin: 0 auto;
}

.gate-input {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.2s;
}

.gate-input:focus {
  border-color: var(--accent);
}

.gate-input::placeholder {
  color: var(--text-tertiary);
}

.gate-btn {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 10px 20px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}

.gate-btn:hover {
  background: var(--accent-hover);
}

.gate-note {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-tertiary);
  margin-top: 8px;
}

.gate-error {
  color: var(--accent);
}

/* ── SCANNING ANIMATION ── */
.scanning {
  text-align: center;
  padding: 60px;
}

.scan-ring-anim {
  width: 100px;
  height: 100px;
  margin: 0 auto 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.scan-label {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.scan-detail {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-tertiary);
  margin-top: 6px;
}

/* ── AGENT SQUADRON ── */
.squadron {
  padding: 3rem 2rem;
  max-width: 1400px;
  margin: 0 auto;
}

.section-label {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: var(--accent-section, var(--accent));
  text-transform: uppercase;
  margin-bottom: 10px;
}

.squadron-title {
  font-family: var(--font-display);
  font-size: clamp(24px, 3vw, 36px);
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.squadron-subtitle {
  font-size: 16px;
  color: var(--text-secondary);
  margin-bottom: 20px;
  line-height: 1.7;
}

.agent-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

@media (max-width: 720px) {
  .agent-grid {
    grid-template-columns: 1fr;
  }
}

.agent-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px 20px 20px 24px;
  border-left: 3px solid var(--agent-color, var(--border));
  transition: transform 0.2s, box-shadow 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}

.agent-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
}

.agent-name {
  font-family: var(--font-mono);
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.agent-role {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.agent-desc {
  font-size: 15px;
  color: var(--text-secondary);
  line-height: 1.5;
}

/* ── HOW IT WORKS ── */
.how-it-works {
  padding: 3rem 2rem;
  max-width: 1400px;
  margin: 0 auto;
}

.steps-row {
  display: flex;
  align-items: flex-start;
  gap: 0;
  margin-top: 20px;
}

@media (max-width: 720px) {
  .steps-row {
    flex-direction: column;
    gap: 32px;
  }
  .step-arrow {
    display: none;
  }
}

.step {
  flex: 1;
  text-align: center;
}

.step-num {
  font-family: var(--font-display);
  font-size: 40px;
  font-weight: 700;
  color: var(--accent);
  line-height: 1;
  margin-bottom: 10px;
}

.step-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;

  color: var(--text-primary);
  margin-bottom: 6px;
}

.step-desc {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
  max-width: 220px;
  margin: 0 auto;
}

.step-arrow {
  display: flex;
  align-items: center;
  padding-top: 12px;
  color: var(--text-tertiary);
  font-size: 24px;
  flex-shrink: 0;
  width: 40px;
  justify-content: center;
}

/* ── CAPABILITIES ── */
.capabilities {
  padding: 3rem 2rem;
  max-width: 1400px;
  margin: 0 auto;
}

.capabilities-title {
  font-family: var(--font-display);
  font-size: clamp(24px, 3vw, 36px);
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.capabilities-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-top: 20px;
}

@media (max-width: 960px) and (min-width: 721px) {
  .capabilities-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 720px) {
  .capabilities-grid {
    grid-template-columns: 1fr;
  }
}

.cap-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 24px;
  transition: transform 0.2s, box-shadow 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}

.cap-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
}

.cap-icon {
  width: 32px;
  height: 32px;
  margin-bottom: 14px;
  color: var(--accent);
  display: block;
}

.cap-title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.cap-desc {
  font-size: 15px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 16px;
}

/* ── CAPABILITY PRODUCT MOCKS ──
   Stylized UI snippets, not real screenshots. Synthetic data only. */
.cap-mock {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-tertiary);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}
.cap-mock-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 4px 0;
  align-items: center;
}
.cap-mock-row + .cap-mock-row { border-top: 1px solid var(--border); }
.cap-mock-target { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cap-mock-badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 2px 6px;
  border-radius: 3px;
}
.cap-mock-badge.crit { color: var(--sev-critical); background: rgba(248,113,113,0.10); }
.cap-mock-badge.high { color: var(--sev-high);     background: rgba(251,146,60,0.10); }
.cap-mock-badge.med  { color: var(--sev-medium);   background: rgba(251,191,36,0.10); }
.cap-mock-badge.ok   { color: var(--green);        background: rgba(60,184,120,0.10); }
.cap-mock-grade {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  text-align: center;
}
.cap-mock-grade-cell {
  padding: 8px 4px;
  border-radius: 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
}
.cap-mock-grade-cell .gl-label { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-tertiary); }
.cap-mock-grade-cell .gl-value { font-family: var(--font-display); font-size: 22px; font-weight: 700; line-height: 1; }
.gl-value.pass { color: var(--green); }
.gl-value.fail { color: var(--sev-critical); }
.cap-mock-diff {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cap-mock-diff-line { display: flex; gap: 8px; align-items: center; }
.cap-mock-diff-label { width: 56px; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-tertiary); }
.cap-mock-diff-value { color: var(--text-primary); }
.cap-mock-diff-value .hi { color: var(--sev-high); background: rgba(251,146,60,0.16); padding: 1px 2px; border-radius: 2px; }
.cap-mock-narrative {
  font-family: var(--font-body);
  font-size: 12.5px;
  color: var(--text-primary);
  border-left: 2px solid var(--amber);
  padding-left: 10px;
  line-height: 1.55;
}
.cap-mock-narrative .nm-meta { color: var(--text-tertiary); font-size: 11px; margin-top: 6px; }
.cap-mock-social {
  display: flex;
  gap: 10px;
  align-items: center;
}
.cap-mock-social-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--red), var(--amber));
  flex-shrink: 0;
  font-family: var(--font-display);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
  font-size: 13px;
}
.cap-mock-social-info { flex: 1; min-width: 0; }
.cap-mock-social-handle { color: var(--text-primary); font-size: 12px; }
.cap-mock-social-meta { color: var(--text-tertiary); font-size: 10.5px; }
.cap-mock-score {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--sev-critical);
}

/* ── CTA ── */
.cta-section {
  padding: 3rem 2rem;
  max-width: 1400px;
  margin: 0 auto;
  text-align: center;
}

.cta-inner {
  background: var(--bg-secondary);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 64px 40px;
  position: relative;
  overflow: hidden;
}

.cta-inner::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 50% 0%, rgba(200, 60, 60, 0.07) 0%, transparent 65%);
  pointer-events: none;
}

.cta-inner::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(200, 60, 60, 0.5), transparent);
}

.cta-headline {
  font-family: var(--font-display);
  font-size: clamp(28px, 3vw, 36px);
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 32px;
  position: relative;
  z-index: 1;
}

.cta-buttons {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
  position: relative;
  z-index: 1;
}

.cta-btn-primary {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 13px 30px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
  transition: all 0.2s;
}

.cta-btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 0 20px rgba(200, 60, 60, 0.35);
}

.cta-btn-secondary {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 13px 30px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(200, 60, 60, 0.4);
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
  transition: all 0.2s;
}

.cta-btn-secondary:hover {
  border-color: var(--accent);
  background: rgba(200, 60, 60, 0.06);
}

/* ── LIGHT THEME GLASS EFFECTS ── */
[data-theme="light"] .result-card,
[data-theme="light"] .agent-card,
[data-theme="light"] .cap-card {
  background: rgba(255,255,255,0.6);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-color: rgba(226,221,213,0.5);
  box-shadow: 0 4px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.9);
}
[data-theme="light"] .result-card:hover,
[data-theme="light"] .agent-card:hover,
[data-theme="light"] .cap-card:hover {
  box-shadow: 0 8px 32px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.9);
  border-color: rgba(226,221,213,0.7);
}
[data-theme="light"] .scan-box {
  background: rgba(255,255,255,0.7);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-color: rgba(226,221,213,0.5);
}
[data-theme="light"] .cta-btn-secondary:hover {
  border-color: #B53030;
  background: rgba(181,48,48,0.06);
}

/* ══════════════════════════════════════════════════════════
   VISUAL UPLIFT — Phase 2D
   ══════════════════════════════════════════════════════════ */

/* ── GLOBAL POLISH ── */
html { scroll-behavior: smooth; }

/* Noise texture on hero */
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
  background-repeat: repeat;
  background-size: 200px 200px;
  opacity: 0.35;
  pointer-events: none;
  z-index: 0;
}

/* ── RADAR HERO GRAPHIC — centered behind content ── */
.hero-radar {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 700px;
  height: 560px;
  pointer-events: none;
  z-index: 1;
}

[data-theme="dark"] .hero-radar { opacity: 0.42; }
[data-theme="light"] .hero-radar { opacity: 0.2; }

/* Readability over radar */
.hero-content {
  text-shadow: 0 1px 8px rgba(0,0,0,0.12);
}
[data-theme="dark"] .hero-content {
  text-shadow: 0 2px 16px rgba(8,14,24,0.6);
}

@media (max-width: 1100px) {
  .hero-radar {
    width: 500px;
    height: 400px;
  }
}

@media (max-width: 768px) {
  .hero-radar {
    width: 340px;
    height: 270px;
  }
}

@keyframes radar-sweep {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.radar-sweep-arm {
  animation: radar-sweep 8s linear infinite;
}

/* ── STAT ROW ── */
.stat-row {
  padding: 1rem 2rem 1.5rem;
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  justify-content: space-around;
  align-items: center;
  gap: 2rem;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
}

.stat-item {
  text-align: center;
  flex: 1;
  min-width: 120px;
}

.stat-value {
  font-family: var(--font-display);
  font-size: clamp(32px, 4vw, 48px);
  font-weight: 800;
  color: var(--accent);
  line-height: 1;
  margin-bottom: 6px;
  letter-spacing: -0.02em;
}

.stat-label {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

/* ── FADE-IN SECTIONS ── */
.fade-in-section {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.65s ease, transform 0.65s ease;
}

.fade-in-section.is-visible {
  opacity: 1;
  transform: translateY(0);
}

@media (prefers-reduced-motion: reduce) {
  .fade-in-section {
    opacity: 1;
    transform: none;
    transition: none;
  }
}

/* ── AGENT CARD ICONS ── */
.agent-icon {
  width: 28px;
  height: 28px;
  margin-bottom: 10px;
  display: block;
  flex-shrink: 0;
}

/* ── CARD CLEAN OVERRIDES ── */

/* ── CTA ANIMATED BORDER ── */
.cta-border-wrap {
  position: relative;
  border-radius: var(--radius-sm);
  padding: 1.5px;
  overflow: hidden;
}

.cta-border-wrap::before {
  content: '';
  position: absolute;
  inset: -200%;
  background: conic-gradient(from 0deg, #C83C3C 0%, transparent 25%, #78A0C8 50%, transparent 75%, #C83C3C 100%);
  animation: cta-border-spin 6s linear infinite;
  z-index: 0;
  border-radius: 0;
}

@keyframes cta-border-spin {
  to { transform: rotate(360deg); }
}

.cta-border-wrap .cta-inner {
  position: relative;
  z-index: 1;
  border: none !important;
}

/* ── CTA DELTA WING WATERMARK ── */
.cta-watermark {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 0;
  opacity: 0.035;
}

.cta-watermark svg {
  width: 200px;
  height: auto;
}
</style>`;

  const content = `
${pageStyles}

<!-- HERO -->
<section class="hero">
  <div class="hero-bg"></div>

  <!-- Animated radar/aerospace graphic — centered behind hero -->
  <div class="hero-radar" aria-hidden="true">
    <svg viewBox="0 0 500 400" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <defs>
        <radialGradient id="sweepGrad" cx="250" cy="200" r="195" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#C83C3C" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="#C83C3C" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <!-- Grid lines -->
      <line x1="0" y1="100" x2="500" y2="100" stroke="var(--accent, #C83C3C)" stroke-width="0.5" opacity="0.15"/>
      <line x1="0" y1="200" x2="500" y2="200" stroke="var(--accent, #C83C3C)" stroke-width="0.5" opacity="0.2"/>
      <line x1="0" y1="300" x2="500" y2="300" stroke="var(--accent, #C83C3C)" stroke-width="0.5" opacity="0.15"/>
      <line x1="125" y1="0" x2="125" y2="400" stroke="var(--accent, #C83C3C)" stroke-width="0.5" opacity="0.15"/>
      <line x1="250" y1="0" x2="250" y2="400" stroke="var(--accent, #C83C3C)" stroke-width="0.5" opacity="0.2"/>
      <line x1="375" y1="0" x2="375" y2="400" stroke="var(--accent, #C83C3C)" stroke-width="0.5" opacity="0.15"/>
      <!-- Concentric defense circles -->
      <circle cx="250" cy="200" r="50"  stroke="var(--accent, #C83C3C)" stroke-width="1.5" stroke-dasharray="4 3" fill="none" opacity="0.4"/>
      <circle cx="250" cy="200" r="95"  stroke="var(--accent, #C83C3C)" stroke-width="1.8" stroke-dasharray="5 4" fill="none" opacity="0.5"/>
      <circle cx="250" cy="200" r="140" stroke="var(--accent, #C83C3C)" stroke-width="1.8" stroke-dasharray="5 4" fill="none" opacity="0.45"/>
      <circle cx="250" cy="200" r="192" stroke="var(--accent, #C83C3C)" stroke-width="1.5" stroke-dasharray="5 4" fill="none" opacity="0.35"/>
      <!-- Rotating radar sweep arm -->
      <g class="radar-sweep-arm" style="transform-origin: 250px 200px; transform-box: view-box;">
        <line x1="250" y1="200" x2="250" y2="8" stroke="#C83C3C" stroke-width="2" opacity="0.75" stroke-linecap="round"/>
        <path d="M250 200 L250 8 A192 192 0 0 0 58 200 Z" fill="url(#sweepGrad)" opacity="0.12"/>
      </g>
      <!-- Contact dots: red=threat, blue=tracked, green=clear -->
      <circle cx="312" cy="118" r="5"   fill="#C83C3C" opacity="0.85"/>
      <circle cx="176" cy="148" r="4.5" fill="#78A0C8" opacity="0.8"/>
      <circle cx="342" cy="265" r="4.5" fill="#28A050" opacity="0.8"/>
      <circle cx="158" cy="282" r="5"   fill="#C83C3C" opacity="0.85"/>
      <circle cx="384" cy="178" r="4"   fill="#28A050" opacity="0.8"/>
      <circle cx="196" cy="88"  r="4"   fill="#78A0C8" opacity="0.8"/>
      <circle cx="290" cy="240" r="4"   fill="#C83C3C" opacity="0.75"/>
      <circle cx="210" cy="180" r="3.5" fill="#78A0C8" opacity="0.7"/>
      <!-- Delta wing center mark -->
      <path d="M250 172 L268 222 L250 214 L232 222 Z" fill="#F0EDE8" opacity="0.8"/>
      <line x1="250" y1="190" x2="250" y2="206" stroke="#C83C3C" stroke-width="2" opacity="0.8"/>
    </svg>
  </div>

  <div class="hero-content">
    <div class="hero-tag">Threat Interceptor</div>
    <h1 class="hero-h1">Your brand is under attack<br>right now.</h1>
    <p class="hero-p">Averrow intercepts impersonation, phishing, and brand abuse across domains, email, and social — before it reaches your customers.</p>

    <!-- Synthetic intercept ticker. Illustrative only; not live data. -->
    <div class="hero-ticker" role="img" aria-label="Sample of recent threat intercepts">
      <div class="hero-ticker-label">Live Intercept Feed <span class="hero-ticker-dot"></span></div>
      <div class="hero-ticker-viewport">
        <ul class="hero-ticker-list">
          <li><span class="ti-time">14:08:22Z</span><span class="ti-sev ti-critical">CRIT</span><span class="ti-target">phish-azure-mfa.com</span><span class="ti-tag">Phishing kit</span></li>
          <li><span class="ti-time">14:08:11Z</span><span class="ti-sev ti-high">HIGH</span><span class="ti-target">paypal-secure-verify.net</span><span class="ti-tag">Lookalike domain</span></li>
          <li><span class="ti-time">14:07:58Z</span><span class="ti-sev ti-high">HIGH</span><span class="ti-target">@yourbrand_support</span><span class="ti-tag">Social impersonation</span></li>
          <li><span class="ti-time">14:07:42Z</span><span class="ti-sev ti-medium">MED</span><span class="ti-target">yourbrand.com</span><span class="ti-tag">SPF record drift</span></li>
          <li><span class="ti-time">14:07:30Z</span><span class="ti-sev ti-high">HIGH</span><span class="ti-target">acct.yourbrand.com.io</span><span class="ti-tag">Cert anomaly</span></li>
          <li><span class="ti-time">14:07:14Z</span><span class="ti-sev ti-critical">CRIT</span><span class="ti-target">chase-banking-alert.app</span><span class="ti-tag">Malware delivery</span></li>
          <!-- duplicate first three for seamless loop -->
          <li aria-hidden="true"><span class="ti-time">14:08:22Z</span><span class="ti-sev ti-critical">CRIT</span><span class="ti-target">phish-azure-mfa.com</span><span class="ti-tag">Phishing kit</span></li>
          <li aria-hidden="true"><span class="ti-time">14:08:11Z</span><span class="ti-sev ti-high">HIGH</span><span class="ti-target">paypal-secure-verify.net</span><span class="ti-tag">Lookalike domain</span></li>
          <li aria-hidden="true"><span class="ti-time">14:07:58Z</span><span class="ti-sev ti-high">HIGH</span><span class="ti-target">@yourbrand_support</span><span class="ti-tag">Social impersonation</span></li>
        </ul>
      </div>
    </div>

    <form class="scan-box" id="scanForm" action="/assess" method="POST">
      <input class="scan-input" id="domainInput" name="domain" placeholder="Enter any domain" autocomplete="off">
      <button class="scan-btn" type="submit" id="scanBtn">Launch Sortie</button>
    </form>
    <div class="scan-hint">Enter any domain &mdash; no signup required &middot; <span class="scan-hint-emphasis">Intercept feed above is illustrative</span></div>
  </div>
</section>

<hr class="tr-divider-animated">

<!-- STAT ROW -->
<div class="stat-row fade-in-section">
  <div class="stat-item">
    <div class="stat-value">${stats.uptime_label}</div>
    <div class="stat-label">Continuous monitoring</div>
  </div>
  <div class="stat-item">
    <div class="stat-value">${stats.agents_deployed}</div>
    <div class="stat-label">AI agents deployed</div>
  </div>
  <div class="stat-item">
    <div class="stat-value">${stats.detection_time_label.replace("<", "&lt;")}</div>
    <div class="stat-label">Threat detection time</div>
  </div>
  <div class="stat-item">
    <div class="stat-value">${stats.feeds_protecting}</div>
    <div class="stat-label">Brand protection feeds</div>
  </div>
</div>

<!-- TRUST METRICS — coverage strip -->
<div class="stat-row fade-in-section" style="margin-top: -0.5rem; opacity: 0.85;">
  <div class="stat-item">
    <div class="stat-value">${stats.threats_detected}</div>
    <div class="stat-label">Threats detected to date</div>
  </div>
  <div class="stat-item">
    <div class="stat-value">${stats.brands_monitored}</div>
    <div class="stat-label">Brands in coverage</div>
  </div>
</div>

<!-- AGENT SQUADRON -->
<section class="squadron fade-in-section">
  <div class="section-label">Agent Squadron</div>
  <h2 class="squadron-title">Six core agents. ${stats.agents_deployed} on the field.</h2>
  <p class="squadron-subtitle">A deployed mesh of ${stats.agents_deployed} AI agents — six core agents shown here, plus specialized agents handling enrichment, infrastructure clustering, takedowns, social discovery, and continuous health monitoring.</p>
  <div class="agent-grid">

    <!-- Sentinel — Signal Red — radar sweep -->
    <div class="agent-card" style="--agent-color: #C83C3C;">
      <svg class="agent-icon" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:#C83C3C">
        <circle cx="14" cy="14" r="5"  stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
        <circle cx="14" cy="14" r="11" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.4"/>
        <circle cx="14" cy="14" r="1.5" fill="currentColor"/>
        <line x1="14" y1="14" x2="14" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="20.5" cy="7.5" r="1.5" fill="#C83C3C" opacity="0.95"/>
        <circle cx="6"    cy="19"  r="1.2" fill="#78A0C8"  opacity="0.85"/>
      </svg>
      <div class="agent-name">Sentinel</div>
      <div class="agent-role">Threat Detection</div>
      <div class="agent-desc">Continuous radar sweep across all feeds</div>
    </div>

    <!-- ASTRA — Amber — targeting diamond -->
    <div class="agent-card" style="--agent-color: #E8923C;">
      <svg class="agent-icon" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:#E8923C">
        <path d="M14 3 L25 14 L14 25 L3 14 Z" stroke="currentColor" stroke-width="1.5"/>
        <line x1="14" y1="3"  x2="14" y2="25" stroke="currentColor" stroke-width="1" opacity="0.35"/>
        <line x1="3"  y1="14" x2="25" y2="14" stroke="currentColor" stroke-width="1" opacity="0.35"/>
        <circle cx="14" cy="14" r="3" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
        <circle cx="14" cy="14" r="1.5" fill="currentColor"/>
      </svg>
      <div class="agent-name">ASTRA</div>
      <div class="agent-role">Fire Control</div>
      <div class="agent-desc">Classifies, scores, and prioritizes threat severity</div>
    </div>

    <!-- Observer — Blue — eye with iris -->
    <div class="agent-card" style="--agent-color: #78A0C8;">
      <svg class="agent-icon" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:#78A0C8">
        <path d="M2 14 Q14 4 26 14 Q14 24 2 14 Z" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="14" cy="14" r="4.5" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="14" cy="14" r="2"   fill="currentColor"/>
        <line x1="14" y1="4"  x2="14" y2="7"  stroke="currentColor" stroke-width="1" opacity="0.45" stroke-linecap="round"/>
        <line x1="14" y1="21" x2="14" y2="24" stroke="currentColor" stroke-width="1" opacity="0.45" stroke-linecap="round"/>
      </svg>
      <div class="agent-name">Observer</div>
      <div class="agent-role">Strategic Intel</div>
      <div class="agent-desc">Daily briefings and macro trend analysis</div>
    </div>

    <!-- Navigator — Blue-600 — globe with pin -->
    <div class="agent-card" style="--agent-color: #5A80A8;">
      <svg class="agent-icon" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:#5A80A8">
        <circle cx="14" cy="16" r="10" stroke="currentColor" stroke-width="1.5"/>
        <ellipse cx="14" cy="16" rx="4" ry="10" stroke="currentColor" stroke-width="1" opacity="0.5"/>
        <line x1="4" y1="16" x2="24" y2="16" stroke="currentColor" stroke-width="1" opacity="0.5"/>
        <line x1="14" y1="2"  x2="14" y2="9"  stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="14" cy="5.5" r="2.5" fill="currentColor"/>
      </svg>
      <div class="agent-name">Navigator</div>
      <div class="agent-role">Geo Mapping</div>
      <div class="agent-desc">Plots threat origins and infrastructure</div>
    </div>

    <!-- Blackbox — Slate — flight recorder with EKG -->
    <div class="agent-card" style="--agent-color: #8A8F9C;">
      <svg class="agent-icon" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:#8A8F9C">
        <rect x="2" y="6" width="24" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/>
        <polyline points="3,14 6,14 8,9 10.5,18.5 13,11 15,16 17,14 25,14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="23.5" cy="8.5" r="2" fill="#C83C3C" opacity="0.9"/>
      </svg>
      <div class="agent-name">Blackbox</div>
      <div class="agent-role">Flight Recorder</div>
      <div class="agent-desc">Captures threat timelines and narratives</div>
    </div>

    <!-- Pathfinder — Green — path with waypoints -->
    <div class="agent-card" style="--agent-color: #28A050;">
      <svg class="agent-icon" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:#28A050">
        <path d="M7 24 Q9 18 13 13 Q17 8 20 4" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2" stroke-linecap="round"/>
        <circle cx="7"  cy="24" r="2.5" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="13" cy="13" r="2"   fill="currentColor" opacity="0.75"/>
        <path d="M17.5 2.5 L20 5.5 L22.5 2.5 L20 0 Z" fill="currentColor"/>
        <circle cx="22" cy="9"  r="1.5" fill="currentColor" opacity="0.5"/>
      </svg>
      <div class="agent-name">Pathfinder</div>
      <div class="agent-role">Target Acquisition</div>
      <div class="agent-desc">Identifies prospects and generates outreach</div>
    </div>

  </div>
</section>

<hr class="tr-divider-animated">

<!-- HOW IT WORKS -->
<section class="how-it-works fade-in-section">
  <div class="section-label">How It Works</div>
  <div class="steps-row">
    <div class="step">
      <div class="step-num">01</div>
      <div class="step-title">Connect your brand</div>
      <div class="step-desc">Enter any domain — no signup required. We start scanning immediately.</div>
    </div>
    <div class="step-arrow">&#x2192;</div>
    <div class="step">
      <div class="step-num">02</div>
      <div class="step-title">We scan everything</div>
      <div class="step-desc">Six AI agents sweep threat feeds, email authentication, domains, and social platforms.</div>
    </div>
    <div class="step-arrow">&#x2192;</div>
    <div class="step">
      <div class="step-num">03</div>
      <div class="step-title">AI agents investigate</div>
      <div class="step-desc">Cross-referencing signals to produce actionable intelligence and severity scoring.</div>
    </div>
    <div class="step-arrow">&#x2192;</div>
    <div class="step">
      <div class="step-num">04</div>
      <div class="step-title">Threats neutralized</div>
      <div class="step-desc">You get actionable intelligence with takedown evidence and remediation steps.</div>
    </div>
  </div>
</section>

<hr class="tr-divider-animated">

<!-- CAPABILITIES SECTION — Phase 2C -->
<hr class="tr-divider-animated">

<section class="capabilities fade-in-section">
  <div class="section-label">Capabilities</div>
  <h2 class="capabilities-title">Full-spectrum brand protection</h2>
  <div class="capabilities-grid">

    <div class="cap-card">
      <svg class="cap-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="16" cy="16" r="2" fill="currentColor"/>
        <circle cx="16" cy="16" r="6" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
        <circle cx="16" cy="16" r="11" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
        <line x1="16" y1="16" x2="16" y2="5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="16" y1="16" x2="24" y2="10" stroke="currentColor" stroke-width="1" opacity="0.5" stroke-linecap="round"/>
        <circle cx="22" cy="9" r="1.5" fill="currentColor" opacity="0.7"/>
      </svg>
      <div class="cap-title">Threat Feed Intelligence</div>
      <div class="cap-desc">Continuous scanning across phishing databases, malware feeds, and newly registered domains.</div>
      <div class="cap-mock" aria-label="Sample threat feed output">
        <div class="cap-mock-row"><span class="cap-mock-target">login-yourbrand-mfa.com</span><span class="cap-mock-badge crit">CRIT</span></div>
        <div class="cap-mock-row"><span class="cap-mock-target">yourbrand-support.help</span><span class="cap-mock-badge high">HIGH</span></div>
        <div class="cap-mock-row"><span class="cap-mock-target">yourbrand-billing.app</span><span class="cap-mock-badge high">HIGH</span></div>
      </div>
    </div>

    <div class="cap-card">
      <svg class="cap-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="7" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/>
        <polyline points="3,7 13,16 23,7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M22 17 L28 17 L28 29 L22 29 Z" stroke="currentColor" stroke-width="1.5" fill="none"/>
        <path d="M24 21 L26 23 L24 25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="cap-title">Email Security Posture</div>
      <div class="cap-desc">SPF, DKIM, and DMARC analysis with grading so spoofing is caught at the gate.</div>
      <div class="cap-mock" aria-label="Sample email auth grade">
        <div class="cap-mock-grade">
          <div class="cap-mock-grade-cell"><div class="gl-label">SPF</div><div class="gl-value pass">A</div></div>
          <div class="cap-mock-grade-cell"><div class="gl-label">DKIM</div><div class="gl-value pass">A</div></div>
          <div class="cap-mock-grade-cell"><div class="gl-label">DMARC</div><div class="gl-value fail">F</div></div>
        </div>
      </div>
    </div>

    <div class="cap-card">
      <svg class="cap-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="16" cy="16" rx="13" ry="7" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="16" cy="16" r="4" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="16" cy="16" r="1.5" fill="currentColor"/>
        <line x1="3" y1="16" x2="8" y2="16" stroke="currentColor" stroke-width="1" opacity="0.5"/>
        <line x1="24" y1="16" x2="29" y2="16" stroke="currentColor" stroke-width="1" opacity="0.5"/>
        <circle cx="7" cy="12" r="1" fill="currentColor" opacity="0.6"/>
        <circle cx="25" cy="20" r="1" fill="currentColor" opacity="0.6"/>
      </svg>
      <div class="cap-title">Social Airspace Monitoring</div>
      <div class="cap-desc">Fake accounts, handle squatting, and unauthorized brand usage across six platforms.</div>
      <div class="cap-mock" aria-label="Sample social impersonation match">
        <div class="cap-mock-social">
          <div class="cap-mock-social-avatar">Y</div>
          <div class="cap-mock-social-info">
            <div class="cap-mock-social-handle">@yourbrand_support</div>
            <div class="cap-mock-social-meta">Instagram &middot; 11 days old &middot; no link in bio</div>
          </div>
          <div class="cap-mock-score">94</div>
        </div>
      </div>
    </div>

    <div class="cap-card">
      <svg class="cap-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="13" cy="13" r="8" stroke="currentColor" stroke-width="1.5"/>
        <line x1="19" y1="19" x2="27" y2="27" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M10 10 Q13 8 16 10" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
        <path d="M10 13 Q13 11 16 13" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
        <circle cx="13" cy="13" r="2" fill="currentColor" opacity="0.4"/>
      </svg>
      <div class="cap-title">Lookalike Domain Detection</div>
      <div class="cap-desc">Fuzzy matching, homoglyph analysis, and newly registered domain monitoring.</div>
      <div class="cap-mock" aria-label="Sample lookalike comparison">
        <div class="cap-mock-diff">
          <div class="cap-mock-diff-line"><div class="cap-mock-diff-label">Real</div><div class="cap-mock-diff-value">yourbrand.com</div></div>
          <div class="cap-mock-diff-line"><div class="cap-mock-diff-label">Match</div><div class="cap-mock-diff-value">y<span class="hi">0</span>urbr<span class="hi">a</span>nd.<span class="hi">co</span></div></div>
          <div class="cap-mock-diff-line"><div class="cap-mock-diff-label">Reg.</div><div class="cap-mock-diff-value">2 days ago &middot; Namecheap</div></div>
        </div>
      </div>
    </div>

    <div class="cap-card">
      <svg class="cap-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="7" y="4" width="18" height="24" rx="2" stroke="currentColor" stroke-width="1.5"/>
        <line x1="11" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="11" y1="14" x2="21" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="11" y1="18" x2="17" y2="18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="22" cy="24" r="4" fill="var(--bg-base, #080e18)" stroke="currentColor" stroke-width="1.5"/>
        <polyline points="19.5,24 21.5,26 24.5,22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="cap-title">Certificate Transparency</div>
      <div class="cap-desc">Real-time monitoring of SSL certificate issuance across brand-adjacent domains.</div>
      <div class="cap-mock" aria-label="Sample CT log entry">
        <div class="cap-mock-row"><span class="cap-mock-target">acct.yourbrand.com.io</span><span class="cap-mock-badge high">NEW</span></div>
        <div class="cap-mock-row"><span class="cap-mock-target">Let's Encrypt &middot; 14:07:30Z</span><span class="cap-mock-badge med">ANOM</span></div>
      </div>
    </div>

    <div class="cap-card">
      <svg class="cap-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="6" width="24" height="20" rx="2" stroke="currentColor" stroke-width="1.5"/>
        <polyline points="4,18 8,18 10,12 13,22 16,14 19,20 21,16 24,16 28,16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="26" cy="8" r="2.5" fill="currentColor" opacity="0.9"/>
      </svg>
      <div class="cap-title">AI Threat Narratives</div>
      <div class="cap-desc">Human-readable threat timelines and remediation steps so your team can act fast.</div>
      <div class="cap-mock cap-mock-narrative" aria-label="Sample threat narrative">
        &ldquo;A single actor registered three lookalikes in 72 hours, all behind the same Cloudflare account. Pattern matches the &lsquo;BeaverTooth&rsquo; phishing kit.&rdquo;
        <div class="nm-meta">Analyst agent &middot; 2 min read</div>
      </div>
    </div>

  </div>
</section>

<!-- TRUST SIGNALS removed from /legacy in R7 — they live in the
     Astro marketing site (TrustSignals.astro) and don't need to
     appear on the legacy escape-hatch view. -->

<!-- CTA SECTION — Phase 2C -->
<hr class="tr-divider-animated">

<section class="cta-section fade-in-section">
  <div class="cta-border-wrap">
  <div class="cta-inner">
    <!-- Delta wing watermark -->
    <div class="cta-watermark" aria-hidden="true">
      <svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg">
        <path d="M100 8 L185 152 L100 135 L15 152 Z" fill="#F0EDE8"/>
        <!-- Negative-space A crossbar -->
        <path d="M55 125 L145 125 L135 108 L65 108 Z" fill="#080E18"/>
      </svg>
    </div>
    <h2 class="cta-headline">Ready to protect your brand?</h2>
    <div class="cta-buttons">
      <a href="/scan" class="cta-btn-primary">Launch Free Scan</a>
      <a href="/pricing" class="cta-btn-secondary">View Pricing</a>
    </div>
  </div>
  </div>
</section>

<!-- RESULTS (hidden until scan) -->
<section id="results-section">
  <div id="results-content"></div>
</section>

<script>
function scoreColor(s) {
  if (s >= 80) return 'var(--green)';
  if (s >= 60) return 'var(--blue)';
  if (s >= 40) return 'var(--amber)';
  return 'var(--accent)';
}

function gradeFor(s) {
  if (s >= 90) return 'A';
  if (s >= 80) return 'B';
  if (s >= 60) return 'C';
  if (s >= 40) return 'D';
  return 'F';
}

function summaryFor(s, d) {
  if (s >= 80) return d + ' has strong security posture. Email authentication is well-configured and we found minimal threat activity targeting this domain.';
  if (s >= 60) return d + ' has moderate security. Some areas need attention — particularly email authentication and active monitoring for impersonation threats.';
  if (s >= 40) return d + ' has concerning security gaps. We detected active threats and missing security configurations that leave the brand exposed.';
  return d + ' has critical security vulnerabilities. Multiple active threats detected, missing essential email authentication, and significant impersonation risk.';
}

var FREEMAIL_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','mail.com','protonmail.com','proton.me','yandex.com','zoho.com','gmx.com','fastmail.com','tutanota.com','hey.com','live.com','msn.com','me.com','qq.com','163.com'];

document.getElementById('scanForm').addEventListener('submit', function(e) {
  e.preventDefault();
  var domain = document.getElementById('domainInput').value.trim().toLowerCase();
  domain = domain.replace(/^https?:\\/\\//, '').split('/')[0];
  if (!domain || !domain.includes('.')) return;

  var btn = document.getElementById('scanBtn');
  btn.disabled = true;
  btn.textContent = 'SCANNING...';

  var rs = document.getElementById('results-section');
  rs.classList.add('visible');
  rs.scrollIntoView({ behavior: 'smooth' });

  rs.querySelector('#results-content').innerHTML =
    '<div class="scanning"><div class="scan-ring-anim"></div><div class="scan-label">Scanning ' + domain + '</div><div class="scan-detail" id="scan-step">Resolving DNS records...</div></div>';

  var steps = ['Resolving DNS records...','Checking email authentication (SPF/DKIM/DMARC)...','Validating SSL/TLS certificates...','Scanning for active threats...','Checking impersonation domains...','Analyzing hosting infrastructure...','Calculating defense grade...'];
  var si = 0;
  var stepInterval = setInterval(function() {
    si++;
    if (si < steps.length) {
      var el = document.getElementById('scan-step');
      if (el) el.textContent = steps[si];
    }
  }, 600);

  fetch('/api/brand-scan/public', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: domain })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(stepInterval);
    btn.disabled = false;
    btn.textContent = 'LAUNCH SORTIE';

    if (!data.success) {
      rs.querySelector('#results-content').innerHTML =
        '<div class="result-card"><div class="result-domain">' + domain + '</div><p style="color:var(--accent)">Scan failed: ' + (data.error || 'Unknown error') + '</p></div>';
      return;
    }

    var d = data.data;
    var score = d.trustScore;
    var sc = scoreColor(score);
    var grade = gradeFor(score);

    var risks = [];
    if (d.riskLevel === 'critical' || d.riskLevel === 'high') risks.push({ text: 'Risk: ' + d.riskLevel.toUpperCase(), cls: 'bad' });
    else if (d.riskLevel === 'medium') risks.push({ text: 'Risk: MEDIUM', cls: 'warn' });
    else risks.push({ text: 'Risk: LOW', cls: 'ok' });

    if (d.feedMentions) risks.push({ text: 'Active threats detected', cls: 'bad' });
    else risks.push({ text: 'No active threats', cls: 'ok' });

    if (d.lookalikesPossible > 50) risks.push({ text: d.lookalikesPossible + ' lookalike domains possible', cls: 'warn' });

    rs.querySelector('#results-content').innerHTML =
      '<div class="result-card">' +
        '<div class="result-domain">' + domain + '</div>' +
        '<div class="score-ring">' +
          '<svg viewBox="0 0 140 140">' +
            '<circle cx="70" cy="70" r="60" fill="none" stroke="var(--bg-tertiary)" stroke-width="6"/>' +
            '<circle cx="70" cy="70" r="60" fill="none" stroke="' + sc + '" stroke-width="6" stroke-dasharray="377" stroke-dashoffset="' + (377 * (1 - score / 100)) + '" stroke-linecap="round" transform="rotate(-90 70 70)" style="transition:stroke-dashoffset 1.5s ease"/>' +
          '</svg>' +
          '<div class="score-val" style="color:' + sc + '">' + score + '</div>' +
        '</div>' +
        '<div class="score-grade" style="color:' + sc + '">Defense Grade: ' + grade + '</div>' +
        '<div class="score-summary">' + summaryFor(score, domain) + '</div>' +
        '<div class="risk-pills">' + risks.map(function(r) { return '<span class="risk-p ' + r.cls + '">' + r.text + '</span>'; }).join('') + '</div>' +
        '<div class="gate-divider">' +
          '<div class="gate-title">Get the Full Intercept Report</div>' +
          '<div class="gate-sub">Detailed assessment with threat actor analysis, infrastructure mapping, and specific remediation steps.</div>' +
          '<form class="gate-form" id="gateForm">' +
            '<input class="gate-input" id="emailInput" name="email" placeholder="Business email address" type="email" required>' +
            '<button class="gate-btn" type="submit" id="gateBtn">Get Report</button>' +
          '</form>' +
          '<div class="gate-note" id="gateNote">Business email required &middot; Free &middot; No credit card</div>' +
        '</div>' +
      '</div>';

    document.getElementById('gateForm').addEventListener('submit', function(ev) {
      ev.preventDefault();
      var email = document.getElementById('emailInput').value.trim();
      var emailDomain = (email.split('@')[1] || '').toLowerCase();
      if (!email || !email.includes('@')) return;
      if (FREEMAIL_DOMAINS.indexOf(emailDomain) !== -1) {
        document.getElementById('emailInput').style.borderColor = 'var(--accent)';
        var note = document.getElementById('gateNote');
        note.textContent = 'Please use a business email address (no free email providers)';
        note.className = 'gate-note gate-error';
        return;
      }
      var gbtn = document.getElementById('gateBtn');
      gbtn.textContent = 'Sending...';
      gbtn.disabled = true;
      fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, name: email.split('@')[0], domain: domain, company: emailDomain })
      })
      .then(function() {
        gbtn.textContent = '\\u2713 Sent!';
        gbtn.style.background = 'var(--green)';
        var note = document.getElementById('gateNote');
        note.textContent = 'Check your inbox \\u2014 we\\u2019ve confirmed your request. Your Averrow team is preparing your full report.';
        note.style.color = 'var(--green)';
        note.className = 'gate-note';
      })
      .catch(function() {
        gbtn.textContent = 'Get Report';
        gbtn.disabled = false;
      });
    });
  })
  .catch(function() {
    clearInterval(stepInterval);
    btn.disabled = false;
    btn.textContent = 'LAUNCH SORTIE';
    rs.querySelector('#results-content').innerHTML =
      '<div class="result-card"><p style="color:var(--accent)">Scan failed. Please check the domain and try again.</p></div>';
  });
});

document.getElementById('domainInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('scanForm').dispatchEvent(new Event('submit'));
  }
});

// Fade-in on scroll (IntersectionObserver). Reduced-motion users skip
// the reveal entirely so content is visible immediately.
(function() {
  var sections = document.querySelectorAll('.fade-in-section');
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    sections.forEach(function(el) { el.classList.add('is-visible'); });
    return;
  }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries) {
      entries.forEach(function(e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.08 });
    sections.forEach(function(el) { io.observe(el); });
  } else {
    sections.forEach(function(el) { el.classList.add('is-visible'); });
  }
})();
</script>
${spiderTraps}`;

  return wrapPage(
    "Averrow — AI-Powered Brand Protection",
    "Averrow — AI-powered brand protection. Detect impersonation, phishing, domain abuse, and social media threats before they reach your customers. Free domain scan — no signup required.",
    content
  );
}

// ─── Assessment Results Page (server-rendered) ──────────────────

export function renderAssessResults(scanId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Brand Check Results — Averrow</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
/* --blue-* names retained for diff-locality, but the accent is the
   Averrow red (#C83C3C) so this page matches averrow.com + /scan
   instead of the retired cyan Trust Radar identity. */
:root{--bg-void:#060A14;--bg-surface:#0a1020;--bg-panel:#0d1528;--bg-elevated:#111d35;--blue-primary:#C83C3C;--blue-muted:#8B1A1A;--blue-glow:rgba(200,60,60,.08);--blue-border:rgba(200,60,60,.18);--blue-border-bright:rgba(200,60,60,.40);--amber:#E5A832;--threat-critical:#ff3b5c;--threat-high:#ff6b35;--threat-medium:#ffb627;--positive:#3CB878;--positive-muted:rgba(60,184,120,.12);--negative:#ff3b5c;--purple:#b388ff;--text-primary:#e8edf5;--text-secondary:#7a8ba8;--text-tertiary:#4a5a73;--text-accent:#C83C3C;--font-display:'Plus Jakarta Sans',sans-serif;--font-body:'Plus Jakarta Sans',sans-serif;--font-mono:'IBM Plex Mono',monospace;--radius:6px;--radius-lg:10px}
*{margin:0;padding:0;box-sizing:border-box}html{background:var(--bg-void);color:var(--text-primary);font-family:var(--font-body)}
.pub-nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:14px 40px;background:rgba(4,8,16,.85);backdrop-filter:blur(12px);border-bottom:1px solid var(--blue-border)}
.pub-logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text-primary)}
.pub-logo svg{flex-shrink:0}
.pub-logo .brand-name{font-family:var(--font-display);font-weight:700;font-size:18px;letter-spacing:2px;text-transform:uppercase;line-height:1;display:block}
.pub-logo .brand-sub{font-family:var(--font-mono);font-weight:600;font-size:8px;letter-spacing:2px;text-transform:uppercase;color:var(--text-tertiary);display:block;margin-top:3px}
.login-btn{font-family:var(--font-display);font-size:11px;font-weight:600;padding:7px 18px;border-radius:var(--radius);border:1px solid var(--blue-border-bright);background:var(--bg-panel);color:var(--blue-primary);cursor:pointer;text-decoration:none;transition:all .15s}.login-btn:hover{background:var(--bg-elevated)}
.results-page{max-width:640px;margin:0 auto;padding:100px 24px 60px;text-align:center}
.loading{font-family:var(--font-mono);font-size:13px;color:var(--text-secondary);padding:60px 0}
.result-card{background:var(--bg-surface);border:1px solid var(--blue-border);border-radius:var(--radius-lg);padding:36px;margin-bottom:24px}
.result-domain{font-family:var(--font-mono);font-size:16px;color:var(--text-secondary);margin-bottom:20px}
.score-ring{width:160px;height:160px;margin:0 auto 16px;position:relative}
.score-ring svg{width:160px;height:160px}
.score-val{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:var(--font-display);font-weight:700;font-size:48px}
.score-grade{font-family:var(--font-display);font-size:22px;font-weight:700;margin-bottom:10px}
.score-summary{font-size:14px;color:var(--text-secondary);line-height:1.6;max-width:450px;margin:0 auto 24px}
.risk-pills{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-bottom:24px}
.risk-p{font-family:var(--font-mono);font-size:10px;padding:5px 12px;border-radius:4px}
.risk-p.bad{background:rgba(255,59,92,.1);color:var(--negative)}.risk-p.warn{background:rgba(255,182,39,.1);color:var(--threat-medium)}.risk-p.ok{background:var(--positive-muted);color:var(--positive)}
.gate-divider{border-top:1px solid var(--blue-border);margin:24px 0;padding-top:20px}
.gate-title{font-family:var(--font-display);font-size:14px;font-weight:700;margin-bottom:4px}
.gate-sub{font-size:11px;color:var(--text-tertiary);margin-bottom:16px}
.gate-form{display:flex;gap:8px;max-width:400px;margin:0 auto}
.gate-input{flex:1;font-family:var(--font-body);font-size:13px;padding:10px 14px;border-radius:var(--radius);border:1px solid var(--blue-border);background:var(--bg-panel);color:var(--text-primary);outline:none}
.gate-input:focus{border-color:var(--blue-border-bright)}
.gate-input::placeholder{color:var(--text-tertiary)}
.gate-btn{font-family:var(--font-display);font-size:11px;font-weight:600;padding:10px 20px;border-radius:var(--radius);border:none;background:var(--blue-primary);color:var(--bg-void);cursor:pointer;white-space:nowrap}
.gate-note{font-family:var(--font-mono);font-size:9px;color:var(--text-tertiary);margin-top:8px}
.gate-error{color:var(--negative)}
.back-link{display:inline-block;font-family:var(--font-display);font-size:12px;color:var(--blue-primary);text-decoration:none;margin-top:16px;padding:8px 16px;border:1px solid var(--blue-border);border-radius:var(--radius)}.back-link:hover{background:var(--bg-panel)}
</style>
</head>
<body>
<nav class="pub-nav">
  <a href="/" class="pub-logo">
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <defs><linearGradient id="deep-arrow-assess" x1="16" y1="5" x2="16" y2="26" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#6B1010"/><stop offset="100%" stop-color="#C83C3C"/></linearGradient></defs>
      <rect width="32" height="32" rx="6" fill="#080E18"/>
      <path d="M16 5L26 26H18L16 21L14 26H6Z" fill="url(#deep-arrow-assess)"/>
      <path d="M14.5 22H17.5L16 18Z" fill="#080E18"/>
    </svg>
    <div><span class="brand-name">AVERROW</span><span class="brand-sub">Threat Intelligence</span></div>
  </a>
  <a class="login-btn" href="/login">Sign In</a>
</nav>
<div class="results-page">
  <div class="loading" id="loading">Loading assessment results...</div>
  <div id="results"></div>
</div>
<script>
var FREEMAIL_DOMAINS=['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','mail.com','protonmail.com','proton.me','yandex.com','zoho.com','gmx.com','fastmail.com','tutanota.com','hey.com','live.com','msn.com','me.com','qq.com','163.com'];
function scoreColor(s){return s>=80?'var(--positive)':s>=60?'var(--amber)':s>=40?'var(--threat-medium)':s>=25?'var(--threat-high)':'var(--negative)'}
function gradeFor(s){return s>=90?'A':s>=80?'B':s>=60?'C':s>=40?'D':'F'}
function summaryFor(s,d){
  if(s>=80)return d+' has strong security posture. Email authentication is well-configured and we found minimal threat activity.';
  if(s>=60)return d+' has moderate security. Some areas need attention — particularly email authentication and active monitoring for impersonation threats.';
  if(s>=40)return d+' has concerning security gaps. We detected active threats and missing security configurations that leave the brand exposed.';
  return d+' has critical security vulnerabilities. Multiple active threats detected, missing essential email authentication, and significant impersonation risk.';
}

var scanId=${JSON.stringify(scanId)};
fetch('/api/brand-scan/public/'+encodeURIComponent(scanId))
.then(function(r){return r.json()})
.then(function(data){
  document.getElementById('loading').style.display='none';
  if(!data.success){
    document.getElementById('results').innerHTML='<div class="result-card"><p style="color:var(--negative)">'+( data.error||'Assessment not found')+'</p></div><a href="/" class="back-link">\\u2190 Scan another domain</a>';
    return;
  }
  var d=data.data;
  var score=d.trust_score||d.trustScore||50;
  var domain=d.domain||'Unknown';
  var sc=scoreColor(score);
  var grade=gradeFor(score);
  var riskLevel=d.risk_level||d.riskLevel||'medium';

  var risks=[];
  if(riskLevel==='critical'||riskLevel==='high') risks.push({text:'Risk: '+riskLevel.toUpperCase(),cls:'bad'});
  else if(riskLevel==='medium') risks.push({text:'Risk: MEDIUM',cls:'warn'});
  else risks.push({text:'Risk: LOW',cls:'ok'});

  if(d.spf_policy==='hardfail') risks.push({text:'SPF: Enforced',cls:'ok'});
  else if(d.spf_policy) risks.push({text:'SPF: '+d.spf_policy,cls:'warn'});
  else risks.push({text:'SPF: Missing',cls:'bad'});

  if(d.dmarc_policy==='reject') risks.push({text:'DMARC: Enforced',cls:'ok'});
  else if(d.dmarc_policy) risks.push({text:'DMARC: '+d.dmarc_policy,cls:'warn'});
  else risks.push({text:'DMARC: Missing',cls:'bad'});

  if(d.feed_mentions>0) risks.push({text:'Active threats: '+d.feed_mentions,cls:'bad'});
  else risks.push({text:'No active threats',cls:'ok'});

  document.getElementById('results').innerHTML=
    '<div class="result-card">'+
      '<div class="result-domain">'+domain+'</div>'+
      '<div class="score-ring"><svg viewBox="0 0 160 160"><circle cx="80" cy="80" r="68" fill="none" stroke="var(--bg-elevated)" stroke-width="6"/><circle cx="80" cy="80" r="68" fill="none" stroke="'+sc+'" stroke-width="6" stroke-dasharray="427" stroke-dashoffset="'+(427*(1-score/100))+'" stroke-linecap="round" transform="rotate(-90 80 80)" style="transition:stroke-dashoffset 1.5s ease"/></svg><div class="score-val" style="color:'+sc+'">'+score+'</div></div>'+
      '<div class="score-grade" style="color:'+sc+'">Grade: '+grade+'</div>'+
      '<div class="score-summary">'+summaryFor(score,domain)+'</div>'+
      '<div class="risk-pills">'+risks.map(function(r){return '<span class="risk-p '+r.cls+'">'+r.text+'</span>'}).join('')+'</div>'+
      '<div class="gate-divider"><div class="gate-title">Get the Full Report</div><div class="gate-sub">Detailed assessment with threat actor analysis, infrastructure mapping, and remediation steps.</div>'+
        '<form class="gate-form" id="gateForm"><input class="gate-input" id="emailInput" placeholder="Business email address" type="email" required><button class="gate-btn" type="submit" id="gateBtn">Get Report</button></form>'+
        '<div class="gate-note" id="gateNote">Business email required &middot; Free &middot; No credit card</div>'+
      '</div>'+
    '</div>'+
    '<a href="/" class="back-link">\\u2190 Scan another domain</a>';

  document.getElementById('gateForm').addEventListener('submit',function(ev){
    ev.preventDefault();
    var email=document.getElementById('emailInput').value.trim();
    var emailDomain=(email.split('@')[1]||'').toLowerCase();
    if(!email||!email.includes('@'))return;
    if(FREEMAIL_DOMAINS.indexOf(emailDomain)!==-1){
      document.getElementById('emailInput').style.borderColor='var(--negative)';
      var note=document.getElementById('gateNote');
      note.textContent='Please use a business email address (no free email providers)';
      note.className='gate-note gate-error';
      return;
    }
    var gbtn=document.getElementById('gateBtn');
    gbtn.textContent='Sending...';gbtn.disabled=true;
    fetch('/api/leads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,name:email.split('@')[0],domain:domain,company:emailDomain})})
    .then(function(){gbtn.textContent='\\u2713 Sent!';gbtn.style.background='var(--positive)';var n=document.getElementById('gateNote');n.textContent='Check your inbox \\u2014 we\\u2019ve confirmed your request. Your Averrow team is preparing your full report.';n.style.color='var(--positive)';n.className='gate-note';})
    .catch(function(){gbtn.textContent='Get Report';gbtn.disabled=false;});
  });
})
.catch(function(){
  document.getElementById('loading').style.display='none';
  document.getElementById('results').innerHTML='<div class="result-card"><p style="color:var(--negative)">Failed to load assessment results.</p></div><a href="/" class="back-link">\\u2190 Scan another domain</a>';
});
</script>
</body>
</html>`;
}
