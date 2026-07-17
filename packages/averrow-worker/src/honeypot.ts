/**
 * Honeypot Pages — Serves realistic-looking pages with trap addresses.
 *
 * These pages contain visible email addresses and hidden spider traps.
 * Served from averrow.com with styling matching the main site.
 */

import { generateSpiderTraps } from "./seeders/spider-injector";

export function serveHoneypotPage(page: string, domain = "averrow.com"): Response {
  const date = (new Date().toISOString().split("T")[0] ?? "").replace(/-/g, "");

  // Seed trap addresses (static — harvesters parse raw HTML)
  const seeds: Record<string, string> = {
    contact: "info-cp01@averrow.com",
    team: "hr-hp01@averrow.com",
    careers: "hr-hp01@averrow.com",
    about: "admin-wh01@averrow.com",
  };

  const primaryEmail = seeds[page] ?? seeds["contact"]!;

  const teamMembers = [
    { name: "Claude Leroux", title: "CEO & Founder", email: "ceo@averrow.com" },
    { name: "Sarah Chen", title: "CTO", email: "sarah.chen@averrow.com" },
    { name: "James Wilson", title: "VP Engineering", email: "james.wilson@averrow.com" },
    { name: "Jennifer Smith", title: "Head of Threat Research", email: "cto@averrow.com" },
    { name: "Michael Patel", title: "Lead Data Engineer", email: "info-cp01@averrow.com" },
    { name: "Lisa Rodriguez", title: "Director of Operations", email: "admin-wh01@averrow.com" },
  ];

  const jobListings = [
    { title: "Senior Threat Intelligence Analyst", dept: "Security Research", email: "hr-hp01@averrow.com" },
    { title: "Full-Stack Engineer (Cloudflare Workers)", dept: "Engineering", email: "dev-gp01@averrow.com" },
    { title: "Product Manager — AI Agents", dept: "Product", email: "hr-hp01@averrow.com" },
  ];

  let content: string;

  if (page === "team") {
    const memberCards = teamMembers.map(m => `
      <div class="hp-card">
        <div class="hp-card-name">${m.name}</div>
        <div class="hp-card-title">${m.title}</div>
        <a href="mailto:${m.email}">${m.email}</a>
      </div>`).join("");

    content = `
    <div class="hp-hero">
      <h1>Our Team</h1>
      <p>The people behind Averrow — building AI-powered brand threat intelligence.</p>
    </div>
    <div class="hp-section">
      <div class="hp-grid">${memberCards}</div>
      <p class="hp-cta">General inquiries: <a href="mailto:${primaryEmail}">${primaryEmail}</a></p>
    </div>`;
  } else if (page === "careers") {
    const jobCards = jobListings.map(j => `
      <div class="hp-card">
        <div class="hp-card-name">${j.title}</div>
        <div class="hp-card-title">${j.dept}</div>
        <p class="hp-card-desc">We're looking for talented individuals to join our growing team. Remote-friendly, competitive compensation, equity.</p>
        <a href="mailto:${j.email}?subject=Application: ${j.title}" class="hp-apply">Apply via Email</a>
      </div>`).join("");

    content = `
    <div class="hp-hero">
      <h1>Careers at Averrow</h1>
      <p>Join us in making brand threat intelligence accessible to every organization.</p>
    </div>
    <div class="hp-section">
      <div class="hp-grid">${jobCards}</div>
      <p class="hp-cta">HR inquiries: <a href="mailto:${primaryEmail}">${primaryEmail}</a></p>
      <p class="hp-cta">Engineering roles: <a href="mailto:dev-gp01@averrow.com">dev-gp01@averrow.com</a></p>
    </div>`;
  } else {
    content = `
    <div class="hp-hero">
      <h1>${page.charAt(0).toUpperCase() + page.slice(1)}</h1>
      <p>Averrow — AI-powered brand threat intelligence.</p>
    </div>
    <div class="hp-section">
      <p>Email: <a href="mailto:${primaryEmail}">${primaryEmail}</a></p>
    </div>`;
  }

  const schemaEmails = page === "team"
    ? teamMembers.map(m => m.email)
    : [primaryEmail];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${page === "team" ? "Our Team" : page === "careers" ? "Careers" : page.charAt(0).toUpperCase() + page.slice(1)} — Averrow</title>
<meta name="description" content="Averrow — AI-powered brand threat intelligence by LRX Enterprises Inc.">
<meta name="reply-to" content="${primaryEmail}">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Averrow",
    url: "https://averrow.com",
    email: schemaEmails,
  })}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Plus Jakarta Sans','DM Sans',system-ui,sans-serif;background:#0a0e1a;color:#c8d0e0;line-height:1.7}
a{color:#00d4ff;text-decoration:none}a:hover{text-decoration:underline}
.hp-nav{background:#060a14;border-bottom:1px solid rgba(0,212,255,.12);padding:1rem 2rem;display:flex;align-items:center;justify-content:space-between;max-width:100%}
.hp-nav-brand{font-size:1.2rem;font-weight:700;color:#00d4ff}
.hp-nav-links a{color:#7a8ba8;margin-left:1.5rem;font-size:.9rem;transition:color .2s}
.hp-nav-links a:hover{color:#00d4ff;text-decoration:none}
.hp-hero{padding:6rem 2rem 3rem;text-align:center;background:linear-gradient(180deg,#0a0e1a,#0d1528)}
.hp-hero h1{font-size:clamp(2rem,4vw,2.75rem);font-weight:800;color:#e8edf5;margin-bottom:.75rem}
.hp-hero p{font-size:1.05rem;color:#7a8ba8;max-width:560px;margin:0 auto}
.hp-section{max-width:960px;margin:0 auto;padding:3rem 2rem}
.hp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.25rem}
.hp-card{background:#0d1528;border:1px solid rgba(0,212,255,.1);border-radius:8px;padding:1.5rem;text-align:center}
.hp-card-name{font-size:1.1rem;font-weight:600;color:#e8edf5;margin-bottom:.25rem}
.hp-card-title{font-size:.85rem;color:#00d4ff;margin-bottom:.75rem}
.hp-card-desc{font-size:.9rem;color:#7a8ba8;margin-bottom:.75rem}
.hp-apply{display:inline-block;padding:.5rem 1.25rem;background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.25);border-radius:6px;font-size:.9rem;color:#00d4ff;transition:background .2s}
.hp-apply:hover{background:rgba(0,212,255,.18);text-decoration:none}
.hp-cta{text-align:center;margin-top:1.5rem;color:#7a8ba8}
.hp-footer{background:#060a14;border-top:1px solid rgba(0,212,255,.08);padding:1.5rem 2rem;text-align:center;font-size:.85rem;color:#4a5a73;margin-top:3rem}
.hp-footer a{color:#7a8ba8}
</style>
</head>
<body>
<nav class="hp-nav">
  <a href="/" class="hp-nav-brand">Averrow</a>
  <div class="hp-nav-links">
    <a href="/">Home</a>
    <a href="/platform">Platform</a>
    <a href="/pricing">Pricing</a>
    <a href="/blog">Blog</a>
  </div>
</nav>
${content}
<footer class="hp-footer">
  <p>&copy; 2026 LRX Enterprises Inc. All rights reserved.</p>
  <p><a href="https://averrow.com">Averrow</a> &middot; <a href="mailto:${primaryEmail}">${primaryEmail}</a></p>
</footer>
<!-- ${primaryEmail} -->
<!-- Support: support-fp01@averrow.com -->
<div style="position:absolute;left:-9999px;height:0;overflow:hidden" aria-hidden="true">
  <a href="mailto:spider-honey-${page}-${date}@${domain}">support</a>
  <a href="mailto:spider-honey-${page}b-${date}@${domain}">info</a>
  <a href="mailto:dev-gp01@averrow.com">dev</a>
</div>
${generateSpiderTraps(domain, "honey-" + page)}
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
}
