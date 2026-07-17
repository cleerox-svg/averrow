/**
 * Watchdog Agent — Social Mention Classifier & Escalator.
 *
 * Processes unclassified social mentions from social_mentions table,
 * uses Claude Haiku for threat classification, and escalates confirmed
 * high/critical severity findings to the threats table.
 *
 * Schedule: Every 15 minutes when backlog exists (triggered by Flight Control)
 * Batch size: 50 mentions per run
 * AI: Claude Haiku for classification
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { extractDomain } from "../lib/domain-utils";
import { callAnthropicJSON } from "../lib/anthropic";
import type { Env } from "../types";
import { HOT_PATH_HAIKU } from "../lib/ai-models";

// ─── Types ───────────────────────────────────────────────────────

interface SocialMentionRow {
  id: string;
  platform: string;
  source_feed: string;
  content_type: string;
  content_url: string | null;
  content_text: string | null;
  content_author: string | null;
  content_author_url: string | null;
  content_created: string | null;
  brand_id: string | null;
  brand_name: string | null;
  match_type: string | null;
  match_confidence: number;
  platform_metadata: string | null;
  full_brand_name: string | null;
  brand_domain: string | null;
  aliases: string | null;
  brand_keywords: string | null;
  executive_names: string | null;
}

interface Classification {
  threat_type: string;
  severity: string;
  confidence: number;
  reasoning: string;
}

// ─── Agent Module ────────────────────────────────────────────────

export const watchdogAgent: AgentModule = {
  name: "watchdog",
  displayName: "Watchdog",
  description: "Social mention classifier — Haiku-powered threat classification of Reddit, GitHub, and other social platform mentions",
  color: "#FF4500",
  trigger: "event",
  requiresApproval: false,
  stallThresholdMinutes: 1500,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 5_000_000 },
  reads: [
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "social_mentions" },
  ],
  writes: [
    { kind: "d1_table", name: "social_mentions" },
    { kind: "d1_table", name: "threats" },
  ],
  outputs: [],
  status: "active",
  category: "intelligence",
  pipelinePosition: 12,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, runId } = ctx;
    const db = env.DB;
    const outputs: AgentOutputEntry[] = [];

    // 1. Fetch unclassified mentions
    const mentions = await db.prepare(`
      SELECT sm.*, b.name as full_brand_name, b.canonical_domain as brand_domain,
             b.aliases, b.brand_keywords, b.executive_names
      FROM social_mentions sm
      LEFT JOIN brands b ON sm.brand_id = b.id
      WHERE sm.status = 'new'
      ORDER BY sm.match_confidence DESC, sm.created_at DESC
      LIMIT 50
    `).all<SocialMentionRow>();

    if (!mentions.results?.length) {
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { message: "No unclassified mentions" },
        agentOutputs: [],
      };
    }

    let classified = 0;
    let escalated = 0;
    let falsePositives = 0;
    let errors = 0;

    for (const mention of mentions.results) {
      try {
        // 2. Build classification context
        const classificationContext = buildClassificationContext(mention);

        // 3. Call Haiku for classification
        const classification = await classifyWithHaiku(classificationContext, env, runId);

        // 4. Update mention with classification
        await db.prepare(`
          UPDATE social_mentions
          SET threat_type = ?, severity = ?, ai_assessment = ?,
              ai_confidence = ?, status = 'classified', updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          classification.threat_type,
          classification.severity,
          classification.reasoning,
          classification.confidence,
          mention.id
        ).run();

        classified++;

        // 5. Escalate high-severity findings to threats table
        if (classification.severity === 'critical' || classification.severity === 'high') {
          const threatId = `social_${mention.platform}_${crypto.randomUUID().slice(0, 8)}`;
          const domain = mention.content_url ? extractDomain(mention.content_url) : null;
          const title = `[${mention.platform.toUpperCase()}] ${classification.threat_type}: ${(mention.content_text ?? '').slice(0, 100)}`;

          await db.prepare(`
            INSERT INTO threats (id, malicious_domain, malicious_url, threat_type, severity,
              confidence_score, source_feed, target_brand_id, first_seen,
              last_seen, status, title, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'active', ?, datetime('now'))
          `).bind(
            threatId,
            domain,
            mention.content_url,
            classification.threat_type,
            classification.severity,
            classification.confidence,
            mention.source_feed,
            mention.brand_id,
            title
          ).run();

          // Link mention to threat
          await db.prepare(`
            UPDATE social_mentions SET escalated_to_threat_id = ?, status = 'escalated', updated_at = datetime('now')
            WHERE id = ?
          `).bind(threatId, mention.id).run();

          escalated++;
        }

        // 6. Mark benign with high confidence as false positives
        if (classification.threat_type === 'benign' && classification.confidence > 90) {
          await db.prepare(`
            UPDATE social_mentions SET status = 'false_positive', updated_at = datetime('now') WHERE id = ?
          `).bind(mention.id).run();
          falsePositives++;
        }

      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[watchdog] Error classifying mention ${mention.id}:`, msg);
      }
    }

    // 7. Write summary output
    const summary = `Watchdog: classified=${classified}, escalated=${escalated}, false_positives=${falsePositives}, errors=${errors}`;
    outputs.push({
      type: 'classification',
      summary,
      severity: escalated > 0 ? 'high' : 'info',
      details: { classified, escalated, falsePositives, errors, total: mentions.results.length },
    });

    return {
      itemsProcessed: mentions.results.length,
      itemsCreated: escalated,
      itemsUpdated: classified,
      output: { classified, escalated, falsePositives, errors },
      agentOutputs: outputs,
    };
  },
};

// ─── Classification Context Builder ──────────────────────────────

function buildClassificationContext(mention: SocialMentionRow): string {
  const parts: string[] = [];

  parts.push(`Platform: ${mention.platform}`);
  parts.push(`Content type: ${mention.content_type}`);

  if (mention.content_author) {
    parts.push(`Author: ${mention.content_author}`);
  }
  if (mention.content_created) {
    parts.push(`Posted: ${mention.content_created}`);
  }

  parts.push(`\nContent:\n${(mention.content_text ?? '(no text)').slice(0, 1500)}`);

  if (mention.content_url) {
    parts.push(`\nURL: ${mention.content_url}`);
  }

  if (mention.full_brand_name || mention.brand_name) {
    parts.push(`\nMatched brand: ${mention.full_brand_name ?? mention.brand_name}`);
  }
  if (mention.brand_domain) {
    parts.push(`Brand domain: ${mention.brand_domain}`);
  }
  if (mention.match_type) {
    parts.push(`Match type: ${mention.match_type} (confidence: ${mention.match_confidence})`);
  }

  // Brand context
  if (mention.aliases) {
    try {
      const aliases = JSON.parse(mention.aliases) as string[];
      if (aliases.length > 0) parts.push(`Brand aliases: ${aliases.join(', ')}`);
    } catch { /* ignore parse errors */ }
  }
  if (mention.brand_keywords) {
    try {
      const keywords = JSON.parse(mention.brand_keywords) as string[];
      if (keywords.length > 0) parts.push(`Brand keywords: ${keywords.join(', ')}`);
    } catch { /* ignore parse errors */ }
  }
  if (mention.executive_names) {
    try {
      const execs = JSON.parse(mention.executive_names) as string[];
      if (execs.length > 0) parts.push(`Known executives: ${execs.join(', ')}`);
    } catch { /* ignore parse errors */ }
  }

  // Platform metadata
  if (mention.platform_metadata) {
    try {
      const meta = JSON.parse(mention.platform_metadata) as Record<string, unknown>;
      if (meta.subreddit) parts.push(`Subreddit: r/${meta.subreddit}`);
      if (meta.repo_name) parts.push(`Repository: ${meta.repo_name}`);
      if (meta.file_path) parts.push(`File path: ${meta.file_path}`);
    } catch { /* ignore parse errors */ }
  }

  return parts.join('\n');
}

// ─── Haiku Classification ────────────────────────────────────────

async function classifyWithHaiku(context: string, env: Env, runId: string | null): Promise<Classification> {
  if (!env.ANTHROPIC_API_KEY) {
    // Fallback: heuristic classification when no API key
    return heuristicClassification(context);
  }

  // Pre-filter: heuristic first. If confident, skip AI.
  const heuristic = heuristicClassification(context);
  if (heuristic.confidence >= 60 && heuristic.threat_type !== 'benign') {
    return heuristic;
  }

  const systemPrompt = `You are a brand threat intelligence analyst. Classify this social media mention for potential threats to the matched brand. Determine if this represents a genuine threat or is benign.

Respond with JSON only:
{
  "threat_type": "impersonation|credential_leak|phishing_link|brand_abuse|code_leak|threat_actor_chatter|vulnerability_disclosure|benign",
  "severity": "critical|high|medium|low",
  "confidence": 0-100,
  "reasoning": "Brief explanation"
}

Classification guidelines:
- credential_leak: passwords, API keys, tokens, database dumps mentioning the brand
- phishing_link: URLs mimicking the brand's domain or login pages
- impersonation: fake accounts or content pretending to be the brand
- code_leak: proprietary source code, internal configs, API endpoints exposed
- brand_abuse: unauthorized use of brand name/logo for scams
- threat_actor_chatter: discussion of targeting the brand in threat actor communities
- vulnerability_disclosure: security vulnerabilities in the brand's products
- benign: legitimate discussion, news articles, customer support, reviews

Err on the side of caution — flag ambiguous cases as medium severity rather than dismissing them.`;

  try {
    const { parsed } = await callAnthropicJSON<Classification>(env, {
      agentId: "watchdog",
      runId,
      model: HOT_PATH_HAIKU,
      system: systemPrompt,
      messages: [{ role: "user", content: context }],
      maxTokens: 256,
      timeoutMs: 15_000,
    });

    // Validate and clamp values
    const validTypes = ['impersonation', 'credential_leak', 'phishing_link', 'brand_abuse', 'code_leak', 'threat_actor_chatter', 'vulnerability_disclosure', 'benign'];
    const validSeverities = ['critical', 'high', 'medium', 'low'];

    return {
      threat_type: validTypes.includes(parsed.threat_type) ? parsed.threat_type : 'benign',
      severity: validSeverities.includes(parsed.severity) ? parsed.severity : 'low',
      confidence: Math.max(0, Math.min(100, parsed.confidence ?? 50)),
      reasoning: (parsed.reasoning ?? '').slice(0, 500),
    };
  } catch (err) {
    console.error('[watchdog] Haiku classification failed, using heuristic:', err instanceof Error ? err.message : String(err));
    return heuristicClassification(context);
  }
}

// ─── Heuristic Fallback ──────────────────────────────────────────

function heuristicClassification(context: string): Classification {
  const lower = context.toLowerCase();

  // Check for credential/secret indicators
  const secretPatterns = [
    /api[_-]?key/i, /api[_-]?secret/i, /password\s*[:=]/i,
    /token\s*[:=]/i, /private[_-]?key/i, /credentials/i,
    /\.env\b/i, /database[_-]?url/i, /connection[_-]?string/i,
  ];
  if (secretPatterns.some(p => p.test(lower))) {
    return { threat_type: 'credential_leak', severity: 'high', confidence: 65, reasoning: 'Heuristic: contains credential/secret patterns' };
  }

  // Check for phishing indicators
  if (/phish|fake\s+login|credential\s+harvest|spoofed/i.test(lower)) {
    return { threat_type: 'phishing_link', severity: 'high', confidence: 60, reasoning: 'Heuristic: contains phishing-related keywords' };
  }

  // Check for impersonation
  if (/impersonat|fake\s+account|pretending\s+to\s+be|scam\s+account/i.test(lower)) {
    return { threat_type: 'impersonation', severity: 'medium', confidence: 55, reasoning: 'Heuristic: contains impersonation keywords' };
  }

  // Check for vulnerability disclosure
  if (/cve-\d{4}/i.test(lower) || /vulnerabilit|exploit|rce\b|xss\b|sqli\b/i.test(lower)) {
    return { threat_type: 'vulnerability_disclosure', severity: 'medium', confidence: 55, reasoning: 'Heuristic: contains vulnerability keywords' };
  }

  // Check for code leak indicators
  if (/source\s+code|internal\s+api|leaked\s+code|proprietary/i.test(lower)) {
    return { threat_type: 'code_leak', severity: 'medium', confidence: 50, reasoning: 'Heuristic: contains code leak keywords' };
  }

  // Default: benign
  return { threat_type: 'benign', severity: 'low', confidence: 40, reasoning: 'Heuristic: no threat indicators detected' };
}
