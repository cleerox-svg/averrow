/**
 * Trust Radar — Security & Trust Page
 * Served at /security
 */

import { wrapPage } from './shared';
import { generateSpiderTraps } from '../seeders/spider-injector';

export function renderSecurityPage(): string {
  const content = `
<style>
/* ── SECURITY PAGE STYLES ── */
.sec-hero {
  padding: 5rem 0 2.5rem;
  text-align: center;
  background: var(--gradient-hero);
}

.sec-hero h1 {
  font-family: var(--font-display);
  font-size: clamp(2.4rem, 5vw, 3.2rem);
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
  margin-bottom: 1rem;
}

.sec-hero p {
  font-size: 1.15rem;
  color: var(--text-secondary);
  max-width: 520px;
  margin: 0 auto;
  line-height: 1.7;
}

.sec-body {
  max-width: 800px;
  margin: 0 auto;
  padding: 0 2rem;
}

.sec-section {
  padding: 3rem 0;
}

.sec-section + .sec-section {
  border-top: 1px solid var(--border);
}

.sec-section-label {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--accent-section, var(--accent));
  letter-spacing: 0.12em;
  text-transform: uppercase;
  margin-bottom: 0.75rem;
}

.sec-section-title {
  font-family: var(--font-display);
  font-size: clamp(1.5rem, 3vw, 1.85rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 1.75rem;
  line-height: 1.2;
}

/* ── PRACTICES CARDS ── */
.sec-cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.25rem;
}

.sec-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1.75rem;
  transition: all 0.3s;
  position: relative;
  overflow: hidden;
}

.sec-card::before {
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

.sec-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-glow);
  transform: translateY(-2px);
}

.sec-card:hover::before { opacity: 1; }

.sec-card:nth-child(1)::before { background: var(--accent); }
.sec-card:nth-child(2)::before { background: var(--coral); }
.sec-card:nth-child(3)::before { background: var(--green); }

.sec-card-header {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  margin-bottom: 0.85rem;
}

.sec-card-icon {
  width: 42px;
  height: 42px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2rem;
  flex-shrink: 0;
}

.sec-card-icon-teal { background: var(--accent-bg); color: var(--accent); }
.sec-card-icon-coral { background: var(--coral-bg); color: var(--coral); }
.sec-card-icon-green { background: var(--green-bg); color: var(--green); }

.sec-card h3 {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
}

.sec-card p {
  font-size: 0.92rem;
  color: var(--text-secondary);
  line-height: 1.75;
}

/* ── INFRASTRUCTURE LIST ── */
.sec-infra-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.25rem;
}

.sec-infra-item {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 1.5rem;
  transition: all 0.3s;
}

.sec-infra-item:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-sm);
  transform: translateY(-2px);
}

.sec-infra-item h4 {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.sec-infra-item h4 .sec-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.sec-infra-item p {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.7;
  padding-left: 1.55rem;
}

.sec-infra-note {
  margin-top: 1.25rem;
  padding: 1rem 1.25rem;
  background: var(--accent-bg);
  border-radius: var(--radius-md);
  border-left: 3px solid var(--accent);
  font-size: 0.9rem;
  color: var(--text-secondary);
  font-weight: 500;
}

/* ── COMPLIANCE TIMELINE ── */
.sec-timeline {
  position: relative;
  padding-left: 2rem;
}

.sec-timeline::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--border);
  border-radius: 1px;
}

.sec-timeline-item {
  position: relative;
  padding-bottom: 2rem;
}

.sec-timeline-item:last-child {
  padding-bottom: 0;
}

.sec-timeline-item::before {
  content: '';
  position: absolute;
  left: -2rem;
  top: 6px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  background: var(--bg-primary);
  z-index: 1;
}

.sec-timeline-item.sec-tl-active::before {
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-bg);
}

.sec-timeline-date {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--accent);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 0.3rem;
}

.sec-timeline-title {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 0.15rem;
}

.sec-timeline-desc {
  font-size: 0.88rem;
  color: var(--text-secondary);
  line-height: 1.6;
}

/* ── DISCLOSURE BOX ── */
.sec-disclosure {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 2rem;
}

.sec-disclosure p {
  font-size: 0.92rem;
  color: var(--text-secondary);
  line-height: 1.75;
  margin-bottom: 1.5rem;
}

.sec-disclosure-details {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.sec-detail-item {
  padding: 1rem;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
}

.sec-detail-label {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 0.35rem;
}

.sec-detail-value {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text-primary);
}

.sec-detail-value a {
  color: var(--accent);
  transition: color 0.2s;
}

.sec-detail-value a:hover {
  color: var(--accent-hover);
  text-decoration: underline;
}

/* ── DATA HANDLING ── */
.sec-data-block {
  margin-bottom: 2rem;
}

.sec-data-block:last-child {
  margin-bottom: 0;
}

.sec-data-block h4 {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.sec-data-block ul {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-left: 0;
}

.sec-data-block li {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.6;
  padding-left: 1.35rem;
  position: relative;
}

.sec-data-block li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.55em;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.sec-collect li::before { background: var(--accent); }
.sec-no-collect li::before { background: var(--green); }
.sec-retention li::before { background: var(--amber); }

.sec-data-bg {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 2rem;
}

/* ── CTA ── */
.sec-cta {
  text-align: center;
  padding: 3rem 0;
  border-top: 1px solid var(--border);
}

.sec-cta-buttons {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  flex-wrap: wrap;
}

/* ── RESPONSIVE ── */
@media (max-width: 768px) {
  .sec-infra-list { grid-template-columns: 1fr; }
}

/* ── Light theme glass effects ── */
[data-theme="light"] .sec-card,
[data-theme="light"] .sec-infra-item,
[data-theme="light"] .sec-disclosure,
[data-theme="light"] .sec-data-bg {
  background: rgba(255,255,255,0.6);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-color: rgba(226,221,213,0.5);
  box-shadow: 0 4px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.9);
}
[data-theme="light"] .sec-card:hover,
[data-theme="light"] .sec-infra-item:hover {
  box-shadow: 0 8px 32px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.9);
  border-color: rgba(226,221,213,0.7);
}

@media (max-width: 640px) {
  .sec-hero { padding: 5rem 0 2rem; }
  .sec-section { padding: 2rem 0; }
  .sec-disclosure-details { grid-template-columns: 1fr; }
  .sec-body { padding: 0 1.25rem; }
  .sec-cta { padding: 2rem 0; }
}
</style>

<!-- ═══════════════════════════ HERO ═══════════════════════════ -->
<section class="sec-hero">
  <div class="sec-body">
    <h1>Security &amp; Trust</h1>
    <p>How we protect your data and our platform.</p>
  </div>
</section>

<hr class="tr-divider">

<div class="sec-body">

  <!-- ═══════════════════ SECURITY PRACTICES ═══════════════════ -->
  <div class="sec-section">
    <div class="sec-section-label">Security Practices</div>
    <h2 class="sec-section-title">Built with security at every layer</h2>

    <div class="sec-cards">
      <div class="sec-card">
        <div class="sec-card-header">
          <div class="sec-card-icon sec-card-icon-teal">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h3>Data Encryption</h3>
        </div>
        <p>All data encrypted at rest (D1) and in transit (TLS 1.3). API keys stored as hashed secrets.</p>
      </div>

      <div class="sec-card">
        <div class="sec-card-header">
          <div class="sec-card-icon sec-card-icon-coral">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h3>Access Control</h3>
        </div>
        <p>JWT-based authentication with short-lived tokens. Role-based access control for multi-tenant isolation.</p>
      </div>

      <div class="sec-card">
        <div class="sec-card-header">
          <div class="sec-card-icon sec-card-icon-green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          </div>
          <h3>Audit Logging</h3>
        </div>
        <p>All API access and administrative actions logged. Tamper-resistant audit trail for compliance.</p>
      </div>
    </div>
  </div>

  <!-- ═══════════════════ INFRASTRUCTURE ═══════════════════ -->
  <div class="sec-section">
    <div class="sec-section-label">Infrastructure</div>
    <h2 class="sec-section-title">Edge-native, zero-trust architecture</h2>

    <div class="sec-infra-list">
      <div class="sec-infra-item">
        <h4><span class="sec-dot" style="background:var(--accent)"></span>Edge Compute Workers</h4>
        <p>Edge-native, no traditional servers to compromise. Zero cold starts, global distribution.</p>
      </div>
      <div class="sec-infra-item">
        <h4><span class="sec-dot" style="background:var(--accent)"></span>D1 Database</h4>
        <p>SQLite-based, encrypted at rest, automatic backups.</p>
      </div>
      <div class="sec-infra-item">
        <h4><span class="sec-dot" style="background:var(--green)"></span>KV Cache</h4>
        <p>Encrypted, distributed, automatic TTL-based expiry.</p>
      </div>
    </div>

    <div class="sec-infra-note">No customer data leaves our processing network.</div>
  </div>

  <!-- ═══════════════════ COMPLIANCE ROADMAP ═══════════════════ -->
  <div class="sec-section">
    <div class="sec-section-label">Compliance Roadmap</div>
    <h2 class="sec-section-title">Our path to certification</h2>

    <div class="sec-timeline">
      <div class="sec-timeline-item">
        <div class="sec-timeline-date">Q3 2026</div>
        <div class="sec-timeline-title">SOC 2 Type I Audit</div>
        <div class="sec-timeline-desc">Initial assessment of security controls design and implementation.</div>
      </div>
      <div class="sec-timeline-item">
        <div class="sec-timeline-date">Q1 2027</div>
        <div class="sec-timeline-title">SOC 2 Type II Certification</div>
        <div class="sec-timeline-desc">Full certification demonstrating operational effectiveness over time.</div>
      </div>
      <div class="sec-timeline-item sec-tl-active">
        <div class="sec-timeline-date">Ongoing</div>
        <div class="sec-timeline-title">PIPEDA Compliance</div>
        <div class="sec-timeline-desc">Adherence to PIPEDA (Personal Information Protection and Electronic Documents Act).</div>
      </div>
      <div class="sec-timeline-item sec-tl-active">
        <div class="sec-timeline-date">Ongoing</div>
        <div class="sec-timeline-title">GDPR Readiness</div>
        <div class="sec-timeline-desc">Data processing practices aligned with EU General Data Protection Regulation requirements.</div>
      </div>
      <div class="sec-timeline-item sec-tl-active">
        <div class="sec-timeline-date">Ongoing</div>
        <div class="sec-timeline-title">WCAG 2.1 Level AA</div>
        <div class="sec-timeline-desc">Averrow is committed to WCAG 2.1 Level AA accessibility across all public-facing pages and the authenticated dashboard.</div>
      </div>
    </div>
  </div>

  <!-- ═══════════════════ RESPONSIBLE DISCLOSURE ═══════════════════ -->
  <div class="sec-section">
    <div class="sec-section-label">Responsible Disclosure</div>
    <h2 class="sec-section-title">We welcome security researchers</h2>

    <div class="sec-disclosure">
      <p>We believe that working with skilled security researchers is essential to keeping our platform and users safe. If you discover a vulnerability in Averrow, we encourage you to report it responsibly. We are committed to investigating all legitimate reports and resolving issues as quickly as possible.</p>
      <p>We provide a safe harbor for good-faith security researchers. We will not pursue legal action against individuals who discover and report vulnerabilities responsibly, provided they make a good-faith effort to avoid privacy violations, data destruction, and service disruption.</p>

      <div class="sec-disclosure-details">
        <div class="sec-detail-item">
          <div class="sec-detail-label">Report to</div>
          <div class="sec-detail-value"><a href="mailto:security@averrow.com">security@averrow.com</a></div>
        </div>
        <div class="sec-detail-item">
          <div class="sec-detail-label">Response time</div>
          <div class="sec-detail-value">Within 48 hours</div>
        </div>
      </div>

      <p style="margin-top:1.25rem;font-size:0.88rem;color:var(--text-secondary);">
        <strong style="color:var(--text-primary);">Reporting brand abuse rather than a vulnerability?</strong>
        Forward phishing emails or report impersonation, lookalike domains, and counterfeits at <a href="/report-abuse">averrow.com/report-abuse</a>.
      </p>
    </div>
  </div>

  <!-- ═══════════════════ DATA HANDLING ═══════════════════ -->
  <div class="sec-section">
    <div class="sec-section-label">Data Handling</div>
    <h2 class="sec-section-title">What we collect and what we don't</h2>

    <div class="sec-data-bg">
      <div class="sec-data-block sec-collect">
        <h4><span style="color:var(--accent);">&#9679;</span> What data we collect</h4>
        <ul>
          <li>Domain names</li>
          <li>Email security records (public DNS)</li>
          <li>Social platform public profiles</li>
          <li>Threat feed matches</li>
        </ul>
      </div>

      <div class="sec-data-block sec-no-collect" style="margin-top:2rem;">
        <h4><span style="color:var(--green);">&#9679;</span> What we DON'T collect</h4>
        <ul>
          <li>Email content</li>
          <li>Credentials</li>
          <li>Internal network data</li>
          <li>Customer PII beyond account info</li>
        </ul>
      </div>

      <div class="sec-data-block sec-retention" style="margin-top:2rem;">
        <h4><span style="color:var(--amber);">&#9679;</span> Retention</h4>
        <ul>
          <li>Active account data retained during subscription</li>
          <li>Scan results cached 24 hours</li>
          <li>Account deletion within 30 days of request</li>
        </ul>
      </div>
    </div>
  </div>

</div>

<!-- ═══════════════════════════ CTA ═══════════════════════════ -->
<div class="sec-body">
  <div class="sec-cta">
    <div class="sec-cta-buttons">
      <a href="/privacy" class="btn btn-primary btn-lg">Read our Privacy Policy</a>
      <a href="mailto:security@averrow.com" class="btn btn-outline btn-lg">Contact Security Team</a>
    </div>
  </div>
</div>
`;

  return wrapPage(
    'Security & Trust — Averrow',
    'Learn how our brand protection platform safeguards your data with encryption, access controls, audit logging, and edge-native infrastructure.',
    content + generateSpiderTraps("averrow.com", "security")
  );
}
