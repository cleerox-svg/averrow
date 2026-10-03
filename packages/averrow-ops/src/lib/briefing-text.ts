// Shared text helpers for Observer briefings (`/api/trends/intelligence`).
//
// Briefings arrive as lightweight markdown: usually a bold lead-in
// (`**Title** — body`), sometimes `Title — body` or `Title. Body`. Three
// surfaces used to hand-roll their own strip/split (Home DailyBriefing,
// trends ExecutiveSummary, Trends `splitBriefing`) with slightly different
// results; this is the single copy.

/** Strip the markdown a briefing can carry: headings, bold, italic. */
export function stripMarkdown(input: string): string {
  return input
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/\*(.+?)\*/gs, '$1')
    // Underscore italics only at word boundaries, so snake_case identifiers
    // (malicious_ip, agent_runs) survive.
    .replace(/(^|[^\w])_(.+?)_(?=[^\w]|$)/gs, '$1$2');
}

/** Longest title we will surface before falling back to a hard cut. */
const MAX_TITLE = 140;

export interface BriefingParts {
  title: string;
  body: string;
}

/**
 * Split a briefing summary into a headline and supporting body, markdown
 * stripped from both. Order of preference:
 *   1. bold lead-in           `**Title** — body`
 *   2. dash separator         `Title — body`  (em/en dash, spaced)
 *   3. first sentence         `Title. Body`
 *   4. hard cut at MAX_TITLE
 */
export function splitBriefing(summary: string | null | undefined): BriefingParts {
  if (!summary || !summary.trim()) return { title: 'Untitled', body: '' };
  const raw = summary.trim();

  const bold = raw.match(/^\*\*(.+?)\*\*\s*[—–-]?\s*(.*)$/s);
  if (bold && bold[1]) {
    return { title: stripMarkdown(bold[1]).trim(), body: stripMarkdown(bold[2] ?? '').trim() };
  }

  const text = stripMarkdown(raw).trim();
  const dash = text.search(/\s[—–]\s/);
  if (dash > 0 && dash < MAX_TITLE) {
    return { title: text.slice(0, dash), body: text.slice(dash).replace(/^\s[—–]\s/, '').trim() };
  }
  const dot = text.search(/\.[ \n]/);
  if (dot > 0 && dot < MAX_TITLE) {
    return { title: text.slice(0, dot), body: text.slice(dot + 1).trim() };
  }
  if (text.length <= MAX_TITLE) return { title: text, body: '' };
  return { title: text.slice(0, MAX_TITLE), body: text.slice(MAX_TITLE).trim() };
}

/** Truncate to `max` characters with an ellipsis (no-op when it fits). */
export function truncateText(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max).trimEnd()}…` : input;
}

/**
 * Parse an id list as Observer writes it: a JSON array, a bare JSON string,
 * or a comma-separated fallback. Never throws.
 */
export function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    if (typeof parsed === 'string') return [parsed];
    return [];
  } catch {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
}
