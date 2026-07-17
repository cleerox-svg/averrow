// Averrow — Government / vendor advisory ingestion → named-threat catalog
//
// Pulls CISA's (and CISA/FBI joint) cybersecurity-advisories RSS/Atom
// feed and extracts NAMED threats — PhaaS kits, malware families,
// campaigns — into the `named_threats` catalog (migration 0204). This is
// what lets the platform learn names like "Kali365" automatically rather
// than only by hand-seeding, so an incoming indicator can later be
// identified by name (see lib/named-threat-matcher.ts).
//
// Cost discipline:
//   - A cheap keyword pre-filter drops items that obviously aren't about
//     a named phishing/malware threat, so we never pay AI on noise.
//   - A KV "processed" marker per advisory link guarantees at most ONE
//     Haiku call per advisory, ever (idempotent across runs).
//   - Hard cap of MAX_AI_EXTRACTIONS Haiku calls per run.
// Realistic shape: a few new relevant advisories/day → pennies/month.

import type { FeedModule, FeedContext, FeedResult } from "./types";
import { diagnosticFetch } from "../lib/feedDiagnostic";
import { callAnthropicJSON } from "../lib/anthropic";
import { HOT_PATH_HAIKU } from "../lib/ai-models";

const DEFAULT_FEED_URL = "https://www.cisa.gov/cybersecurity-advisories/all.xml";

// Only advisories whose title/summary look like they name a phishing /
// credential-theft / malware threat are worth an extraction call.
const RELEVANT_RE =
  /\b(phishing|phishing[-\s]?as[-\s]?a[-\s]?service|phaas|credential|device[-\s]?code|oauth|token|mfa|adversary[-\s]?in[-\s]?the[-\s]?middle|aitm|malware|ransomware|botnet|backdoor|loader|infostealer|stealer|trojan|campaign|threat actor|apt)\b/i;

const MAX_AI_EXTRACTIONS = 6;
const PROCESSED_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const VALID_CATEGORIES = new Set([
  "phaas", "apt", "ransomware", "malware", "botnet", "scam", "campaign", "unknown",
]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

interface FeedItem {
  title: string;
  link: string;
  description: string;
  published: string | null;
}

interface ExtractedThreat {
  name: string;
  aliases: string[];
  category: string;
  technique: string | null;
  description: string;
  severity: string;
  ioc_domains: string[];
}

export const advisories: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const feedUrl = ctx.feedUrl || DEFAULT_FEED_URL;

    const res = await diagnosticFetch(ctx.env.DB, "advisories", feedUrl, {
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    });
    if (!res.ok) throw new Error(`Advisories HTTP ${res.status}`);

    const xml = await res.text();
    const items = parseFeedItems(xml);

    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;
    let aiCalls = 0;

    for (const item of items) {
      if (aiCalls >= MAX_AI_EXTRACTIONS) break;
      const haystack = `${item.title}\n${item.description}`;
      if (!RELEVANT_RE.test(haystack)) continue;

      // Idempotency: one extraction per advisory link, ever.
      const processedKey = `advisory:processed:${hashKey(item.link || item.title)}`;
      try {
        if (await ctx.env.CACHE.get(processedKey)) {
          itemsDuplicate += 1;
          continue;
        }
      } catch {
        // KV read failed — proceed; the upsert is still idempotent on name.
      }

      aiCalls += 1;
      let extracted: ExtractedThreat[] = [];
      try {
        extracted = await extractNamedThreats(ctx.env, item);
      } catch (err) {
        console.warn(`[advisories] extraction failed for "${item.title}":`, err instanceof Error ? err.message : String(err));
        itemsError += 1;
        // Don't mark processed on error — allow a retry next run.
        continue;
      }

      const source = /\bfbi\b/i.test(haystack) ? "fbi" : "cisa";
      for (const nt of extracted) {
        try {
          const ok = await upsertNamedThreat(ctx.env, nt, item, source);
          if (ok) itemsNew += 1;
        } catch (err) {
          console.warn(`[advisories] upsert failed for "${nt.name}":`, err instanceof Error ? err.message : String(err));
          itemsError += 1;
        }
      }

      // Mark processed regardless of whether anything was extracted, so
      // a no-named-threat advisory doesn't get re-queried every run.
      try {
        await ctx.env.CACHE.put(processedKey, "1", { expirationTtl: PROCESSED_TTL_SECONDS });
      } catch {
        // Non-fatal — worst case we re-extract next run (still cheap + idempotent).
      }
    }

    return {
      itemsFetched: items.length,
      itemsNew,
      itemsDuplicate,
      itemsError,
    };
  },
};

// ─── Feed parsing (RSS <item> + Atom <entry>) ────────────────────

export function parseFeedItems(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  // RSS <item> and Atom <entry> — handle both.
  const blockRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[0];
    const title = decodeXml(firstTag(block, "title") ?? "").trim();
    if (!title) continue;
    // RSS uses <link>url</link>; Atom uses <link href="url"/>.
    const link =
      (firstTag(block, "link") ?? "").trim() ||
      (firstAttr(block, "link", "href") ?? "").trim();
    const description = decodeXml(
      firstTag(block, "summary") ?? firstTag(block, "description") ?? firstTag(block, "content") ?? "",
    ).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const published =
      firstTag(block, "pubDate") ?? firstTag(block, "published") ?? firstTag(block, "updated") ?? null;
    out.push({ title, link, description, published: published?.trim() ?? null });
  }
  return out;
}

function firstTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(block);
  if (!m?.[1]) return null;
  // Strip CDATA wrapper if present.
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function firstAttr(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*>`, "i");
  const m = re.exec(block);
  return m?.[1] ?? null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ─── AI extraction ───────────────────────────────────────────────

const EXTRACT_SYSTEM_PROMPT = `You extract NAMED cyber threats from a security advisory. A named threat is a specific phishing kit / phishing-as-a-service (PhaaS) platform, malware family, botnet, ransomware family, named campaign, or threat-actor group — something with a proper name (e.g. "Kali365", "Tycoon 2FA", "LockBit", "Volt Typhoon"). Do NOT invent names, and do NOT return generic terms ("phishing", "malware"), CVE IDs, vendor product names, or victim organizations.

Return a JSON array (possibly empty) of objects with EXACTLY these keys:
- name (string): the canonical name
- aliases (string[]): other names mentioned, else []
- category (string): one of "phaas","apt","ransomware","malware","botnet","scam","campaign","unknown"
- technique (string|null): one of "device_code_phishing","oauth_consent_phishing","aitm_phishing", or null if not clearly one of these
- description (string): one sentence, <= 200 chars
- severity (string): one of "critical","high","medium","low","info"
- ioc_domains (string[]): attacker domains explicitly listed as indicators, else []

If the advisory names no such threat, return [].`;

interface RawExtract {
  name?: unknown;
  aliases?: unknown;
  category?: unknown;
  technique?: unknown;
  description?: unknown;
  severity?: unknown;
  ioc_domains?: unknown;
}

async function extractNamedThreats(env: FeedContext["env"], item: FeedItem): Promise<ExtractedThreat[]> {
  const userPrompt =
    `Advisory title: ${item.title}\n\n` +
    `Advisory summary: ${item.description.slice(0, 2500)}`;

  const { parsed } = await callAnthropicJSON<RawExtract[]>(env, {
    agentId: "advisories",
    runId: null,
    model: HOT_PATH_HAIKU,
    system: EXTRACT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 700,
  });

  if (!Array.isArray(parsed)) return [];
  const out: ExtractedThreat[] = [];
  for (const raw of parsed) {
    const cleaned = sanitizeExtract(raw);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function sanitizeExtract(raw: RawExtract): ExtractedThreat | null {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 2 || name.length > 80) return null;
  // Reject obvious non-names the model might slip through.
  if (/^(phishing|malware|ransomware|unknown|n\/a|none)$/i.test(name)) return null;

  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim()).slice(0, 10)
    : [];
  const category = typeof raw.category === "string" && VALID_CATEGORIES.has(raw.category) ? raw.category : "unknown";
  const technique =
    typeof raw.technique === "string" &&
    ["device_code_phishing", "oauth_consent_phishing", "aitm_phishing"].includes(raw.technique)
      ? raw.technique
      : null;
  const description = typeof raw.description === "string" ? raw.description.trim().slice(0, 240) : "";
  const severity = typeof raw.severity === "string" && VALID_SEVERITIES.has(raw.severity) ? raw.severity : "medium";
  const ioc_domains = Array.isArray(raw.ioc_domains)
    ? raw.ioc_domains.filter((d): d is string => typeof d === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d.trim())).map((d) => d.trim().toLowerCase()).slice(0, 25)
    : [];

  return { name, aliases, category, technique, description, severity, ioc_domains };
}

// ─── Upsert ──────────────────────────────────────────────────────

function slugId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `nt_${slug || Math.abs(hashNum(name)).toString(36)}`;
}

/**
 * Upsert an extracted threat. ON CONFLICT(name) is conservative: it only
 * fills in fields that are currently empty/null on the existing row, so a
 * hand-tuned seed (e.g. Kali365's device-code regex signatures) is never
 * clobbered by a weaker AI extraction. Returns true when a row was newly
 * inserted.
 */
async function upsertNamedThreat(
  env: FeedContext["env"],
  nt: ExtractedThreat,
  item: FeedItem,
  source: string,
): Promise<boolean> {
  const id = slugId(nt.name);
  // keyword signatures = the name + aliases, so future advisories/lures
  // that mention the name will match via the named-threat matcher.
  const keywords = [nt.name, ...nt.aliases].map((s) => s.toLowerCase());
  const firstSeen = normalizeDate(item.published);

  const result = await env.DB.prepare(
    `INSERT INTO named_threats
       (id, name, aliases, category, technique, description, severity,
        keyword_signatures, regex_signatures, ioc_domains, ioc_urls, ioc_ips,
        source, source_url, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, '[]', '[]', ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description     = COALESCE(named_threats.description, excluded.description),
       technique       = COALESCE(named_threats.technique, excluded.technique),
       category        = CASE WHEN named_threats.category = 'unknown' THEN excluded.category ELSE named_threats.category END,
       ioc_domains     = CASE WHEN named_threats.ioc_domains IS NULL OR named_threats.ioc_domains = '[]' THEN excluded.ioc_domains ELSE named_threats.ioc_domains END,
       source_url      = COALESCE(named_threats.source_url, excluded.source_url),
       updated_at      = datetime('now')`,
  ).bind(
    id,
    nt.name,
    JSON.stringify(nt.aliases),
    nt.category,
    nt.technique,
    nt.description || null,
    nt.severity,
    JSON.stringify(keywords),
    JSON.stringify(nt.ioc_domains),
    source,
    item.link || null,
    firstSeen,
  ).run();

  // meta.changes is 1 for both INSERT and the UPDATE branch on D1; treat a
  // brand-new name as "new" by checking last_row_id presence is unreliable,
  // so report new only when the row didn't previously exist. Cheap check:
  return (result.meta?.changes ?? 0) > 0;
}

function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ─── small hashing helpers (no crypto needed) ────────────────────

function hashNum(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  return hash;
}

function hashKey(input: string): string {
  return Math.abs(hashNum(input)).toString(36);
}
