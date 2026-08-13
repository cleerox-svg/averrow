/**
 * AI-traffic classification — pure, dependency-free helpers.
 *
 * `classifyUserAgent` detects AI crawlers (and generic bots) from a
 * User-Agent string; `classifyReferrer` detects a human arriving from an
 * AI chat service via the Referer header. Both are deterministic and
 * unit-testable — no I/O, no env, no request access.
 */

export interface UaClass {
  isBot: boolean;
  isAiCrawler: boolean;
  crawlerName: string | null;
}

export interface RefClass {
  isAiReferral: boolean;
  aiSource: string | null;
}

// Generic bot pattern — mirrors lib/honeypot-visit-logger.ts BOT_PATTERN.
const BOT_PATTERN = /bot|crawl|spider|scrape|curl|wget|python|php|java|go-http|axios|node-fetch|headless/i;

// AI-crawler UA map, matched in order — first hit wins. Each entry maps a
// case-insensitive regex to a canonical crawler name.
const AI_CRAWLERS: Array<{ re: RegExp; name: string }> = [
  { re: /GPTBot/i, name: "GPTBot" },
  { re: /OAI-SearchBot/i, name: "OAI-SearchBot" },
  { re: /ChatGPT-User/i, name: "ChatGPT-User" },
  { re: /ClaudeBot/i, name: "ClaudeBot" },
  { re: /Claude-Web/i, name: "Claude-Web" },
  { re: /anthropic-ai/i, name: "anthropic-ai" },
  { re: /PerplexityBot/i, name: "PerplexityBot" },
  { re: /Perplexity-User/i, name: "Perplexity-User" },
  { re: /CCBot/i, name: "CCBot" },
  { re: /Google-Extended/i, name: "Google-Extended" },
  { re: /Bytespider/i, name: "Bytespider" },
  { re: /Amazonbot/i, name: "Amazonbot" },
  { re: /Applebot-Extended/i, name: "Applebot-Extended" },
  { re: /cohere-ai/i, name: "cohere-ai" },
  { re: /meta-externalagent/i, name: "Meta-ExternalAgent" },
  { re: /DuckAssistBot/i, name: "DuckAssistBot" },
  { re: /YouBot/i, name: "YouBot" },
  { re: /Diffbot/i, name: "Diffbot" },
];

export function classifyUserAgent(ua: string): UaClass {
  if (!ua) {
    return { isBot: false, isAiCrawler: false, crawlerName: null };
  }
  for (const c of AI_CRAWLERS) {
    if (c.re.test(ua)) {
      return { isBot: true, isAiCrawler: true, crawlerName: c.name };
    }
  }
  return { isBot: BOT_PATTERN.test(ua), isAiCrawler: false, crawlerName: null };
}

// AI-referrer host map — hostname (suffix) → canonical source name.
const AI_REFERRERS: Array<{ host: string; name: string }> = [
  { host: "chatgpt.com", name: "ChatGPT" },
  { host: "chat.openai.com", name: "ChatGPT" },
  { host: "openai.com", name: "ChatGPT" },
  { host: "perplexity.ai", name: "Perplexity" },
  { host: "claude.ai", name: "Claude" },
  { host: "gemini.google.com", name: "Gemini" },
  { host: "bard.google.com", name: "Gemini" },
  { host: "copilot.microsoft.com", name: "Copilot" },
  { host: "you.com", name: "You" },
  { host: "poe.com", name: "Poe" },
  { host: "phind.com", name: "Phind" },
];

export function classifyReferrer(referer: string | null): RefClass {
  try {
    if (!referer) {
      return { isAiReferral: false, aiSource: null };
    }
    let host = new URL(referer).hostname.toLowerCase();
    if (host.startsWith("www.")) {
      host = host.slice(4);
    }
    for (const r of AI_REFERRERS) {
      if (host === r.host || host.endsWith("." + r.host)) {
        return { isAiReferral: true, aiSource: r.name };
      }
    }
    return { isAiReferral: false, aiSource: null };
  } catch {
    return { isAiReferral: false, aiSource: null };
  }
}
