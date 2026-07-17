/**
 * Averrow — Honeypot Pages for Spider Traps
 * Served at /admin-portal and /internal-staff — paths listed as Disallow in robots.txt.
 * Malicious bots specifically crawl disallowed paths, making these effective honeypots.
 *
 * Both pages now accept an optional `roster` of seeded addresses. When
 * supplied (the live caller passes the result of readRoster() from
 * lib/auto-seeder-planter.ts), the page renders the up-to-date set so
 * a harvester scraping us in week 4 sees a different list than one in
 * week 1. When omitted (or empty), each page falls back to a built-in
 * default roster so the page never renders blank.
 */
import { wrapPage } from "./shared";
import type { RosterEntry } from "../lib/auto-seeder-planter";

const DEFAULT_ADMIN_ROSTER: RosterEntry[] = [
  { name: "Robert Taylor",  title: "IT Director",       email: "robert.taylor.hp01@averrow.com" },
  { name: "Lisa Martinez",  title: "DevOps Lead",       email: "lisa.martinez.hp02@trustradar.ca" },
  { name: "Kevin Park",     title: "Infrastructure",    email: "kevin.park.hp03@averrow.com" },
];

const DEFAULT_STAFF_ROSTER: RosterEntry[] = [
  { name: "Amanda White",   title: "Customer Success",  email: "amanda.white.hp04@trustradar.ca" },
  { name: "Chris Johnson",  title: "Threat Research",   email: "chris.johnson.hp05@averrow.com" },
  { name: "Rachel Kim",     title: "Product",           email: "rachel.kim.hp06@trustradar.ca" },
  { name: "Tom Harris",     title: "Compliance",        email: "tom.harris.hp07@averrow.com" },
];

function renderRosterRows(roster: RosterEntry[]): string {
  return roster.map(r => `
    <div class="hp-contact-row">
      <span class="name">${escapeHtml(r.name)} — ${escapeHtml(r.title)}</span>
      <a class="email" href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a>
    </div>`).join('');
}

/** Comment-form mailto list — secondary harvester surface. */
function renderRosterComment(label: string, roster: RosterEntry[]): string {
  return `<!-- ${label}: ${roster.map(r => r.email).join(' | ')} -->`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAdminPortalPage(roster?: RosterEntry[]): string {
  const useRoster = (roster && roster.length > 0) ? roster : DEFAULT_ADMIN_ROSTER;
  return wrapPage(
    "Admin Portal — Averrow",
    "Internal administration portal for Averrow platform management.",
    `
<style>
.hp-section {
  max-width: 720px;
  margin: 3rem auto;
  padding: 0 2rem;
}
.hp-section h1 {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 1rem;
}
.hp-section p {
  font-size: 15px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin-bottom: 0.75rem;
}
.hp-contacts {
  background: var(--bg-secondary, #0d1520);
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  border-radius: 12px;
  padding: 1.5rem 2rem;
  margin-top: 1.5rem;
}
.hp-contacts h3 {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--text-tertiary);
  margin-bottom: 1rem;
}
.hp-contact-row {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.05));
  font-size: 14px;
}
.hp-contact-row:last-child { border-bottom: none; }
.hp-contact-row .name { color: var(--text-primary); }
.hp-contact-row .email { color: var(--link-color, #78A0C8); }
</style>

<section class="hp-section">
  <h1>Administration Portal</h1>
  <p>This area is restricted to authorized Averrow staff. If you need access, please contact the IT department.</p>
  <p>For platform issues, reach out to the operations team below.</p>

  <div class="hp-contacts">
    <h3>Admin Contacts</h3>
    ${renderRosterRows(useRoster)}
  </div>
</section>
${renderRosterComment("Admin support", useRoster)}
`
  );
}

export function renderInternalStaffPage(roster?: RosterEntry[]): string {
  const useRoster = (roster && roster.length > 0) ? roster : DEFAULT_STAFF_ROSTER;
  return wrapPage(
    "Internal Staff Directory — Averrow",
    "Internal staff directory for Averrow employees.",
    `
<section class="hp-section">
  <h1>Staff Directory</h1>
  <p>Internal use only. For external inquiries, please use our <a href="/contact">contact page</a>.</p>

  <div class="hp-contacts">
    <h3>Department Leads</h3>
    ${renderRosterRows(useRoster)}
  </div>
</section>
${renderRosterComment("Staff directory", useRoster)}

<style>
.hp-section { max-width: 720px; margin: 3rem auto; padding: 0 2rem; }
.hp-section h1 { font-family: var(--font-display); font-size: 28px; font-weight: 700; color: var(--text-primary); margin-bottom: 1rem; }
.hp-section p { font-size: 15px; color: var(--text-secondary); line-height: 1.7; margin-bottom: 0.75rem; }
.hp-contacts { background: var(--bg-secondary, #0d1520); border: 1px solid var(--border-color, rgba(255,255,255,0.08)); border-radius: 12px; padding: 1.5rem 2rem; margin-top: 1.5rem; }
.hp-contacts h3 { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: var(--text-tertiary); margin-bottom: 1rem; }
.hp-contact-row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.05)); font-size: 14px; }
.hp-contact-row:last-child { border-bottom: none; }
.hp-contact-row .name { color: var(--text-primary); }
.hp-contact-row .email { color: var(--link-color, #78A0C8); }
</style>
`
  );
}

// ─── Wave-2 PR-AC additions ──────────────────────────────────────
//
// Two extra bait surfaces so harvesters that URL-filter on the first
// two paths still get a yield from us. Same roster-rotation pattern;
// each pulls from its own auto-seeder location key so the three pages
// surface distinct addresses (more distinct entries in the harvester's
// list = more first-touch opportunities).
//
// Per the Wave-2 audit recommendation: target 5-10 addresses per page,
// each on a CMS-style page that looks like real internal content.

const DEFAULT_TEAM_DIRECTORY_ROSTER: RosterEntry[] = [
  { name: "Emily Wilson",   title: "Operations Director",         email: "emily.wilson.hp08@averrow.com" },
  { name: "Marcus Bennett", title: "Senior Consultant",           email: "marcus.bennett.hp09@trustradar.ca" },
  { name: "Sophie Lee",     title: "Client Relations Manager",    email: "sophie.lee.hp10@averrow.com" },
  { name: "Daniel Foster",  title: "Business Development Lead",   email: "daniel.foster.hp11@trustradar.ca" },
  { name: "Hannah Murphy",  title: "Strategy Analyst",            email: "hannah.murphy.hp12@averrow.com" },
];

const DEFAULT_STAFF_CONTACTS_ROSTER: RosterEntry[] = [
  { name: "Owen Hughes",    title: "Project Manager",             email: "owen.hughes.hp13@averrow.com" },
  { name: "Zoe Bailey",     title: "Account Executive",           email: "zoe.bailey.hp14@trustradar.ca" },
  { name: "Lucas Reyes",    title: "Engineering Manager",         email: "lucas.reyes.hp15@averrow.com" },
  { name: "Chloe Cooper",   title: "Marketing Director",          email: "chloe.cooper.hp16@trustradar.ca" },
  { name: "Henry Singh",    title: "Compliance Officer",          email: "henry.singh.hp17@averrow.com" },
];

export function renderTeamDirectoryPage(roster?: RosterEntry[]): string {
  const useRoster = (roster && roster.length > 0) ? roster : DEFAULT_TEAM_DIRECTORY_ROSTER;
  return wrapPage(
    "Team Directory — Averrow",
    "Internal team directory and contact information.",
    `
<section class="hp-section">
  <h1>Team Directory</h1>
  <p>The Averrow team page is currently undergoing migration. The fallback contact list below remains in place for legacy escalation paths.</p>
  <p>If you've been redirected here from an outdated bookmark, please update to <a href="/about">/about</a>.</p>

  <div class="hp-contacts">
    <h3>Direct Contacts</h3>
    ${renderRosterRows(useRoster)}
  </div>
</section>
${renderRosterComment("Team directory", useRoster)}

<style>
.hp-section { max-width: 720px; margin: 3rem auto; padding: 0 2rem; }
.hp-section h1 { font-family: var(--font-display); font-size: 28px; font-weight: 700; color: var(--text-primary); margin-bottom: 1rem; }
.hp-section p { font-size: 15px; color: var(--text-secondary); line-height: 1.7; margin-bottom: 0.75rem; }
.hp-contacts { background: var(--bg-secondary, #0d1520); border: 1px solid var(--border-color, rgba(255,255,255,0.08)); border-radius: 12px; padding: 1.5rem 2rem; margin-top: 1.5rem; }
.hp-contacts h3 { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: var(--text-tertiary); margin-bottom: 1rem; }
.hp-contact-row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.05)); font-size: 14px; }
.hp-contact-row:last-child { border-bottom: none; }
.hp-contact-row .name { color: var(--text-primary); }
.hp-contact-row .email { color: var(--link-color, #78A0C8); }
</style>
`
  );
}

export function renderStaffContactsPage(roster?: RosterEntry[]): string {
  const useRoster = (roster && roster.length > 0) ? roster : DEFAULT_STAFF_CONTACTS_ROSTER;
  return wrapPage(
    "Staff Contacts — Averrow",
    "Internal staff contact list for cross-team escalations.",
    `
<section class="hp-section">
  <h1>Staff Contacts</h1>
  <p>Cross-team escalation directory. Direct external inquiries to <a href="/contact">/contact</a>.</p>

  <div class="hp-contacts">
    <h3>Escalation Contacts</h3>
    ${renderRosterRows(useRoster)}
  </div>
</section>
${renderRosterComment("Staff contacts", useRoster)}

<style>
.hp-section { max-width: 720px; margin: 3rem auto; padding: 0 2rem; }
.hp-section h1 { font-family: var(--font-display); font-size: 28px; font-weight: 700; color: var(--text-primary); margin-bottom: 1rem; }
.hp-section p { font-size: 15px; color: var(--text-secondary); line-height: 1.7; margin-bottom: 0.75rem; }
.hp-contacts { background: var(--bg-secondary, #0d1520); border: 1px solid var(--border-color, rgba(255,255,255,0.08)); border-radius: 12px; padding: 1.5rem 2rem; margin-top: 1.5rem; }
.hp-contacts h3 { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: var(--text-tertiary); margin-bottom: 1rem; }
.hp-contact-row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.05)); font-size: 14px; }
.hp-contact-row:last-child { border-bottom: none; }
.hp-contact-row .name { color: var(--text-primary); }
.hp-contact-row .email { color: var(--link-color, #78A0C8); }
</style>

<style>
.hp-section {
  max-width: 720px;
  margin: 3rem auto;
  padding: 0 2rem;
}
.hp-section h1 {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 1rem;
}
.hp-section p {
  font-size: 15px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin-bottom: 0.75rem;
}
.hp-contacts {
  background: var(--bg-secondary, #0d1520);
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  border-radius: 12px;
  padding: 1.5rem 2rem;
  margin-top: 1.5rem;
}
.hp-contacts h3 {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--text-tertiary);
  margin-bottom: 1rem;
}
.hp-contact-row {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.05));
  font-size: 14px;
}
.hp-contact-row:last-child { border-bottom: none; }
.hp-contact-row .name { color: var(--text-primary); }
.hp-contact-row .email { color: var(--link-color, #78A0C8); }
</style>
`
  );
}
