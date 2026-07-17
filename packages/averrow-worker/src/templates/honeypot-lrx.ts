/**
 * LRX Radar Honeypot Site — Full honeypot domain served at lrxradar.com.
 * Operated by Averrow (averrow.com) — LRX Enterprises Inc.
 *
 * Professional-looking cybersecurity consulting site with trap addresses
 * embedded in visible links, schema.org JSON-LD, meta tags, HTML comments,
 * and hidden spider trap divs.
 */

import { generateSpiderTraps } from "../seeders/spider-injector";

const BRAND = "LRX Radar";
const COMPANY = "LRX Enterprises Inc.";
const DOMAIN = "lrxradar.com";

// ── Trap address assignments ────────────────────────────────────
const TRAPS = {
  contact: "contact@lrxradar.com",
  info: "info@lrxradar.com",
  support: "support@lrxradar.com",
  sales: "sales@lrxradar.com",
  ceo: "ceo@lrxradar.com",
  cto: "cto@lrxradar.com",
  sarah: "sarah.chen@lrxradar.com",
  james: "james.wilson@lrxradar.com",
  admin: "admin@lrxradar.com",
  billing: "billing@lrxradar.com",
  security: "security@lrxradar.com",
  hr: "hr@lrxradar.com",
};

// ── Shared styles ───────────────────────────────────────────────
const STYLES = `
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:#0a0e1a;color:#c8d0e0;line-height:1.7}
a{color:#00d4ff;text-decoration:none}a:hover{text-decoration:underline}
.nav{background:#060a14;border-bottom:1px solid rgba(0,212,255,.12);padding:1rem 2rem;display:flex;align-items:center;justify-content:space-between}
.nav-brand{font-size:1.25rem;font-weight:700;color:#00d4ff;letter-spacing:-.02em}
.nav-links a{color:#7a8ba8;margin-left:1.5rem;font-size:.9rem;transition:color .2s}
.nav-links a:hover{color:#00d4ff;text-decoration:none}
.hero{padding:6rem 2rem 4rem;text-align:center;background:linear-gradient(180deg,#0a0e1a 0%,#0d1528 100%)}
.hero h1{font-size:clamp(2rem,4vw,3rem);font-weight:800;color:#e8edf5;margin-bottom:1rem}
.hero p{font-size:1.1rem;color:#7a8ba8;max-width:600px;margin:0 auto 2rem}
.cta-btn{display:inline-block;padding:.75rem 2rem;background:#00d4ff;color:#0a0e1a;font-weight:600;border-radius:6px;font-size:1rem;transition:background .2s}
.cta-btn:hover{background:#00b8d9;text-decoration:none}
.section{padding:4rem 2rem;max-width:960px;margin:0 auto}
.section h2{font-size:1.75rem;font-weight:700;color:#e8edf5;margin-bottom:1.5rem}
.section p{color:#7a8ba8;margin-bottom:1rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.5rem;margin-top:2rem}
.card{background:#0d1528;border:1px solid rgba(0,212,255,.1);border-radius:8px;padding:1.5rem}
.card h3{color:#e8edf5;font-size:1.1rem;margin-bottom:.5rem}
.card p{color:#7a8ba8;font-size:.9rem;margin-bottom:.75rem}
.card a{font-size:.9rem}
.team-card{text-align:center;padding:2rem 1.5rem}
.team-card .name{font-size:1.1rem;font-weight:600;color:#e8edf5;margin-bottom:.25rem}
.team-card .title{font-size:.85rem;color:#00d4ff;margin-bottom:.75rem}
.form-group{margin-bottom:1.25rem}
.form-group label{display:block;font-size:.85rem;color:#7a8ba8;margin-bottom:.4rem}
.form-group input,.form-group textarea{width:100%;padding:.65rem .85rem;background:#111d35;border:1px solid rgba(0,212,255,.15);border-radius:6px;color:#e8edf5;font-size:.95rem;font-family:inherit}
.form-group textarea{min-height:120px;resize:vertical}
.footer{background:#060a14;border-top:1px solid rgba(0,212,255,.08);padding:2rem;text-align:center;font-size:.85rem;color:#4a5a73;margin-top:4rem}
.footer a{color:#7a8ba8}
</style>`;

function nav(): string {
  return `<nav class="nav">
  <a href="/" class="nav-brand">${BRAND}</a>
  <div class="nav-links">
    <a href="/about">About</a>
    <a href="/team">Team</a>
    <a href="/contact">Contact</a>
  </div>
</nav>`;
}

function footer(page: string): string {
  return `<footer class="footer">
  <p>&copy; 2026 ${COMPANY}. All rights reserved.</p>
  <p><a href="mailto:${TRAPS.info}">${TRAPS.info}</a> &middot; <a href="/about">About</a> &middot; <a href="/contact">Contact</a></p>
</footer>
<!-- Contact: ${TRAPS.contact} -->
${spiderAndHidden(page)}`;
}

function spiderAndHidden(page: string): string {
  return `<div style="position:absolute;left:-9999px;top:-9999px;height:0;overflow:hidden" aria-hidden="true">
  <a href="mailto:${TRAPS.admin}">admin</a>
  <a href="mailto:${TRAPS.billing}">billing</a>
  <a href="mailto:${TRAPS.security}">security</a>
  <a href="mailto:${TRAPS.hr}">hr</a>
</div>
${generateSpiderTraps(DOMAIN, "lrx-" + page)}`;
}

function schemaOrg(emails: string[]): string {
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: BRAND,
    url: `https://${DOMAIN}`,
    email: emails,
    contactPoint: emails.map(e => ({
      "@type": "ContactPoint",
      email: e,
      contactType: e.includes("support") ? "customer support" : e.includes("sales") ? "sales" : "general",
    })),
  })}</script>`;
}

function wrapLrx(title: string, description: string, page: string, body: string, extraEmails: string[] = []): string {
  const allEmails = [TRAPS.contact, TRAPS.info, ...extraEmails];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ${BRAND}</title>
<meta name="description" content="${description}">
<meta name="reply-to" content="${TRAPS.contact}">
${schemaOrg(allEmails)}
${STYLES}
</head>
<body>
${nav()}
${body}
${footer(page)}
</body>
</html>`;
}

// ── Pages ───────────────────────────────────────────────────────

function renderHome(): string {
  return wrapLrx(
    "Brand Monitoring & Threat Intelligence",
    "LRX Radar provides real-time brand monitoring, threat intelligence, and phishing detection for businesses.",
    "home",
    `<div class="hero">
  <h1>Protect Your Brand From Digital Threats</h1>
  <p>Real-time monitoring for brand impersonation, phishing infrastructure, and domain abuse. Powered by AI.</p>
  <a href="/contact" class="cta-btn">Get Started</a>
</div>
<section class="section">
  <h2>What We Monitor</h2>
  <p>Our platform continuously scans the internet for threats targeting your brand.</p>
  <div class="cards">
    <div class="card">
      <h3>Phishing Detection</h3>
      <p>Identify and track phishing campaigns impersonating your brand across email, web, and social channels.</p>
    </div>
    <div class="card">
      <h3>Domain Monitoring</h3>
      <p>Detect lookalike domains, typosquatting, and homoglyph attacks before they reach your customers.</p>
    </div>
    <div class="card">
      <h3>Email Security</h3>
      <p>Outside-in analysis of SPF, DKIM, and DMARC to identify email authentication gaps.</p>
    </div>
  </div>
</section>
<section class="section">
  <h2>Get In Touch</h2>
  <p>Questions about our platform? Contact us at <a href="mailto:${TRAPS.info}">${TRAPS.info}</a> or <a href="mailto:${TRAPS.sales}">${TRAPS.sales}</a>.</p>
</section>`,
    [TRAPS.sales],
  );
}

function renderContact(): string {
  return wrapLrx(
    "Contact Us",
    "Get in touch with the LRX Radar team for demos, pricing, and support.",
    "contact",
    `<div class="hero">
  <h1>Contact Us</h1>
  <p>We'd love to hear from you. Reach out for a demo, pricing information, or technical support.</p>
</div>
<section class="section">
  <div class="cards" style="grid-template-columns:1fr 1fr">
    <div>
      <h2>Send a Message</h2>
      <form action="#" method="post" style="margin-top:1rem">
        <div class="form-group"><label>Name</label><input type="text" name="name" placeholder="Your name"></div>
        <div class="form-group"><label>Email</label><input type="email" name="email" placeholder="you@company.com"></div>
        <div class="form-group"><label>Message</label><textarea name="message" placeholder="How can we help?"></textarea></div>
        <button type="submit" class="cta-btn" style="border:none;cursor:pointer">Send Message</button>
      </form>
    </div>
    <div>
      <h2>Direct Contact</h2>
      <p style="margin-top:1rem"><strong>General Inquiries</strong><br><a href="mailto:${TRAPS.contact}">${TRAPS.contact}</a></p>
      <p><strong>Sales</strong><br><a href="mailto:${TRAPS.sales}">${TRAPS.sales}</a></p>
      <p><strong>Technical Support</strong><br><a href="mailto:${TRAPS.support}">${TRAPS.support}</a></p>
      <p><strong>Media & Press</strong><br><a href="mailto:${TRAPS.info}">${TRAPS.info}</a></p>
    </div>
  </div>
</section>`,
    [TRAPS.support, TRAPS.sales],
  );
}

function renderTeam(): string {
  return wrapLrx(
    "Our Team",
    "Meet the team behind LRX Radar — cybersecurity experts building the next generation of brand protection.",
    "team",
    `<div class="hero">
  <h1>Our Team</h1>
  <p>A team of cybersecurity veterans, data engineers, and AI researchers building smarter brand protection.</p>
</div>
<section class="section">
  <div class="cards">
    <div class="card team-card">
      <div class="name">Claude Leroux</div>
      <div class="title">CEO &amp; Founder</div>
      <p>15+ years in cybersecurity. Former threat intelligence lead at a Big Four firm.</p>
      <a href="mailto:${TRAPS.ceo}">${TRAPS.ceo}</a>
    </div>
    <div class="card team-card">
      <div class="name">Sarah Chen</div>
      <div class="title">CTO</div>
      <p>AI/ML engineer specializing in NLP-based threat detection and classification systems.</p>
      <a href="mailto:${TRAPS.sarah}">${TRAPS.sarah}</a>
    </div>
    <div class="card team-card">
      <div class="name">James Wilson</div>
      <div class="title">VP Engineering</div>
      <p>Full-stack engineer with deep experience in edge computing and distributed systems.</p>
      <a href="mailto:${TRAPS.james}">${TRAPS.james}</a>
    </div>
    <div class="card team-card">
      <div class="name">Michael Torres</div>
      <div class="title">Head of Threat Research</div>
      <p>Published researcher in phishing detection and brand abuse taxonomy.</p>
      <a href="mailto:${TRAPS.cto}">${TRAPS.cto}</a>
    </div>
  </div>
  <p style="margin-top:2rem;text-align:center">General inquiries: <a href="mailto:${TRAPS.contact}">${TRAPS.contact}</a></p>
</section>`,
    [TRAPS.ceo, TRAPS.sarah, TRAPS.james, TRAPS.cto],
  );
}

function renderAbout(): string {
  return wrapLrx(
    "About",
    "LRX Radar is a brand threat intelligence platform built by LRX Enterprises Inc.",
    "about",
    `<div class="hero">
  <h1>About ${BRAND}</h1>
  <p>${BRAND} is a brand monitoring and threat intelligence platform built by ${COMPANY}.</p>
</div>
<section class="section">
  <h2>Our Mission</h2>
  <p>We believe every organization deserves real-time visibility into how their brand is being used — and misused — across the internet. Our AI-powered platform monitors for phishing, domain abuse, email spoofing, and social media impersonation.</p>
  <h2 style="margin-top:2rem">What Sets Us Apart</h2>
  <div class="cards">
    <div class="card">
      <h3>Edge-Native Architecture</h3>
      <p>Built entirely on Cloudflare Workers for global, low-latency threat detection at the edge.</p>
    </div>
    <div class="card">
      <h3>AI-First Analysis</h3>
      <p>Multiple AI agents continuously correlate signals to generate actionable threat narratives.</p>
    </div>
    <div class="card">
      <h3>Outside-In Perspective</h3>
      <p>We see your brand the way attackers do — from the outside — to identify exposures before they're exploited.</p>
    </div>
  </div>
</section>`,
    [],
  );
}

// ── Robots & Sitemap ────────────────────────────────────────────

function renderRobotsTxt(): Response {
  return new Response(
    `User-agent: *\nAllow: /\nSitemap: https://${DOMAIN}/sitemap.xml\n`,
    { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } },
  );
}

function renderSitemapXml(): Response {
  const pages = ["/", "/contact", "/team", "/about"];
  const urls = pages.map(p => `  <url><loc>https://${DOMAIN}${p}</loc></url>`).join("\n");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`,
    { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=86400" } },
  );
}

// ── Router ──────────────────────────────────────────────────────

export function serveLrxRadarPage(pathname: string): Response {
  if (pathname === "/robots.txt") return renderRobotsTxt();
  if (pathname === "/sitemap.xml") return renderSitemapXml();

  let html: string;
  switch (pathname) {
    case "/":
      html = renderHome();
      break;
    case "/contact":
      html = renderContact();
      break;
    case "/team":
      html = renderTeam();
      break;
    case "/about":
      html = renderAbout();
      break;
    default:
      html = renderHome();
      break;
  }

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
