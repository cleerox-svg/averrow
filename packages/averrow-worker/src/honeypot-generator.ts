/**
 * Honeypot Site Generator — Generates realistic small business website HTML
 * using Claude Haiku. Each generation produces unique HTML structure, layout,
 * and styling that cannot be fingerprinted by harvesters.
 *
 * Trap addresses are embedded as raw mailto: links, schema.org JSON-LD,
 * and HTML comments — all visible to email harvesters.
 */

import type { Env } from "./types";
import { callAnthropicText } from "./lib/anthropic";
import { HOT_PATH_HAIKU } from "./lib/ai-models";

// ─── Types ──────────────────────────────────────────────────────

export interface HoneypotSiteConfig {
  hostname: string;           // e.g. "novaridge-consulting.xyz"
  businessName: string;       // e.g. "Novaridge Consulting"
  businessType: string;       // e.g. "management consulting"
  city: string;               // e.g. "Vancouver, BC"
  trapAddresses: {
    address: string;          // e.g. "info-cp01@novaridge-consulting.xyz"
    role: string;             // e.g. "General Inquiries"
    displayName?: string;     // e.g. "Sarah Chen"
  }[];
  teamMembers: {
    name: string;
    title: string;
    email: string;            // trap address
  }[];
}

export interface HoneypotSiteOutput {
  index: string;
  contact: string;
  team: string;
  sitemap: string;
  robots: string;
}

// ─── Seed Address Generation ────────────────────────────────────

const TRAP_ROLES = ["info", "admin", "support", "sales", "billing", "hr", "contact", "hello"];
const CHANNEL_CODE = "hp"; // honeypot channel

export function generateTrapAddresses(
  hostname: string,
  count: number,
): { address: string; role: string; channelCode: string }[] {
  const addresses: { address: string; role: string; channelCode: string }[] = [];
  for (let i = 0; i < count; i++) {
    const role = TRAP_ROLES[i % TRAP_ROLES.length]!;
    const seq = String(i + 1).padStart(2, "0");
    addresses.push({
      address: `${role}-${CHANNEL_CODE}${seq}@${hostname}`,
      role: role.charAt(0).toUpperCase() + role.slice(1),
      channelCode: CHANNEL_CODE,
    });
  }
  return addresses;
}

// ─── Fake Team Member Names ─────────────────────────────────────

const FIRST_NAMES = [
  "Sarah", "James", "Emily", "Michael", "Olivia", "David", "Emma", "Robert",
  "Sophia", "William", "Ava", "Daniel", "Mia", "Matthew", "Isabella",
  "Andrew", "Charlotte", "Ryan", "Amelia", "Nathan",
];
const LAST_NAMES = [
  "Chen", "Williams", "Patel", "Johnson", "Kim", "Singh", "Brown", "Lee",
  "Garcia", "Wilson", "Thompson", "Martinez", "Anderson", "Taylor", "Thomas",
  "White", "Harris", "Clark", "Lewis", "Walker",
];
const TITLES = [
  "Managing Director", "Operations Director", "Senior Consultant",
  "Client Relations Manager", "Business Development Lead",
  "Strategy Analyst", "Project Manager", "Account Executive",
];

export function generateTeamMembers(
  hostname: string,
  trapAddresses: { address: string; role: string }[],
  count: number,
): { name: string; title: string; email: string }[] {
  const members: { name: string; title: string; email: string }[] = [];
  for (let i = 0; i < count && i < trapAddresses.length; i++) {
    const first = FIRST_NAMES[(i * 7 + 3) % FIRST_NAMES.length]!;
    const last = LAST_NAMES[(i * 11 + 5) % LAST_NAMES.length]!;
    members.push({
      name: `${first} ${last}`,
      title: TITLES[i % TITLES.length]!,
      email: trapAddresses[i]!.address,
    });
  }
  return members;
}

// ─── Haiku Site Generation ──────────────────────────────────────

const SYSTEM_PROMPT = `You are a web designer generating complete, realistic small business websites. You generate self-contained HTML pages with inline CSS (no external files except Google Fonts CDN). Each page must look like a real small business website — professional, modern, and unique.

CRITICAL REQUIREMENTS FOR EMAIL ADDRESSES:
- All email addresses MUST appear as raw <a href="mailto:email@domain">email@domain</a> tags
- Do NOT use JavaScript to render email addresses
- Do NOT use display:none, visibility:hidden, or font-size:0 on any element containing emails
- Include emails in schema.org/LocalBusiness JSON-LD structured data in the <head>
- Include emails in HTML comments: <!-- Contact: email@domain -->
- Staff/team pages must list each person with their email as a visible mailto link
- Contact pages must show the primary email prominently

DESIGN VARIETY — vary ALL of these between generations:
- Color schemes (use different primary/accent/background colors)
- Layout patterns (centered, sidebar, full-width, cards, etc.)
- Font combinations (use Google Fonts CDN — pick 2 complementary fonts)
- Section ordering (hero, about, services, team, contact — shuffle the order)
- Copy style (formal vs friendly, short vs detailed)
- Visual elements (gradients, borders, shadows, patterns)

OUTPUT: Return ONLY the complete HTML document, starting with <!DOCTYPE html>. No explanation or markdown.`;

export async function generateHoneypotSite(
  env: Env,
  config: HoneypotSiteConfig,
): Promise<HoneypotSiteOutput> {
  const trapEmailList = config.trapAddresses
    .map(t => `${t.role}: ${t.address}${t.displayName ? ` (${t.displayName})` : ""}`)
    .join("\n");
  const teamList = config.teamMembers
    .map(m => `${m.name} — ${m.title} — ${m.email}`)
    .join("\n");

  // Generate each page via Haiku — three calls, three ledger rows, one
  // wrapper. agentId is "honeypot-generator" so spend rolls up cleanly
  // for the trap-network operating cost view.
  const [indexHtml, contactHtml, teamHtml] = await Promise.all([
    callHaiku(env, SYSTEM_PROMPT, buildIndexPrompt(config, trapEmailList)),
    callHaiku(env, SYSTEM_PROMPT, buildContactPrompt(config, trapEmailList)),
    callHaiku(env, SYSTEM_PROMPT, buildTeamPrompt(config, teamList)),
  ]);

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://${config.hostname}/</loc></url>
  <url><loc>https://${config.hostname}/contact</loc></url>
  <url><loc>https://${config.hostname}/team</loc></url>
</urlset>`;

  const robots = `User-agent: *
Allow: /
Sitemap: https://${config.hostname}/sitemap.xml`;

  return {
    index: indexHtml,
    contact: contactHtml,
    team: teamHtml,
    sitemap,
    robots,
  };
}

// ─── Prompt Builders ────────────────────────────────────────────

function buildIndexPrompt(config: HoneypotSiteConfig, trapEmails: string): string {
  return `Generate the MAIN PAGE for this business:

Business: ${config.businessName}
Type: ${config.businessType}
Location: ${config.city}
Website: https://${config.hostname}

The page should include:
1. Navigation bar with links to /, /contact, /team
2. Hero section with business name and tagline
3. Brief about/services section
4. Contact section at the bottom with the PRIMARY email prominently displayed
5. Footer with company name, copyright 2026, and nav links

Embed these email addresses (use raw mailto: links, NEVER JavaScript):
${trapEmails}

Include schema.org/LocalBusiness JSON-LD in <head> with the primary email.
Include an HTML comment near the footer: <!-- Contact: ${config.trapAddresses[0]?.address || ""} -->`;
}

function buildContactPrompt(config: HoneypotSiteConfig, trapEmails: string): string {
  return `Generate a CONTACT PAGE for this business:

Business: ${config.businessName}
Type: ${config.businessType}
Location: ${config.city}
Website: https://${config.hostname}

The page should include:
1. Navigation bar with links to /, /contact, /team
2. "Contact Us" heading
3. A list of ALL these email addresses with their department labels, each as a visible mailto: link:
${trapEmails}
4. Business address section (use "${config.city}" as the location)
5. Business hours (Mon-Fri 9am-5pm)
6. Footer with company name and copyright 2026

Include schema.org JSON-LD with all email addresses.
Include HTML comments with each email: <!-- ${config.businessName} contact: email@domain -->`;
}

function buildTeamPrompt(config: HoneypotSiteConfig, teamList: string): string {
  return `Generate a TEAM/STAFF DIRECTORY page for this business:

Business: ${config.businessName}
Type: ${config.businessType}
Location: ${config.city}
Website: https://${config.hostname}

The page should include:
1. Navigation bar with links to /, /contact, /team
2. "Our Team" heading
3. A card or list for EACH team member showing their name, title, and email as a visible mailto: link:
${teamList}
4. Footer with company name and copyright 2026

Each team member's email MUST be a visible <a href="mailto:...">email</a> link.
Include HTML comments listing all team emails.`;
}

// ─── Anthropic API Caller ───────────────────────────────────────

async function callHaiku(env: Env, systemPrompt: string, userMessage: string): Promise<string> {
  const { text } = await callAnthropicText(env, {
    agentId: "honeypot-generator",
    runId: null,
    model: HOT_PATH_HAIKU,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 4096,
    timeoutMs: 60_000,
  });

  if (!text) throw new Error("No text content in Haiku response");

  // Strip any markdown fences wrapping the HTML
  let html = text.trim();
  if (html.startsWith("```html")) html = html.slice(7);
  else if (html.startsWith("```")) html = html.slice(3);
  if (html.endsWith("```")) html = html.slice(0, -3);

  return html.trim();
}
