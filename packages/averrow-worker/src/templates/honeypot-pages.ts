/**
 * Averrow — Roster bait pages for spam-trap harvesters.
 *
 * Served at /admin-portal, /internal-staff, /team-directory and
 * /staff-contacts (src/index.ts on averrow.com and lrxradar.com; the first
 * two also from the routes/public.ts fallback). The paths are Disallowed in
 * robots.txt, which is what draws malicious crawlers to them.
 *
 * Each page accepts an optional `roster` of seeded addresses. The live
 * caller passes readRoster() (lib/auto-seeder-planter.ts), so a harvester
 * scraping in week 4 sees a different list than one in week 1. Only
 * role-style mailboxes (`<function>-hp<digits>`, isRoleMailboxAddress) are
 * rendered — never a person-name local part, so legacy `first.last` seeds
 * are skipped. Entries whose domain does not route to the Worker (WORKER_ROUTED_MAIL_DOMAINS —
 * e.g. averrow.com, whose MX is Google Workspace) are dropped: mail to them
 * never reaches the trap. With nothing left, a built-in default roster on
 * the page's trap mail domain (trapMailDomain) is used so the page never
 * renders blank.
 *
 * DISCLOSURE_REGISTER G37 (owner decision 2026-10-06): these pages used to
 * list invented staff ("Robert Taylor — IT Director", …). They now render
 * addresses only — no person names, job titles or bios — present them as
 * automated mailboxes, point a human visitor at /contact, and do not name
 * LRX Enterprises Inc. Every page carries `<meta name="robots"
 * content="noindex,nofollow">`; the routes add the X-Robots-Tag header via
 * honeypotHtmlResponse().
 */
import { WORKER_ROUTED_MAIL_DOMAINS, trapMailDomain } from "../honeypot";
import { generateSpiderTraps } from "../seeders/spider-injector";
import { isRoleMailboxAddress, type RosterEntry } from "../lib/auto-seeder-planter";

/** Seed-format local parts (`<word>-hpNN`, channel "honeypot" in spam-trap.ts) — same shape the planter plants. */
const DEFAULT_ADMIN_LOCALS = ["itops-hp20", "devops-hp21", "infra-hp22"];
const DEFAULT_STAFF_LOCALS = ["success-hp23", "research-hp24", "product-hp25", "compliance-hp26"];
const DEFAULT_TEAM_DIRECTORY_LOCALS = ["ops-hp27", "consulting-hp28", "clientrel-hp29", "bizdev-hp30", "strategy-hp31"];
const DEFAULT_STAFF_CONTACTS_LOCALS = ["pm-hp32", "accounts-hp33", "eng-hp34", "marketing-hp35", "legal-hp36"];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function emailDomain(email: string): string {
  return (email.split("@")[1] ?? "").toLowerCase();
}

/**
 * Seeded role-style addresses on a Worker-routed domain, else the default
 * set on the page's trap domain. Name-shaped legacy seeds (`sarah.chen@…`,
 * planted before G37) are dropped here too, not only in readRoster, so no
 * caller can publish an invented person's address.
 */
function resolveAddresses(roster: RosterEntry[] | undefined, defaults: string[], mail: string): string[] {
  const live = (roster ?? [])
    .map(r => r.email)
    .filter(e => isRoleMailboxAddress(e) && WORKER_ROUTED_MAIL_DOMAINS.has(emailDomain(e)));
  return live.length > 0 ? live : defaults.map(l => `${l}@${mail}`);
}

function siteBrand(domain: string): string {
  return trapMailDomain(domain) === "lrxradar.com" ? "LRX Radar" : "Averrow";
}

const STYLES = `<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0a0e1a;color:#c8d0e0;line-height:1.7}
a{color:#78A0C8;text-decoration:none}a:hover{text-decoration:underline}
.hp-nav{background:#060a14;border-bottom:1px solid rgba(255,255,255,.08);padding:1rem 2rem}
.hp-nav a{font-weight:700;color:#e8edf5}
.hp-section{max-width:720px;margin:3rem auto;padding:0 2rem}
.hp-section h1{font-size:28px;font-weight:700;color:#e8edf5;margin-bottom:1rem}
.hp-section p{font-size:15px;color:#9aa6bb;margin-bottom:.75rem}
.hp-contacts{background:#0d1520;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:1.5rem 2rem;margin-top:1.5rem}
.hp-contacts h2{font-family:ui-monospace,monospace;font-size:11px;text-transform:uppercase;letter-spacing:.15em;color:#6b778c;margin-bottom:1rem}
.hp-contact-row{padding:.5rem 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:14px}
.hp-contact-row:last-child{border-bottom:none}
.hp-footer{border-top:1px solid rgba(255,255,255,.06);padding:1.5rem 2rem;text-align:center;font-size:13px;color:#4a5a73;margin-top:3rem}
</style>`;

interface RosterPageSpec {
  /** Page slug for spider-trap address tagging, e.g. "admin-portal". */
  slug: string;
  title: string;
  heading: string;
  intro: string;
  listLabel: string;
  commentLabel: string;
  defaults: string[];
}

function renderRosterPage(spec: RosterPageSpec, roster: RosterEntry[] | undefined, domain: string): string {
  const mail = trapMailDomain(domain);
  const brand = siteBrand(domain);
  const addresses = resolveAddresses(roster, spec.defaults, mail);
  const rows = addresses.map(e => `
    <div class="hp-contact-row"><a href="mailto:${escapeHtml(e)}">${escapeHtml(e)}</a></div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(spec.title)} — ${brand}</title>
<meta name="description" content="Automated mailbox listing.">
${STYLES}
</head>
<body>
<nav class="hp-nav"><a href="/">${brand}</a></nav>
<section class="hp-section">
  <h1>${escapeHtml(spec.heading)}</h1>
  <p>${escapeHtml(spec.intro)} These mailboxes are automated and are not read by people.</p>
  <p>To reach ${brand}, use the <a href="/contact">contact page</a>.</p>
  <div class="hp-contacts">
    <h2>${escapeHtml(spec.listLabel)}</h2>
    ${rows}
  </div>
</section>
<footer class="hp-footer">&copy; 2026 ${brand}. All rights reserved.</footer>
<!-- ${escapeHtml(spec.commentLabel)}: ${addresses.map(escapeHtml).join(" | ")} -->
${generateSpiderTraps(mail, "bait-" + spec.slug)}
</body>
</html>`;
}

export function renderAdminPortalPage(roster?: RosterEntry[], domain = "averrow.com"): string {
  return renderRosterPage({
    slug: "admin-portal",
    title: "Administration",
    heading: "Administration area",
    intro: "Restricted area.",
    listLabel: "Operations mailboxes",
    commentLabel: "Admin support",
    defaults: DEFAULT_ADMIN_LOCALS,
  }, roster, domain);
}

export function renderInternalStaffPage(roster?: RosterEntry[], domain = "averrow.com"): string {
  return renderRosterPage({
    slug: "internal-staff",
    title: "Internal mailboxes",
    heading: "Internal mailboxes",
    intro: "Internal routing addresses.",
    listLabel: "Routing addresses",
    commentLabel: "Internal routing",
    defaults: DEFAULT_STAFF_LOCALS,
  }, roster, domain);
}

// Wave-2 PR-AC: two extra bait surfaces so harvesters that URL-filter on the
// first two paths still get a yield. Each reads its own auto-seeder location
// key, so the pages surface distinct addresses.

export function renderTeamDirectoryPage(roster?: RosterEntry[], domain = "averrow.com"): string {
  return renderRosterPage({
    slug: "team-directory",
    title: "Mailbox directory",
    heading: "Mailbox directory",
    intro: "Legacy routing addresses kept for old bookmarks.",
    listLabel: "Legacy addresses",
    commentLabel: "Mailbox directory",
    defaults: DEFAULT_TEAM_DIRECTORY_LOCALS,
  }, roster, domain);
}

export function renderStaffContactsPage(roster?: RosterEntry[], domain = "averrow.com"): string {
  return renderRosterPage({
    slug: "staff-contacts",
    title: "Escalation mailboxes",
    heading: "Escalation mailboxes",
    intro: "Cross-team escalation routing.",
    listLabel: "Escalation addresses",
    commentLabel: "Escalation routing",
    defaults: DEFAULT_STAFF_CONTACTS_LOCALS,
  }, roster, domain);
}
