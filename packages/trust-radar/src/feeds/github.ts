/**
 * GitHub Social Feed — Code leak detection + security advisory monitoring.
 *
 * Authentication: Fine-grained personal access token (GITHUB_FEED_TOKEN)
 * Rate limit: 30 search requests/minute (authenticated)
 * Schedule: Every 4 hours
 *
 * Two monitoring modes:
 * 1. Code search: finds leaked credentials, API keys, configs referencing brands
 * 2. Security advisory monitoring: checks GitHub advisories for brand-related CVEs
 *
 * Rotates 10 brands per run (round-robin via KV counter).
 */

import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";

// ─── Types ───────────────────────────────────────────────────────

interface GitHubCodeSearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    name: string;
    path: string;
    sha: string;
    html_url: string;
    repository: {
      full_name: string;
      html_url: string;
      description: string | null;
      owner: { login: string; html_url: string };
      stargazers_count: number;
      language: string | null;
      updated_at: string;
    };
    text_matches?: Array<{
      fragment: string;
      matches: Array<{ text: string; indices: number[] }>;
    }>;
  }>;
}

interface GitHubAdvisory {
  ghsa_id: string;
  cve_id: string | null;
  summary: string;
  description: string;
  severity: string;
  html_url: string;
  published_at: string;
  updated_at: string;
  vulnerabilities: Array<{
    package: { ecosystem: string; name: string };
    vulnerable_version_range: string;
  }>;
}

interface BrandRow {
  id: string;
  name: string;
  canonical_domain: string | null;
}

// Per-run sizing.
//
// History: BRANDS_PER_RUN was 10 + DELAY_BETWEEN_CALLS_MS was 3000.
// That meant up to 10 × 2 search calls × 3s = 60s of forced delays
// plus per-call API time (~2s each) before advisory monitoring even
// started. Cloudflare Workers' cron-handler wall-clock budget for
// the orchestrator slot is bounded — the worker was dying mid-run,
// rows stayed `status='partial'`, and the navigator reaper marked
// them failed 15 min later. The 64% failure rate on /admin/metrics
// (Feed Failures tab) was every single one of those reaps.
//
// New budget: 4 brands × 2 searches × (2.1s delay + ~2s API) ≈ 33s
// worst case in the loop, plus 1 advisory call (~2s) and bookkeeping.
// The hard wall-clock guard below breaks out cleanly if we get close
// to the budget regardless, so successful work always gets stamped.
const MAX_SEARCH_CALLS_PER_RUN = 25;
const BRANDS_PER_RUN = 4;
// Just over GitHub's 30 search/min rate limit (60s / 30 = 2.0s + 100ms safety).
const DELAY_BETWEEN_CALLS_MS = 2100;
// Wall-clock budget for the whole ingest. When elapsed exceeds this,
// the loop exits with whatever's been processed so far — reaper
// never fires.
const WALLTIME_BUDGET_MS = 25_000;

// ─── Feed Module ─────────────────────────────────────────────────

export const github: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const env = ctx.env;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;
    let apiCalls = 0;
    const startedAt = Date.now();
    const walltimeExceeded = () => Date.now() - startedAt >= WALLTIME_BUDGET_MS;

    // Check for GitHub token
    const token = env.GITHUB_FEED_TOKEN;
    if (!token) {
      console.log('[github] No GITHUB_FEED_TOKEN configured — skipping');
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // 1. Get brands to monitor (rotate 10 per run)
    const offset = parseInt(await env.CACHE.get('github_brand_offset') ?? '0', 10);
    const brands = await env.DB.prepare(`
      SELECT b.id, b.name, b.canonical_domain
      FROM brands b
      WHERE b.monitoring_status = 'active'
        AND b.threat_count > 0
      ORDER BY b.threat_count DESC
      LIMIT ? OFFSET ?
    `).bind(BRANDS_PER_RUN, offset).all<BrandRow>();

    // Update offset for next run
    const nextOffset = brands.results.length < BRANDS_PER_RUN ? 0 : offset + BRANDS_PER_RUN;
    await env.CACHE.put('github_brand_offset', String(nextOffset), { expirationTtl: 86400 });

    // 2. Code leak detection per brand
    for (const brand of brands.results) {
      if (apiCalls >= MAX_SEARCH_CALLS_PER_RUN) break;
      // Wall-clock guard. When we're close to the budget, exit the
      // loop cleanly so the success/failure stamp lands and the
      // reaper never fires. Whatever brands we didn't reach get
      // picked up next run via `github_brand_offset` rotation.
      if (walltimeExceeded()) {
        console.log(`[github] walltime budget reached after ${apiCalls} calls — exiting loop early`);
        break;
      }

      // Search for domain references in code
      if (brand.canonical_domain) {
        try {
          const results = await searchGitHubCode(token, `"${brand.canonical_domain}"`, env);
          apiCalls++;
          const processed = await processCodeResults(env, results, brand, 'domain');
          itemsFetched += processed.fetched;
          itemsNew += processed.new;
          itemsDuplicate += processed.duplicate;
        } catch (err) {
          itemsError++;
          console.error(`[github] Code search error for ${brand.canonical_domain}:`, err instanceof Error ? err.message : String(err));
        }

        await delay(DELAY_BETWEEN_CALLS_MS);
      }

      // Search for credential leaks
      if (apiCalls < MAX_SEARCH_CALLS_PER_RUN && brand.canonical_domain && !walltimeExceeded()) {
        try {
          const query = `"${brand.canonical_domain}" api_key OR api_secret OR password OR token`;
          const results = await searchGitHubCode(token, query, env);
          apiCalls++;
          const processed = await processCodeResults(env, results, brand, 'code_leak');
          itemsFetched += processed.fetched;
          itemsNew += processed.new;
          itemsDuplicate += processed.duplicate;
        } catch (err) {
          itemsError++;
          console.error(`[github] Credential search error for ${brand.name}:`, err instanceof Error ? err.message : String(err));
        }

        await delay(DELAY_BETWEEN_CALLS_MS);
      }
    }

    // 3. Security advisory monitoring — only if we still have budget.
    if (apiCalls < MAX_SEARCH_CALLS_PER_RUN && !walltimeExceeded()) {
      try {
        const advisories = await fetchSecurityAdvisories(token, env);
        apiCalls++;

        // Load all monitored brand names for matching
        const allBrands = await env.DB.prepare(`
          SELECT id, name, canonical_domain FROM brands
          WHERE monitoring_status = 'active' AND threat_count > 0
          ORDER BY threat_count DESC LIMIT 50
        `).all<BrandRow>();

        for (const advisory of advisories) {
          const advisoryText = `${advisory.summary} ${advisory.description}`.toLowerCase();
          const pkgNames = advisory.vulnerabilities.map(v => v.package.name.toLowerCase());

          for (const brand of allBrands.results) {
            const nameMatch = advisoryText.includes(brand.name.toLowerCase()) ||
              pkgNames.some(p => p.includes(brand.name.toLowerCase()));
            const domainMatch = brand.canonical_domain
              ? advisoryText.includes(brand.canonical_domain.toLowerCase())
              : false;

            if (nameMatch || domainMatch) {
              const result = await insertAdvisoryMention(env, advisory, brand);
              if (result === 'new') itemsNew++;
              else if (result === 'duplicate') itemsDuplicate++;
              itemsFetched++;
            }
          }
        }
      } catch (err) {
        itemsError++;
        console.error('[github] Advisory fetch error:', err instanceof Error ? err.message : String(err));
      }
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(`[github] Complete: fetched=${itemsFetched} new=${itemsNew} dup=${itemsDuplicate} errors=${itemsError} api_calls=${apiCalls} elapsed_ms=${elapsedMs}`);

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};

// ─── GitHub API Calls ────────────────────────────────────────────

async function searchGitHubCode(token: string, query: string, env: Env): Promise<GitHubCodeSearchResult> {
  // Check cache (query hash -> results for 4 hours)
  const cacheKey = `github_search:${hashString(query)}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as GitHubCodeSearchResult;
  }

  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&sort=indexed&order=desc&per_page=25`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.text-match+json',
      'User-Agent': 'Averrow/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub code search ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = await response.json() as GitHubCodeSearchResult;

  // Cache for 4 hours
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 14400 });

  return result;
}

async function fetchSecurityAdvisories(token: string, env: Env): Promise<GitHubAdvisory[]> {
  const cacheKey = 'github_advisories_latest';
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as GitHubAdvisory[];
  }

  const url = 'https://api.github.com/advisories?type=reviewed&per_page=25&sort=published&direction=desc';

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Averrow/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub advisories ${response.status}: ${text.slice(0, 200)}`);
  }

  const advisories = await response.json() as GitHubAdvisory[];

  // Cache for 4 hours
  await env.CACHE.put(cacheKey, JSON.stringify(advisories), { expirationTtl: 14400 });

  return advisories;
}

// ─── Result Processing ───────────────────────────────────────────

async function processCodeResults(
  env: Env,
  results: GitHubCodeSearchResult,
  brand: BrandRow,
  matchType: string,
): Promise<{ fetched: number; new: number; duplicate: number }> {
  let fetched = 0;
  let newCount = 0;
  let duplicate = 0;

  for (const item of results.items) {
    fetched++;

    // Filter out results older than 30 days
    const repoUpdated = new Date(item.repository.updated_at);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (repoUpdated < thirtyDaysAgo) continue;

    const sha = item.sha;
    const dedupKey = `social:github:${sha}:${brand.id}`;

    // KV dedup
    const seen = await env.CACHE.get(dedupKey);
    if (seen) { duplicate++; continue; }

    // DB dedup
    const existing = await env.DB.prepare(
      `SELECT id FROM social_mentions WHERE platform = 'github' AND id = ?`
    ).bind(`github_${sha}_${brand.id}`).first();
    if (existing) {
      await env.CACHE.put(dedupKey, '1', { expirationTtl: 14400 });
      duplicate++;
      continue;
    }

    // Build content text from available data
    const textFragments = item.text_matches?.map(m => m.fragment).join('\n') ?? '';
    const contentText = `${item.repository.full_name}/${item.path}\n${item.repository.description ?? ''}\n${textFragments}`.slice(0, 2000);

    // Determine confidence based on match type
    const hasSecretPatterns = /api[_-]?key|api[_-]?secret|password|token|private[_-]?key|\.env\b/i.test(contentText);
    const confidence = matchType === 'code_leak' && hasSecretPatterns ? 90 : matchType === 'code_leak' ? 70 : 60;

    try {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO social_mentions
          (id, platform, source_feed, content_type, content_url, content_text,
           content_author, content_author_url, content_created,
           brand_id, brand_name, match_type, match_confidence,
           platform_metadata, status, created_at, updated_at)
        VALUES (?, 'github', 'github', 'code_file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))
      `).bind(
        `github_${sha}_${brand.id}`,
        item.html_url,
        contentText,
        item.repository.owner.login,
        item.repository.owner.html_url,
        item.repository.updated_at,
        brand.id,
        brand.name,
        matchType,
        confidence,
        JSON.stringify({
          repo_name: item.repository.full_name,
          repo_stars: item.repository.stargazers_count,
          file_path: item.path,
          language: item.repository.language,
          sha,
        }),
      ).run();

      await env.CACHE.put(dedupKey, '1', { expirationTtl: 14400 });
      newCount++;
    } catch (err) {
      console.error(`[github] Insert error for ${sha}:`, err instanceof Error ? err.message : String(err));
    }
  }

  return { fetched, new: newCount, duplicate };
}

async function insertAdvisoryMention(
  env: Env,
  advisory: GitHubAdvisory,
  brand: BrandRow,
): Promise<'new' | 'duplicate' | 'error'> {
  const dedupKey = `social:github:advisory:${advisory.ghsa_id}:${brand.id}`;

  const seen = await env.CACHE.get(dedupKey);
  if (seen) return 'duplicate';

  const mentionId = `github_advisory_${advisory.ghsa_id}_${brand.id}`;
  const existing = await env.DB.prepare(
    `SELECT id FROM social_mentions WHERE id = ?`
  ).bind(mentionId).first();
  if (existing) {
    await env.CACHE.put(dedupKey, '1', { expirationTtl: 14400 });
    return 'duplicate';
  }

  const contentText = `${advisory.summary}\n\n${advisory.description}`.slice(0, 2000);

  // Map GitHub severity to our severity
  const severityMap: Record<string, string> = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' };
  const severity = severityMap[advisory.severity] ?? 'medium';

  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO social_mentions
        (id, platform, source_feed, content_type, content_url, content_text,
         content_author, content_created,
         brand_id, brand_name, match_type, match_confidence,
         threat_type, severity,
         platform_metadata, status, created_at, updated_at)
      VALUES (?, 'github', 'github', 'advisory', ?, ?, 'github-security', ?, ?, ?, 'domain', 75, 'vulnerability_disclosure', ?, ?, 'new', datetime('now'), datetime('now'))
    `).bind(
      mentionId,
      advisory.html_url,
      contentText,
      advisory.published_at,
      brand.id,
      brand.name,
      severity,
      JSON.stringify({
        ghsa_id: advisory.ghsa_id,
        cve_id: advisory.cve_id,
        severity: advisory.severity,
        packages: advisory.vulnerabilities.map(v => `${v.package.ecosystem}/${v.package.name}`),
      }),
    ).run();

    await env.CACHE.put(dedupKey, '1', { expirationTtl: 14400 });
    return 'new';
  } catch (err) {
    console.error(`[github] Advisory insert error for ${advisory.ghsa_id}:`, err instanceof Error ? err.message : String(err));
    return 'error';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
