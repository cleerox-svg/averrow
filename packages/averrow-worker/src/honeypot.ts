/**
 * Honeypot Pages — Serves pages that publish spam-trap addresses.
 *
 * These pages contain visible email addresses and hidden spider traps.
 *
 * Where they are reachable: src/index.ts sends /team and /careers here on
 * the platform hostnames, and routes/public.ts has a /team fallback. In
 * practice only averrow.com/team gets this page: averrow.ca and
 * trustradar.ca 301 to averrow.com first, lrxradar.com serves its own
 * honeypot site, and averrow.com/careers is answered by the marketing
 * site's static /careers redirect (Worker assets match before the Worker's
 * fetch handler runs), so the /careers branch below is effectively unused.
 * Visits are logged to honeypot_visits.
 *
 * How the trap works: an email harvester scrapes the addresses below. Mail
 * later sent to any of them must reach the Worker's email() handler, which
 * hands it to src/spam-trap.ts: that records it in spam_trap_captures with
 * a channel parsed from the local part (`hr-hp01` → honeypot, `info-cp01` →
 * contact_page, `spider-…` → spider) and bumps seed_addresses.total_catches.
 * The date-stamped `spider-honey-<page>-<yyyymmdd>` addresses tell us WHEN
 * an address was harvested.
 *
 * Mail domain: the addresses are built on a domain whose MX is Cloudflare
 * Email Routing with a catch-all to the Worker — averrow.ca, trustradar.ca
 * or lrxradar.com (docs/EMAIL_ROUTING_RUNBOOK.md,
 * docs/SPAM_TRAP_ASSESSMENT_2026-09.md). NEVER averrow.com: its MX is Google
 * Workspace, which rejects unknown users (550), so a trap there never
 * reaches the Worker. A page served on averrow.com therefore publishes
 * averrow.ca addresses (trapMailDomain).
 *
 * /team (DISCLOSURE_REGISTER G37, owner decision 2026-10-06): the page used
 * to present invented people as the Averrow team. It now names no people,
 * titles or bios and does not claim to be a team page: it is a neutral
 * mailbox listing whose visible text tells a human to use /contact. Every
 * page served here carries `<meta name="robots" content="noindex,nofollow">`
 * plus an `X-Robots-Tag` header, is not in the sitemap, and is deliberately
 * NOT in robots.txt (that would advertise it). The old page published
 * @averrow.com addresses (ceo@, cto@, sarah.chen@, james.wilson@, …); those
 * never reached the trap, for the Workspace reason above.
 */

import { generateSpiderTraps } from "./seeders/spider-injector";

/** Header value for every honeypot page: keep it out of search and AI indexes. */
export const HONEYPOT_X_ROBOTS_TAG = "noindex, nofollow";

/** Domains whose MX is Cloudflare Email Routing with a catch-all to the Worker. */
export const WORKER_ROUTED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "averrow.ca",
  "trustradar.ca",
  "lrxradar.com",
]);
/** Default trap mail domain (EMAIL_ROUTING_RUNBOOK.md: averrow.ca). */
export const DEFAULT_TRAP_MAIL_DOMAIN = "averrow.ca";

/**
 * The mail domain for trap addresses on a page served at `webDomain`: the
 * same domain when its mail reaches the Worker, otherwise averrow.ca.
 */
export function trapMailDomain(webDomain: string): string {
  const d = webDomain.toLowerCase().replace(/^www\./, "");
  return WORKER_ROUTED_MAIL_DOMAINS.has(d) ? d : DEFAULT_TRAP_MAIL_DOMAIN;
}

export function serveHoneypotPage(page: string, domain = "averrow.com"): Response {
  const date = (new Date().toISOString().split("T")[0] ?? "").replace(/-/g, "");
  const mail = trapMailDomain(domain);

  // Seed trap addresses (static — harvesters parse raw HTML)
  const seeds: Record<string, string> = {
    contact: `info-cp01@${mail}`,
    team: `hr-hp01@${mail}`,
    careers: `hr-hp01@${mail}`,
    about: `admin-wh01@${mail}`,
  };

  const primaryEmail = seeds[page] ?? seeds["contact"]!;

  // /team mailbox listing: seed-format trap addresses only. No personal
  // names (not even in the local part) and no role mailboxes (ceo@, cto@)
  // that a real visitor could mistake for a way to reach a person.
  const directoryAddresses = [
    { label: "Routing", email: `hr-hp01@${mail}` },
    { label: "Inbound", email: `info-cp01@${mail}` },
    { label: "Registrar records", email: `admin-wh01@${mail}` },
  ];

  const jobListings = [
    { title: "Senior Threat Intelligence Analyst", dept: "Security Research", email: `hr-hp01@${mail}` },
    { title: "Full-Stack Engineer (Cloudflare Workers)", dept: "Engineering", email: `dev-gp01@${mail}` },
    { title: "Product Manager — AI Agents", dept: "Product", email: `hr-hp01@${mail}` },
  ];

  let content: string;

  if (page === "team") {
    const rows = directoryAddresses.map(d => `
      <div class="hp-card">
        <div class="hp-card-title">${d.label}</div>
        <a href="mailto:${d.email}">${d.email}</a>
      </div>`).join("");

    content = `
    <div class="hp-hero">
      <h1>Mailbox directory</h1>
      <p>Automated routing addresses. These mailboxes are not read by people.</p>
    </div>
    <div class="hp-section">
      <div class="hp-grid">${rows}</div>
      <p class="hp-cta">To reach Averrow, use the <a href="/contact">contact form</a>.</p>
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
      <p class="hp-cta">Engineering roles: <a href="mailto:dev-gp01@${mail}">dev-gp01@${mail}</a></p>
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
    ? directoryAddresses.map(d => d.email)
    : [primaryEmail];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>${page === "team" ? "Mailbox directory" : page === "careers" ? "Careers" : page.charAt(0).toUpperCase() + page.slice(1)} — Averrow</title>
<meta name="description" content="${page === "team" ? "Automated mailbox directory." : "Averrow — AI-powered brand threat intelligence by LRX Enterprises Inc."}">
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
<!-- Support: support-fp01@${mail} -->
<div style="position:absolute;left:-9999px;height:0;overflow:hidden" aria-hidden="true">
  <a href="mailto:spider-honey-${page}-${date}@${mail}">support</a>
  <a href="mailto:spider-honey-${page}b-${date}@${mail}">info</a>
  <a href="mailto:dev-gp01@${mail}">dev</a>
</div>
${generateSpiderTraps(mail, "honey-" + page)}
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-Robots-Tag": HONEYPOT_X_ROBOTS_TAG,
    },
  });
}
