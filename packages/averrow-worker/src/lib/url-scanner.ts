/**
 * Sparrow Phase 1 — URL Scanner
 *
 * Scans URLs extracted from spam trap captures against internal
 * threat intelligence. Phase 1: internal DB checks only.
 * Future phases add Google Safe Browsing, VirusTotal, etc.
 */

import { extractDomain } from './domain-utils';
import type { Env } from '../types';

export interface UrlScanInput {
  url: string;
  source_type: 'spam_trap' | 'threat_signal' | 'manual';
  source_id?: string;
  brand_id?: string;
}

export interface UrlScanOutput {
  url: string;
  domain: string;
  is_malicious: boolean;
  confidence: number;
  reasons: string[];
  known_threat_id: string | null;
  hosting_provider: string | null;
  registrar: string | null;
}

/**
 * Scan a single URL against internal threat intelligence.
 */
export async function scanUrl(env: Env, input: UrlScanInput): Promise<UrlScanOutput> {
  const domain = extractDomain(input.url) || '';
  const reasons: string[] = [];
  let confidence = 0;
  let knownThreatId: string | null = null;

  // Check 1: Is this URL or domain in our threats table?
  const knownThreat = await env.DB.prepare(`
    SELECT id, threat_type, severity, hosting_provider_id
    FROM threats
    WHERE (malicious_url = ? OR malicious_domain = ?)
    AND status = 'active'
    LIMIT 1
  `).bind(input.url, domain).first<{ id: string; threat_type: string; severity: string; hosting_provider_id: string | null }>();

  if (knownThreat) {
    reasons.push(`Known active threat: ${knownThreat.threat_type} (${knownThreat.severity})`);
    confidence += 0.8;
    knownThreatId = knownThreat.id;
  }

  // Check 2: Is this domain a known phishing domain from threat_signals?
  const phishingSignal = await env.DB.prepare(`
    SELECT id, signal_type, severity
    FROM threat_signals
    WHERE indicator = ? AND signal_type = 'phishing_url'
    LIMIT 1
  `).bind(domain).first();

  if (phishingSignal) {
    reasons.push('Domain flagged in threat signals as phishing');
    confidence += 0.3;
  }

  // Check 3: Is this domain in our brands safe list? If yes, NOT malicious
  const safeDomain = await env.DB.prepare(`
    SELECT 1 FROM brand_safe_domains WHERE domain = ?
    LIMIT 1
  `).bind(domain).first();

  if (safeDomain) {
    confidence = 0;
    reasons.length = 0;
    reasons.push('Domain is in safe domains list');
  }

  // Check 4: Recently appeared in threats (last 7 days = suspicious)
  if (!safeDomain) {
    const recentThreat = await env.DB.prepare(`
      SELECT COUNT(*) as c FROM threats
      WHERE malicious_domain = ? AND created_at > datetime('now', '-7 days')
    `).bind(domain).first<{ c: number }>();

    if ((recentThreat?.c ?? 0) > 0) {
      reasons.push(`Domain appeared in ${recentThreat!.c} threats in last 7 days`);
      confidence += 0.2;
    }
  }

  // Check 5: Is this domain a registered lookalike of a known brand?
  const lookalike = await env.DB.prepare(`
    SELECT brand_id, threat_level FROM lookalike_domains
    WHERE domain = ? AND registered = 1
    LIMIT 1
  `).bind(domain).first<{ brand_id: string; threat_level: string }>();

  if (lookalike) {
    reasons.push(`Registered lookalike domain (threat level: ${lookalike.threat_level})`);
    confidence += 0.4;
  }

  // Look up hosting provider name
  const provider = await env.DB.prepare(`
    SELECT name FROM hosting_providers WHERE id = (
      SELECT hosting_provider_id FROM threats WHERE malicious_domain = ? LIMIT 1
    )
  `).bind(domain).first<{ name: string }>();

  // Cap confidence at 1.0
  confidence = Math.min(confidence, 1.0);

  return {
    url: input.url,
    domain,
    is_malicious: confidence >= 0.5,
    confidence,
    reasons,
    known_threat_id: knownThreatId,
    hosting_provider: provider?.name ?? null,
    registrar: null, // Future: WHOIS lookup
  };
}

/**
 * Scan all URLs from a spam trap capture.
 * Extracts URLs from body_preview, then scans each one.
 */
export async function scanCaptureUrls(env: Env, captureId: number): Promise<UrlScanOutput[]> {
  const capture = await env.DB.prepare(
    "SELECT id, body_preview, spoofed_brand_id FROM spam_trap_captures WHERE id = ?"
  ).bind(captureId).first<{ id: number; body_preview: string | null; spoofed_brand_id: string | null }>();

  if (!capture || !capture.body_preview) return [];

  // Extract URLs from body
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
  const urls = [...new Set(capture.body_preview.match(urlRegex) || [])];

  if (urls.length === 0) return [];

  const results: UrlScanOutput[] = [];

  for (const url of urls.slice(0, 20)) { // Cap at 20 URLs per capture
    const result = await scanUrl(env, {
      url,
      source_type: 'spam_trap',
      source_id: String(capture.id),
      brand_id: capture.spoofed_brand_id ?? undefined,
    });

    // Save to url_scan_results table
    await env.DB.prepare(`
      INSERT INTO url_scan_results (
        url, domain, source_type, source_id, brand_id,
        known_threat, known_threat_id,
        hosting_provider, is_malicious, malicious_reasons,
        confidence_score, scanned_at
      ) VALUES (?, ?, 'spam_trap', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      result.url, result.domain, String(capture.id),
      capture.spoofed_brand_id, result.known_threat_id ? 1 : 0,
      result.known_threat_id, result.hosting_provider,
      result.is_malicious ? 1 : 0, JSON.stringify(result.reasons),
      result.confidence
    ).run();

    results.push(result);
  }

  return results;
}

/**
 * Batch scan: process all unscanned spam trap captures.
 * Called by Sparrow agent or cron.
 */
export async function scanUnprocessedCaptures(env: Env, limit: number = 10): Promise<{
  captures_processed: number;
  urls_scanned: number;
  malicious_found: number;
}> {
  // Find captures that haven't been URL-scanned yet
  const unscanned = await env.DB.prepare(`
    SELECT stc.id FROM spam_trap_captures stc
    WHERE stc.id NOT IN (
      SELECT DISTINCT CAST(source_id AS INTEGER) FROM url_scan_results WHERE source_type = 'spam_trap'
    )
    AND stc.body_preview IS NOT NULL
    ORDER BY stc.captured_at DESC
    LIMIT ?
  `).bind(limit).all<{ id: number }>();

  let urlsScanned = 0;
  let maliciousFound = 0;

  for (const capture of unscanned.results || []) {
    const results = await scanCaptureUrls(env, capture.id);
    urlsScanned += results.length;
    maliciousFound += results.filter(r => r.is_malicious).length;
  }

  return {
    captures_processed: unscanned.results?.length ?? 0,
    urls_scanned: urlsScanned,
    malicious_found: maliciousFound,
  };
}
