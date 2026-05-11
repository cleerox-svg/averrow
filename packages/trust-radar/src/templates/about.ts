/**
 * Trust Radar — About Page
 * Served at /about
 */
import { wrapPage } from "./shared";
import { generateSpiderTraps } from "../seeders/spider-injector";

export function renderAboutPage(): string {
  return wrapPage(
    "About — Averrow",
    "LRX Enterprises Inc. — Making brand protection accessible. AI-native, edge-first, radically accessible.",
    `
<style>
.about-hero {
  padding: 5rem 0 2.5rem;
  text-align: center;
  background: var(--gradient-hero);
  position: relative;
  overflow: hidden;
}
.about-hero h1 { font-family: var(--font-display); font-size: clamp(36px, 5vw, 64px); font-weight: 800; margin-bottom: 1rem; position: relative; z-index: 2; }
.about-hero p { font-size: 20px; color: var(--text-secondary); max-width: 580px; margin: 0 auto; line-height: 1.7; position: relative; z-index: 2; }
.about-hero .section-label { position: relative; z-index: 2; }

/* Delta-wing watermark behind hero — Avro Arrow heritage cue */
.about-hero-wing {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 1;
  opacity: 0.06;
}
[data-theme="light"] .about-hero-wing { opacity: 0.05; }
.about-hero-wing svg {
  width: min(680px, 90vw);
  height: auto;
}

/* Heritage callout band, sits between hero and Our Story */
.about-heritage {
  max-width: 980px;
  margin: 0 auto;
  padding: 1.75rem 2rem 0;
}
.about-heritage-card {
  display: grid;
  grid-template-columns: 132px 1fr;
  gap: 1.5rem;
  align-items: center;
  padding: 1.5rem 1.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-left: 3px solid var(--amber);
  border-radius: var(--radius-md);
}
.about-heritage-card svg { width: 100%; height: auto; color: var(--amber); }
.about-heritage-text {
  font-family: var(--font-body);
  color: var(--text-secondary);
  font-size: 14.5px;
  line-height: 1.6;
}
.about-heritage-text .ah-eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--amber);
  display: block;
  margin-bottom: 4px;
}
.about-heritage-text strong { color: var(--text-primary); }
@media (max-width: 640px) {
  .about-heritage-card { grid-template-columns: 1fr; text-align: center; }
  .about-heritage-card svg { width: 96px; margin: 0 auto; }
}

.about-section { padding: 3rem 0; }
.about-section:nth-child(even) { background: var(--bg-tertiary); }
.about-content { max-width: 900px; margin: 0 auto; padding: 0 2rem; }
.about-content h2 { font-family: var(--font-display); font-size: clamp(24px, 3vw, 36px); font-weight: 700; margin-bottom: 1rem; }
.about-content p { color: var(--text-secondary); line-height: 1.7; margin-bottom: 1.5rem; font-size: 16px; }

.our-story-container {
  border-left: 3px solid var(--accent);
  border-radius: 0 10px 10px 0;
  padding: 2.5rem 3rem;
}
[data-theme="light"] .our-story-container { background: rgba(200,60,60,0.02); }
[data-theme="dark"] .our-story-container { background: rgba(200,60,60,0.04); }
.our-story-container p:last-child { margin-bottom: 0; }

.principles-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; max-width: 1400px; margin: 0 auto; padding: 0 2rem; }
.principle-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 2rem; position: relative; overflow: hidden; transition: all 0.3s; }
.principle-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; border-radius: var(--radius-lg) var(--radius-lg) 0 0; opacity: 0; transition: opacity 0.3s; }
.principle-card:hover::before { opacity: 1; }
.principle-card:nth-child(1)::before { background: var(--accent); }
.principle-card:nth-child(2)::before { background: var(--coral); }
.principle-card:nth-child(3)::before { background: var(--green); }
.principle-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow-glow); transition: all 0.3s; }
.principle-num { font-family: var(--font-mono); font-size: 0.72rem; font-weight: 600; color: var(--accent-section, var(--accent)); margin-bottom: 0.75rem; }
.principle-card h3 { font-family: var(--font-display); font-size: 1.2rem; font-weight: 700; margin-bottom: 0.75rem; }
.principle-card p { font-size: 0.9rem; color: var(--text-secondary); line-height: 1.65; }

.facts-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; max-width: 1400px; margin: 2rem auto 0; padding: 0 2rem; }
.fact-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 1.25rem; text-align: center; transition: border-color 0.2s; }
.fact-card:hover { border-color: var(--accent); }
.fact-value { font-family: var(--font-display); font-size: 1.1rem; font-weight: 700; margin-bottom: 0.25rem; }
.fact-label { font-size: 0.78rem; color: var(--text-tertiary); }

.tech-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.25rem; max-width: 1400px; margin: 2rem auto 0; padding: 0 2rem; }
.tech-item { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 1.5rem; transition: all 0.3s; }
.tech-item:hover { border-color: var(--accent); box-shadow: var(--shadow-glow); transform: translateY(-2px); }
.tech-name { font-family: var(--font-mono); font-size: 0.82rem; font-weight: 600; color: var(--accent-section, var(--accent)); margin-bottom: 0.35rem; }
.tech-desc { font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5; }

.cta-block { padding: 3rem 0; text-align: center; }
.cta-block h2 { font-family: var(--font-display); font-size: clamp(28px, 3vw, 36px); font-weight: 700; margin-bottom: 1rem; }
.cta-block p { color: var(--text-secondary); max-width: 480px; margin: 0 auto 2rem; }
.cta-actions { display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }

/* ── Light theme glass effects ── */
[data-theme="light"] .principle-card,
[data-theme="light"] .fact-card,
[data-theme="light"] .tech-item {
  background: rgba(255,255,255,0.6);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-color: rgba(226,221,213,0.5);
  box-shadow: 0 4px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.9);
}
[data-theme="light"] .principle-card:hover,
[data-theme="light"] .fact-card:hover,
[data-theme="light"] .tech-item:hover {
  box-shadow: 0 8px 32px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.9);
  border-color: rgba(226,221,213,0.7);
}

@media (max-width: 768px) {
  .principles-grid, .facts-grid { grid-template-columns: 1fr; }
  .tech-grid { grid-template-columns: 1fr; }
}
</style>

<section class="about-hero">
  <!-- Delta-wing watermark — Avro Arrow heritage cue, decorative -->
  <div class="about-hero-wing" aria-hidden="true">
    <svg viewBox="0 0 600 360" xmlns="http://www.w3.org/2000/svg">
      <path d="M300 16 L568 336 L300 296 L32 336 Z" fill="currentColor"/>
    </svg>
  </div>
  <div class="container">
    <div class="section-label" style="text-align:center;">About</div>
    <h1>Built from a heritage of<br>interception.</h1>
    <p>LRX Enterprises Inc. is building the brand protection that every company deserves — not just enterprises with six-figure security budgets.</p>
  </div>
</section>

<!-- Heritage callout — Avro Arrow lift -->
<div class="about-heritage">
  <div class="about-heritage-card">
    <svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <!-- Stylised delta-wing silhouette -->
      <path d="M60 6 L114 74 L60 60 L6 74 Z" fill="currentColor"/>
      <path d="M44 64 L76 64 L72 56 L48 56 Z" fill="var(--bg-secondary)"/>
    </svg>
    <div class="about-heritage-text">
      <span class="ah-eyebrow">1958 &middot; Avro Canada CF-105</span>
      In 1958, Canada built the most advanced interceptor in the world &mdash; the <strong>Avro Arrow</strong>. Averrow carries that legacy into the digital domain. Detect, classify, and neutralize threats crossing into your brand's airspace before they reach their target.
    </div>
  </div>
</div>

<!-- Our Story -->
<section class="about-section">
  <div class="about-content">
    <h2>Our Story</h2>
    <div class="our-story-container">
      <p>Enterprise brand protection platforms cost $20,000 to $150,000+ per year and require dedicated security analysts to operate. Meanwhile, companies of every size &mdash; the ones actually being targeted by phishing campaigns and brand impersonation &mdash; have no affordable option.</p>
      <p>Averrow exists to close that gap. Founded by LRX Enterprises Inc., built AI-native from day one, and deployed on edge infrastructure that keeps costs 10-50x lower than traditional platforms. Every company should be able to see their brand the way attackers do &mdash; and intercept threats before they land.</p>
    </div>
  </div>
</section>

<!-- Principles -->
<section class="about-section" style="text-align:center;">
  <div class="container">
    <div class="section-label" style="text-align:center;">Our Approach</div>
    <h2 style="font-family:var(--font-display);font-size:clamp(24px, 3vw, 36px);font-weight:700;margin-bottom:1.25rem;">Three Principles</h2>
  </div>
  <div class="principles-grid">
    <div class="principle-card">
      <div class="principle-num">01</div>
      <h3>Outside-In First</h3>
      <p>See your brand the way attackers do. Averrow works instantly with zero setup — it scans the open internet and reports what it finds. Optionally connect your security platforms for deeper signal.</p>
    </div>
    <div class="principle-card">
      <div class="principle-num">02</div>
      <h3>AI-Native</h3>
      <p>Intelligence, not alert dumps. AI agents that reason, correlate, and narrate. Built with the most advanced AI available, from the ground up — not bolted on as an afterthought.</p>
    </div>
    <div class="principle-card">
      <div class="principle-num">03</div>
      <h3>Radically Accessible</h3>
      <p>Enterprise intelligence without enterprise pricing. Edge-native architecture keeps infrastructure costs 10-50x lower than traditional security platforms.</p>
    </div>
  </div>
</section>

<!-- Company Facts -->
<section class="about-section" style="text-align:center;">
  <div class="container">
    <h2 style="font-family:var(--font-display);font-size:clamp(24px, 3vw, 36px);font-weight:700;margin-bottom:0.5rem;">Company Facts</h2>
  </div>
  <div class="facts-grid">
    <div class="fact-card"><div class="fact-value">LRX Enterprises Inc.</div><div class="fact-label">Parent company</div></div>
    <div class="fact-card"><div class="fact-value">AI-Native</div><div class="fact-label">Powered by advanced AI agents</div></div>
    <div class="fact-card"><div class="fact-value">Edge-First</div><div class="fact-label">Zero cold starts, globally distributed</div></div>
    <div class="fact-card"><div class="fact-value">6+</div><div class="fact-label">Integrated brand protection feeds</div></div>
    <div class="fact-card"><div class="fact-value">50-66%</div><div class="fact-label">Less than incumbent platforms</div></div>
    <div class="fact-card"><div class="fact-value">Q3 2026</div><div class="fact-label">SOC 2 Type I audit target</div></div>
  </div>
</section>

<!-- Technology -->
<section class="about-section" style="text-align:center;">
  <div class="container">
    <h2 style="font-family:var(--font-display);font-size:clamp(24px, 3vw, 36px);font-weight:700;margin-bottom:0.5rem;">Technology</h2>
    <p style="color:var(--text-secondary);margin-bottom:1rem;">Every choice optimized for performance, reliability, and cost.</p>
  </div>
  <div class="tech-grid">
    <div class="tech-item"><div class="tech-name">Edge Compute Workers</div><div class="tech-desc">Edge-native compute with zero cold starts. Globally distributed, no traditional servers to compromise.</div></div>
    <div class="tech-item"><div class="tech-name">D1 Database</div><div class="tech-desc">SQLite-based, encrypted at rest, automatic backups. Low-cost, high-reliability relational storage.</div></div>
    <div class="tech-item"><div class="tech-name">Advanced AI Agents</div><div class="tech-desc">Multi-signal threat reasoning and natural language narrative generation. Configurable via API key.</div></div>
    <div class="tech-item"><div class="tech-name">KV + R2</div><div class="tech-desc">Distributed caching and object storage. TTL-based expiry, encrypted, globally replicated.</div></div>
  </div>
</section>

<!-- CTA -->
<section class="cta-block">
  <div class="container">
    <h2>See what Averrow can do.</h2>
    <p>Explore the platform or run a free brand exposure scan.</p>
    <div class="cta-actions">
      <a href="/platform" class="btn btn-primary btn-lg">Explore Platform</a>
      <a href="/scan" class="btn btn-outline btn-lg">Free Scan</a>
    </div>
  </div>
</section>
${generateSpiderTraps("averrow.com", "about")}
`
  );
}
