/**
 * Averrow — Public Incident Feed (RSS 2.0)
 *
 * Served at /status/feed.xml. No auth. Standard format for status-
 * page feed readers (e.g. Atlassian Statuspage, Datadog status,
 * RSS-aware monitoring tools).
 *
 * One <item> per public incident — most recent 50, newest first.
 * Each item:
 *   <title>           public_title
 *   <description>     public_details (HTML-escaped) + most recent
 *                     public timeline message in CDATA
 *   <link>            permalink at /status/incidents/:id
 *   <guid>            stable, isPermaLink="true" — same URL as link
 *   <pubDate>         detected_at (RFC-822)
 *
 * Visibility gate is identical to the public incidents endpoint —
 * only rows with visibility='public' AND public_title set appear.
 * Per-update text comes from public_message via toPublicShape;
 * never the internal `message`.
 */
import {
  listIncidents,
  listIncidentUpdates,
  toPublicShape,
  type PublicIncident,
} from "../lib/incidents";
import type { Env } from "../types";

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  }[c] ?? c));
}

function rfc822(iso: string): string {
  // RSS 2.0 dates are RFC-822. Date.toUTCString() returns the same
  // shape ("Mon, 04 May 2026 13:11:45 GMT"); good enough for every
  // RSS reader I tested.
  const d = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"));
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

function statusLabel(status: PublicIncident["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function renderItem(inc: PublicIncident, baseUrl: string): string {
  const link = `${baseUrl}/status/incidents/${inc.id}`;
  const sevLabel = inc.severity.toUpperCase();
  const statusText = statusLabel(inc.status);
  // Pick the latest public update for the description's body. Falls
  // back to public_details, then to a brief default.
  const updates = [...inc.updates].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = updates[0];
  const summary = latest?.message ?? inc.details ?? "Incident published.";
  // pubDate uses the most recent activity (latest update or detected_at)
  // so RSS readers re-surface incidents when operators post updates,
  // not just on initial creation.
  const pubDate = rfc822(latest?.created_at ?? inc.started_at);

  return `
    <item>
      <title>[${xmlEscape(sevLabel)} · ${xmlEscape(statusText)}] ${xmlEscape(inc.title)}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="true">${xmlEscape(link)}</guid>
      <pubDate>${xmlEscape(pubDate)}</pubDate>
      <description><![CDATA[${summary}]]></description>
    </item>`;
}

export async function renderIncidentFeed(env: Env, baseUrl: string): Promise<string> {
  let publics: PublicIncident[] = [];
  try {
    const rows = await listIncidents(env, { visibility: "public", limit: 50 });
    for (const row of rows) {
      const updates = await listIncidentUpdates(env, row.id);
      const publicUpdates = updates.filter((u) => u.visibility === "public");
      const shape = toPublicShape(row, publicUpdates);
      if (shape) publics.push(shape);
    }
  } catch {
    publics = [];
  }

  // Newest first by latest activity (update or detected_at), so a
  // re-fired incident bubbles back up.
  publics.sort((a, b) => {
    const aLatest = a.updates.length > 0
      ? a.updates.reduce((max, u) => (u.created_at > max ? u.created_at : max), a.started_at)
      : a.started_at;
    const bLatest = b.updates.length > 0
      ? b.updates.reduce((max, u) => (u.created_at > max ? u.created_at : max), b.started_at)
      : b.started_at;
    return bLatest.localeCompare(aLatest);
  });

  const lastBuildDate = rfc822(new Date().toISOString());
  const items = publics.map((inc) => renderItem(inc, baseUrl)).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Averrow Platform Status</title>
    <link>${xmlEscape(baseUrl)}/status</link>
    <description>Public incident feed for the Averrow threat intelligence platform.</description>
    <language>en-us</language>
    <atom:link href="${xmlEscape(baseUrl)}/status/feed.xml" rel="self" type="application/rss+xml" />
    <lastBuildDate>${xmlEscape(lastBuildDate)}</lastBuildDate>
    <ttl>5</ttl>${items}
  </channel>
</rss>
`;
}
