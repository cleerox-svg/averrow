/**
 * Telegram Social Feed — Public channel monitoring for threat intelligence.
 *
 * Monitors curated public Telegram channels for credential leaks, phishing kits,
 * brand abuse, and threat actor discussions.
 *
 * Two modes:
 * 1. Bot API (if TELEGRAM_BOT_TOKEN set): getUpdates for channels the bot is a member of
 * 2. Web preview fallback: scrapes t.me/s/{channel} public preview pages (no auth)
 *
 * Schedule: Every 4 hours
 * Channel list: Stored in KV as JSON array (telegram_monitored_channels)
 */

import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";

// ─── Types ───────────────────────────────────────────────────────

interface BrandRow {
  id: string;
  name: string;
  canonical_domain: string | null;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  date: number;
  chat: { id: number; title?: string; username?: string };
  forward_from_chat?: { title?: string };
  views?: number;
  forwards?: number;
}

interface TelegramUpdate {
  update_id: number;
  channel_post?: TelegramMessage;
  message?: TelegramMessage;
}

// Default channels — curated threat intel channels
const DEFAULT_CHANNELS = [
  'breaborat',
  'daborat',
  'phlocker',
  'cyberthreatintel',
  // Iran-focused threat actor channels
  'tasaborat',       // Tasnim News Agency — IRGC mouthpiece, publishes target lists
  'HandalaHack',     // Handala Hack — claims responsibility for attacks
  'cyberav3ngers',   // CyberAv3ngers — ICS/infrastructure attacks
  // Additional IRGC / Iran state media
  'Tasnim_News',     // Tasnim News Agency — official English channel
  'iikiorg',         // IRGC-linked operations claims
  'ShadowCommittee', // Shadow Committee — targets Israeli infrastructure
];

// Threat indicator keywords (scanned alongside brand names)
const THREAT_KEYWORDS = [
  'combo list', 'database dump', 'db dump', 'data leak',
  'phishing page', 'phish kit', 'phishing kit',
  'stealer logs', 'stealer log', 'infostealer',
  'carding', 'card dump', 'fullz',
  'credential leak', 'cred dump', 'leaked credentials',
  'ransomware', 'ransom leak',
  // IRGC / Iranian threat actor keywords
  'handala', 'cyberav3ngers', 'hydro kitten', 'charming kitten',
  'irgc', 'iran hack', 'operation epic fury',
  'stryker', 'wiper', 'microsoft hack',
  'amazon data center', 'aws drone',
  'apt35', 'apt42', 'phosphorus', 'mint sandstorm',
  'peach sandstorm', 'cotton sandstorm',
  'muddywater', 'oilrig', 'crambus',
  'dark scepter', 'cyber toufan',
];

const DELAY_BETWEEN_CHANNELS_MS = 2000;
const MAX_MESSAGES_PER_CHANNEL = 50;

// ─── Feed Module ─────────────────────────────────────────────────

export const telegram: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const env = ctx.env;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    // Load monitored channels from KV or use defaults
    const channelListRaw = await env.CACHE.get('telegram_monitored_channels');
    const channels: string[] = channelListRaw
      ? JSON.parse(channelListRaw) as string[]
      : DEFAULT_CHANNELS;

    if (channels.length === 0) {
      console.log('[telegram] No channels configured — skipping');
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Load brands for matching
    const allBrands = await env.DB.prepare(`
      SELECT id, name, canonical_domain FROM brands
      WHERE monitoring_status = 'active' AND threat_count > 0
      ORDER BY threat_count DESC LIMIT 50
    `).all<BrandRow>();

    // Same gating as mastodon — no eligible brands = no work.
    // Surface so operator can see it's an inventory issue, not a
    // parser bug.
    if (allBrands.results.length === 0) {
      throw new Error(
        `Telegram: no eligible brands (need monitoring_status='active' AND threat_count>0)`
      );
    }

    const botToken = env.TELEGRAM_BOT_TOKEN;

    // Try Bot API first, fall back to web preview
    if (botToken) {
      const result = await ingestViaBotApi(env, botToken, channels, allBrands.results);
      itemsFetched += result.fetched;
      itemsNew += result.new;
      itemsDuplicate += result.duplicate;
      itemsError += result.error;
    } else {
      // Web preview fallback — no auth needed
      for (const channel of channels) {
        try {
          const result = await ingestViaWebPreview(env, channel, allBrands.results);
          itemsFetched += result.fetched;
          itemsNew += result.new;
          itemsDuplicate += result.duplicate;
        } catch (err) {
          itemsError++;
          console.error(`[telegram] Web preview error for ${channel}:`, err instanceof Error ? err.message : String(err));
        }

        await delay(DELAY_BETWEEN_CHANNELS_MS);
      }
    }

    console.log(`[telegram] Complete: fetched=${itemsFetched} new=${itemsNew} dup=${itemsDuplicate} errors=${itemsError}`);
    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};

// ─── Bot API Mode ───────────────────────────────────────────────

async function ingestViaBotApi(
  env: Env,
  token: string,
  channels: string[],
  brands: BrandRow[],
): Promise<{ fetched: number; new: number; duplicate: number; error: number }> {
  let fetched = 0;
  let newCount = 0;
  let duplicate = 0;
  let error = 0;

  // Get last offset from KV
  const lastOffset = parseInt(await env.CACHE.get('telegram_update_offset') ?? '0', 10);

  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastOffset}&limit=100&timeout=5`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });

    if (!response.ok) {
      console.error(`[telegram] Bot API error: ${response.status}`);
      // Fall back to web preview
      for (const channel of channels) {
        try {
          const result = await ingestViaWebPreview(env, channel, brands);
          fetched += result.fetched;
          newCount += result.new;
          duplicate += result.duplicate;
        } catch (err) {
          error++;
          console.error(`[telegram] Fallback web preview error for ${channel}:`, err instanceof Error ? err.message : String(err));
        }
        await delay(DELAY_BETWEEN_CHANNELS_MS);
      }
      return { fetched, new: newCount, duplicate, error };
    }

    const data = await response.json() as { ok: boolean; result: TelegramUpdate[] };
    if (!data.ok || !data.result?.length) {
      return { fetched: 0, new: 0, duplicate: 0, error: 0 };
    }

    let maxOffset = lastOffset;
    for (const update of data.result) {
      if (update.update_id >= maxOffset) {
        maxOffset = update.update_id + 1;
      }

      const msg = update.channel_post ?? update.message;
      if (!msg?.text) continue;

      fetched++;
      const channelName = msg.chat.username ?? String(msg.chat.id);
      const result = await matchAndInsert(env, {
        messageId: msg.message_id,
        channelName,
        text: msg.text,
        date: msg.date,
        views: msg.views,
        forwards: msg.forwards,
      }, brands);

      if (result === 'new') newCount++;
      else if (result === 'duplicate') duplicate++;
    }

    // Save offset for next run
    await env.CACHE.put('telegram_update_offset', String(maxOffset), { expirationTtl: 86400 });
  } catch (err) {
    error++;
    console.error('[telegram] Bot API fetch error:', err instanceof Error ? err.message : String(err));
  }

  return { fetched, new: newCount, duplicate, error };
}

// ─── Web Preview Mode ───────────────────────────────────────────

async function ingestViaWebPreview(
  env: Env,
  channel: string,
  brands: BrandRow[],
): Promise<{ fetched: number; new: number; duplicate: number }> {
  let fetched = 0;
  let newCount = 0;
  let duplicate = 0;

  const url = `https://t.me/s/${channel}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Averrow/1.0; +https://averrow.com)' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    console.warn(`[telegram] Web preview ${channel}: ${response.status}`);
    return { fetched: 0, new: 0, duplicate: 0 };
  }

  const html = await response.text();

  // Parse via HTMLRewriter — the previous regex pattern
  // (`[\s\S]*?<\/div>`) breaks on nested divs inside the message
  // body (link previews, polls, replies), matching the first inner
  // closing tag and truncating to empty. Web preview was returning
  // healthy=true with 0 ingested rows for all channels. HTMLRewriter
  // is a streaming HTML parser native to Workers — no dependency
  // added, no regex landmines.
  const messages = await parseTelegramPreview(html);

  for (const msg of messages.slice(0, MAX_MESSAGES_PER_CHANNEL)) {
    if (!msg.text.trim()) continue;

    fetched++;
    const result = await matchAndInsert(env, {
      messageId: msg.messageId,
      channelName: channel,
      text: msg.text,
      date: msg.date,
      views: msg.views,
      forwards: undefined,
    }, brands);

    if (result === 'new') newCount++;
    else if (result === 'duplicate') duplicate++;
  }

  return { fetched, new: newCount, duplicate };
}

// ─── HTMLRewriter-based preview parser ──────────────────────────

interface ParsedPreviewMessage {
  postId: string;
  messageId: number;
  text: string;
  /** Unix seconds, 0 when not parseable. */
  date: number;
  views?: number;
}

async function parseTelegramPreview(html: string): Promise<ParsedPreviewMessage[]> {
  const messages: ParsedPreviewMessage[] = [];
  let current: ParsedPreviewMessage | null = null;

  const flush = () => {
    if (current && current.text.trim()) {
      messages.push({ ...current, text: current.text.trim().slice(0, 2000) });
    }
    current = null;
  };

  // HTMLRewriter requires a Response to transform; we build one
  // from the static HTML string. The .text() at the end fully
  // consumes the stream and drains all handlers.
  const response = new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

  await new HTMLRewriter()
    // Each preview message is anchored on the inner
    // `tgme_widget_message` div which carries data-post.
    // Opening this element flushes the prior message and starts
    // a new accumulator.
    .on('div.tgme_widget_message[data-post]', {
      element(el) {
        flush();
        const postAttr = el.getAttribute('data-post');
        if (!postAttr) return;
        const parts = postAttr.split('/');
        const last = parts[parts.length - 1];
        const messageId = last ? parseInt(last, 10) : NaN;
        if (Number.isNaN(messageId)) return;
        current = { postId: postAttr, messageId, text: '', date: 0 };
      },
    })
    // Text nodes inside the message body (and any descendants —
    // links, code spans, etc.) get appended in stream order.
    // Insert a leading space between non-contiguous chunks so
    // "wordlink" doesn't merge into "wordlinktext" across tag
    // boundaries.
    .on('div.tgme_widget_message_text', {
      text(chunk) {
        if (current) current.text += chunk.text;
      },
    })
    // <br/> inside the body — preserve as newline so credential-
    // dump line patterns survive the parse.
    .on('div.tgme_widget_message_text br', {
      element() {
        if (current) current.text += '\n';
      },
    })
    // Footer's <time datetime="..."> is the canonical post
    // timestamp. Captured here so dark_web_mentions.posted_at
    // reflects the actual post date, not "now".
    .on('time[datetime]', {
      element(el) {
        if (!current) return;
        const dt = el.getAttribute('datetime');
        if (!dt) return;
        const ts = Date.parse(dt);
        if (!Number.isNaN(ts)) current.date = Math.floor(ts / 1000);
      },
    })
    // View count — best-effort parsing of "1.2K" / "47" style.
    .on('span.tgme_widget_message_views', {
      text(chunk) {
        if (!current) return;
        const raw = chunk.text.trim();
        if (!raw) return;
        const mult = /K\b/i.test(raw) ? 1_000 : /M\b/i.test(raw) ? 1_000_000 : 1;
        const numStr = raw.replace(/[^\d.]/g, '');
        if (!numStr) return;
        const n = parseFloat(numStr);
        if (!Number.isNaN(n)) current.views = Math.floor(n * mult);
      },
    })
    .transform(response)
    .text();

  flush();
  return messages;
}

// ─── Brand Matching & Insert ────────────────────────────────────

interface ParsedMessage {
  messageId: number;
  channelName: string;
  text: string;
  date: number;
  views?: number;
  forwards?: number;
}

async function matchAndInsert(
  env: Env,
  msg: ParsedMessage,
  brands: BrandRow[],
): Promise<'new' | 'duplicate' | 'no_match'> {
  const textLower = msg.text.toLowerCase();

  // Check for threat keywords first (some messages are relevant even without brand match)
  const hasThreatKeyword = THREAT_KEYWORDS.some(kw => textLower.includes(kw));

  // Match against brands
  let matchedBrand: BrandRow | null = null;
  let matchType = 'keyword';

  for (const brand of brands) {
    const nameMatch = textLower.includes(brand.name.toLowerCase());
    const domainMatch = brand.canonical_domain
      ? textLower.includes(brand.canonical_domain.toLowerCase())
      : false;

    if (nameMatch || domainMatch) {
      matchedBrand = brand;
      matchType = domainMatch ? 'domain' : 'keyword';
      break;
    }
  }

  // Skip if no brand match and no threat keywords
  if (!matchedBrand && !hasThreatKeyword) return 'no_match';

  const mentionId = `telegram_${msg.channelName}_${msg.messageId}${matchedBrand ? `_${matchedBrand.id}` : ''}`;
  const dedupKey = `social:telegram:${msg.channelName}:${msg.messageId}`;

  // KV dedup
  const seen = await env.CACHE.get(dedupKey);
  if (seen) return 'duplicate';

  // DB dedup
  const existing = await env.DB.prepare(
    `SELECT id FROM social_mentions WHERE id = ?`
  ).bind(mentionId).first();
  if (existing) {
    await env.CACHE.put(dedupKey, '1', { expirationTtl: 14400 });
    return 'duplicate';
  }

  const confidence = matchedBrand
    ? (matchType === 'domain' ? 80 : 60)
    : (hasThreatKeyword ? 40 : 30);

  const contentUrl = `https://t.me/${msg.channelName}/${msg.messageId}`;
  const contentCreated = msg.date > 0
    ? new Date(msg.date * 1000).toISOString()
    : new Date().toISOString();

  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO social_mentions
        (id, platform, source_feed, content_type, content_url, content_text,
         content_author, content_created,
         brand_id, brand_name, match_type, match_confidence,
         platform_metadata, status, created_at, updated_at)
      VALUES (?, 'telegram', 'telegram', 'channel_message', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))
    `).bind(
      mentionId,
      contentUrl,
      msg.text.slice(0, 2000),
      msg.channelName,
      contentCreated,
      matchedBrand?.id ?? null,
      matchedBrand?.name ?? null,
      matchType,
      confidence,
      JSON.stringify({
        channel_name: msg.channelName,
        message_id: msg.messageId,
        views: msg.views ?? null,
        forward_count: msg.forwards ?? null,
        has_threat_keyword: hasThreatKeyword,
      }),
    ).run();

    await env.CACHE.put(dedupKey, '1', { expirationTtl: 14400 });
    return 'new';
  } catch (err) {
    console.error(`[telegram] Insert error for ${mentionId}:`, err instanceof Error ? err.message : String(err));
    return 'no_match';
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
