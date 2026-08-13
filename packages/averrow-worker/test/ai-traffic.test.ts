import { describe, it, expect } from "vitest";
import { classifyUserAgent, classifyReferrer } from "../src/lib/ai-traffic";

describe("classifyUserAgent", () => {
  // Each AI crawler UA → correct canonical name + isAiCrawler + isBot.
  const aiCrawlerCases: Array<[string, string]> = [
    ["Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", "GPTBot"],
    ["Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)", "OAI-SearchBot"],
    ["Mozilla/5.0 ChatGPT-User/1.0 (+https://openai.com/bot)", "ChatGPT-User"],
    ["Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot"],
    ["Mozilla/5.0 (compatible; Claude-Web/1.0)", "Claude-Web"],
    ["anthropic-ai/1.0", "anthropic-ai"],
    ["Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/bot)", "PerplexityBot"],
    ["Mozilla/5.0 Perplexity-User/1.0", "Perplexity-User"],
    ["CCBot/2.0 (https://commoncrawl.org/faq/)", "CCBot"],
    ["Mozilla/5.0 (compatible; Google-Extended/1.0)", "Google-Extended"],
    ["Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)", "Bytespider"],
    ["Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)", "Amazonbot"],
    ["Mozilla/5.0 (compatible; Applebot-Extended/0.1)", "Applebot-Extended"],
    ["cohere-ai/1.0", "cohere-ai"],
    ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "Meta-ExternalAgent"],
    ["Mozilla/5.0 (compatible; DuckAssistBot/1.0)", "DuckAssistBot"],
    ["Mozilla/5.0 (compatible; YouBot/1.0)", "YouBot"],
    ["Mozilla/5.0 (compatible; Diffbot/0.1)", "Diffbot"],
  ];

  it.each(aiCrawlerCases)("classifies %s as AI crawler", (ua, name) => {
    const r = classifyUserAgent(ua);
    expect(r.isAiCrawler).toBe(true);
    expect(r.isBot).toBe(true);
    expect(r.crawlerName).toBe(name);
  });

  it("classifies a generic bot as isBot but not an AI crawler", () => {
    const r = classifyUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
    expect(r.isBot).toBe(true);
    expect(r.isAiCrawler).toBe(false);
    expect(r.crawlerName).toBeNull();
  });

  it("classifies curl / scripting agents as generic bots", () => {
    expect(classifyUserAgent("curl/8.4.0").isBot).toBe(true);
    expect(classifyUserAgent("python-requests/2.31.0").isBot).toBe(true);
    expect(classifyUserAgent("python-requests/2.31.0").isAiCrawler).toBe(false);
  });

  it("classifies a real human Chrome UA as neither bot nor AI crawler", () => {
    const r = classifyUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    expect(r.isBot).toBe(false);
    expect(r.isAiCrawler).toBe(false);
    expect(r.crawlerName).toBeNull();
  });

  it("returns all-false for an empty UA", () => {
    expect(classifyUserAgent("")).toEqual({ isBot: false, isAiCrawler: false, crawlerName: null });
  });
});

describe("classifyReferrer", () => {
  const aiReferrerCases: Array<[string, string]> = [
    ["https://chatgpt.com/", "ChatGPT"],
    ["https://chat.openai.com/c/abc-123", "ChatGPT"],
    ["https://www.openai.com/", "ChatGPT"],
    ["https://www.perplexity.ai/search?q=averrow", "Perplexity"],
    ["https://claude.ai/chat/xyz", "Claude"],
    ["https://gemini.google.com/app", "Gemini"],
    ["https://bard.google.com/", "Gemini"],
    ["https://copilot.microsoft.com/", "Copilot"],
    ["https://you.com/search", "You"],
    ["https://poe.com/", "Poe"],
    ["https://www.phind.com/search", "Phind"],
  ];

  it.each(aiReferrerCases)("classifies %s as an AI referral", (ref, source) => {
    const r = classifyReferrer(ref);
    expect(r.isAiReferral).toBe(true);
    expect(r.aiSource).toBe(source);
  });

  it("matches subdomains of an AI referrer host", () => {
    const r = classifyReferrer("https://beta.perplexity.ai/");
    expect(r.isAiReferral).toBe(true);
    expect(r.aiSource).toBe("Perplexity");
  });

  it("does not classify an ordinary referrer", () => {
    expect(classifyReferrer("https://www.google.com/search?q=threat+intel")).toEqual({
      isAiReferral: false,
      aiSource: null,
    });
    expect(classifyReferrer("https://news.ycombinator.com/")).toEqual({
      isAiReferral: false,
      aiSource: null,
    });
  });

  it("does not false-match a lookalike host that merely contains the brand", () => {
    // host is claude.ai.evil.com — endsWith('.claude.ai') is false, exact is false
    expect(classifyReferrer("https://claude-ai.example.com/").isAiReferral).toBe(false);
  });

  it("returns safe defaults for null / empty / malformed referrers", () => {
    expect(classifyReferrer(null)).toEqual({ isAiReferral: false, aiSource: null });
    expect(classifyReferrer("")).toEqual({ isAiReferral: false, aiSource: null });
    expect(classifyReferrer("not a url")).toEqual({ isAiReferral: false, aiSource: null });
  });
});
