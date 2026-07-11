/**
 * CertStream Real-Time Certificate Transparency Monitor
 *
 * Durable Object that maintains a persistent outbound WebSocket connection
 * to CertStream (certstream.calidog.io). Filters certificates in real-time
 * against monitored brand keywords and phishing patterns. Suspicious
 * certificates are batched and written to D1 every 30 seconds via alarm.
 */

import type { Env } from '../types';
import { computeSanHash } from '../lib/ssl-cert-identity';

interface CertStreamMessage {
  message_type: 'certificate_update' | 'heartbeat';
  data: {
    update_type: string;
    leaf_cert: {
      subject: { CN: string; O?: string };
      all_domains: string[];
      issuer: { O: string; CN: string };
      not_before: number;
      not_after: number;
      fingerprint: string;
      serial_number: string;
    };
    source: {
      url: string;
      name: string;
    };
    cert_index: number;
  };
}

interface PendingMatch {
  domain: string;
  allDomains: string;
  sanDomains: string[];
  serialNumber: string;
  issuer: string;
  fingerprint: string;
  source: string;
  brandMatch: string | null;
  phishScore: number;
  certNotBefore: number;
  certNotAfter: number;
  timestamp: number;
}

export class CertStreamMonitor {
  private ws: WebSocket | null = null;
  private brandKeywords: string[] = [];
  private brandDomains: string[] = [];
  private pendingMatches: PendingMatch[] = [];
  private lastBrandReload = 0;
  private stats = {
    connected: false,
    certsProcessed: 0,
    certsMatched: 0,
    certsWritten: 0,
    lastCertAt: 0,
    connectTime: 0,
    errors: 0,
  };

  constructor(
    private ctx: DurableObjectState,
    private env: Env
  ) {}

  // Called by cron or API to start/check the stream
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/start') {
      await this.ensureConnected();
      return Response.json({ status: 'running', stats: this.stats });
    }

    if (url.pathname === '/stop') {
      this.disconnect();
      return Response.json({ status: 'stopped' });
    }

    if (url.pathname === '/stats') {
      return Response.json({
        status: this.ws ? 'connected' : 'disconnected',
        stats: this.stats,
        pendingBatch: this.pendingMatches.length,
        brandKeywords: this.brandKeywords.length,
        brandDomains: this.brandDomains.length,
      });
    }

    if (url.pathname === '/reload-brands') {
      await this.loadBrandKeywords();
      return Response.json({
        brandsLoaded: this.brandKeywords.length,
        domainsLoaded: this.brandDomains.length,
      });
    }

    return Response.json({ error: 'unknown endpoint' }, { status: 404 });
  }

  private async ensureConnected() {
    // Always ensure alarm chain is running (survives DO hibernation)
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      console.log('[certstream] Alarm chain (re)started');
    }

    // If WS is already connected and receiving data, nothing to do
    if (this.ws && this.stats.connected) {
      // Check staleness — reconnect if no data for 90s
      if (this.stats.lastCertAt > 0 && Date.now() - this.stats.lastCertAt > 90_000) {
        console.log('[certstream] Connection stale (no data for 90s) — forcing reconnect');
        this.disconnect();
      } else {
        return;
      }
    }

    await this.loadBrandKeywords();
    await this.connect();
    console.log(`[certstream] ensureConnected complete — ws=${!!this.ws}, brands=${this.brandKeywords.length}`);
  }

  private async connect() {
    try {
      const resp = await fetch('https://certstream.calidog.io/', {
        headers: { 'Upgrade': 'websocket' },
      });

      const ws = resp.webSocket;
      if (!ws) {
        console.error('[certstream] Failed to establish WebSocket');
        this.stats.errors++;
        return;
      }

      ws.accept();
      this.ws = ws;
      this.stats.connected = true;
      this.stats.connectTime = Date.now();

      ws.addEventListener('message', (event) => {
        this.handleMessage(event.data as string);
      });

      ws.addEventListener('close', () => {
        console.log('[certstream] WebSocket closed — will reconnect');
        this.ws = null;
        this.stats.connected = false;
      });

      ws.addEventListener('error', () => {
        console.error('[certstream] WebSocket error');
        this.ws = null;
        this.stats.connected = false;
        this.stats.errors++;
      });

      console.log('[certstream] Connected to CertStream');
    } catch (err) {
      console.error('[certstream] Connection failed:', err);
      this.stats.errors++;
    }
  }

  private handleMessage(raw: string) {
    try {
      const msg: CertStreamMessage = JSON.parse(raw);

      if (msg.message_type !== 'certificate_update') return;

      this.stats.certsProcessed++;
      this.stats.lastCertAt = Date.now();

      const domains = msg.data.leaf_cert.all_domains || [];
      if (domains.length === 0) return;

      // Check each domain against filters
      for (const domain of domains) {
        const lowerDomain = domain.toLowerCase().replace(/^\*\./, '');

        // Filter 1: Brand keyword match
        const brandMatch = this.matchBrand(lowerDomain);

        // Filter 2: Phishing pattern detection
        const phishScore = this.scorePhishingPatterns(lowerDomain);

        if (brandMatch || phishScore >= 70) {
          this.stats.certsMatched++;
          this.pendingMatches.push({
            domain: lowerDomain,
            allDomains: domains.join(', '),
            // Raw SAN set for the Lane C hash — keep the array so
            // computeSanHash() derives identically to the crt.sh source.
            sanDomains: domains,
            serialNumber: msg.data.leaf_cert.serial_number || '',
            issuer: msg.data.leaf_cert.issuer?.O || msg.data.leaf_cert.issuer?.CN || 'unknown',
            fingerprint: msg.data.leaf_cert.fingerprint,
            source: msg.data.source?.name || 'unknown',
            brandMatch: brandMatch,
            phishScore: phishScore,
            certNotBefore: msg.data.leaf_cert.not_before,
            certNotAfter: msg.data.leaf_cert.not_after,
            timestamp: Date.now(),
          });
          break; // one match per certificate is enough
        }
      }
    } catch {
      // Silently skip malformed messages (CertStream occasionally sends garbage)
    }
  }

  private matchBrand(domain: string): string | null {
    // Check against brand domains (exact or substring)
    for (const brandDomain of this.brandDomains) {
      // Skip if it IS the actual brand domain
      if (domain === brandDomain || domain.endsWith('.' + brandDomain)) continue;

      // Check if the brand domain name appears in this domain
      const brandBase = brandDomain.split('.')[0] ?? '';
      if (brandBase.length >= 4 && domain.includes(brandBase)) {
        return brandDomain;
      }
    }

    // Check against brand keywords
    for (const keyword of this.brandKeywords) {
      if (keyword.length >= 4 && domain.includes(keyword)) {
        return keyword;
      }
    }

    return null;
  }

  private scorePhishingPatterns(domain: string): number {
    let score = 0;
    const baseDomain = domain.split('.')[0] ?? '';

    // High-entropy domain (DGA-like)
    const entropy = this.calculateEntropy(baseDomain);
    if (entropy > 4.0) score += 20;

    // Suspicious TLD
    const suspiciousTLDs = ['.tk', '.ml', '.ga', '.cf', '.gq', '.xyz', '.top',
      '.click', '.loan', '.work', '.date', '.racing', '.win', '.bid', '.stream',
      '.download', '.gdn', '.review', '.accountant', '.science', '.party'];
    if (suspiciousTLDs.some(tld => domain.endsWith(tld))) score += 25;

    // Phishing keywords in domain
    const phishKeywords = ['login', 'signin', 'verify', 'update', 'secure',
      'account', 'banking', 'confirm', 'password', 'credential', 'wallet',
      'authenticate', 'authorize', 'validation', 'recovery', 'suspend',
      'invoice', 'payment', 'billing', 'refund', 'claim'];
    const matchedKeywords = phishKeywords.filter(kw => domain.includes(kw));
    score += matchedKeywords.length * 15;

    // Multiple hyphens (common in phishing: secure-login-verify-account.com)
    const hyphenCount = (domain.match(/-/g) || []).length;
    if (hyphenCount >= 3) score += 20;
    else if (hyphenCount >= 2) score += 10;

    // Long subdomain chains
    const dotCount = (domain.match(/\./g) || []).length;
    if (dotCount >= 4) score += 15;

    // Homoglyph detection (basic: mixed letters and digits in base domain)
    if (/[0-9]/.test(baseDomain) && /[a-z]/.test(baseDomain)) {
      if (baseDomain.match(/[01][a-z]|[a-z][01]/)) score += 15;
    }

    return Math.min(score, 100);
  }

  private calculateEntropy(str: string): number {
    if (str.length === 0) return 0;
    const freq: Record<string, number> = {};
    for (const c of str) freq[c] = (freq[c] || 0) + 1;
    const len = str.length;
    let entropy = 0;
    for (const c in freq) {
      const p = (freq[c] ?? 0) / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  // Alarm handler — runs every 30 seconds
  async alarm() {
    // Flush pending matches to D1
    if (this.pendingMatches.length > 0) {
      await this.flushMatches();
    }

    // Check connection health
    if (!this.ws) {
      console.log('[certstream] Connection lost — reconnecting');
      await this.connect();
    }

    // Check if we're receiving data (no cert in last 60 seconds = stale)
    if (this.stats.lastCertAt > 0 && Date.now() - this.stats.lastCertAt > 60_000) {
      console.log('[certstream] No data for 60s — reconnecting');
      this.disconnect();
      await this.connect();
    }

    // Reload brand keywords every hour
    if (Date.now() - this.lastBrandReload > 3600_000) {
      await this.loadBrandKeywords();
    }

    // Update feed_status for dashboard
    try {
      await this.env.DB.prepare(`
        UPDATE feed_status
        SET health_status = ?,
            records_ingested_today = ?,
            last_successful_pull = datetime('now')
        WHERE feed_name = 'certstream'
      `).bind(
        this.stats.connected ? 'healthy' : 'degraded',
        this.stats.certsWritten
      ).run();
    } catch {
      // Non-fatal — feed_status row may not exist yet
    }

    // Schedule next alarm
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  private async flushMatches() {
    const matches = this.pendingMatches.splice(0, 100); // batch of 100 max
    if (matches.length === 0) return;

    try {
      const db = this.env.DB;
      // Pre-compute Lane C SAN hashes (async Web Crypto) before building
      // the statement batch, index-aligned with `matches`. Same shared
      // helper the crt.sh source uses so a cert seen via either path
      // hashes identically.
      const sanHashes = await Promise.all(
        matches.map((m) => computeSanHash(m.sanDomains)),
      );
      const stmts = matches.map((m, i) =>
        db.prepare(`
          INSERT OR IGNORE INTO threats (
            id, malicious_domain, malicious_url, threat_type, severity,
            confidence_score, source_feed, first_seen, title, tags,
            ssl_cert_serial, ssl_cert_issuer, ssl_san_hash
          ) VALUES (?, ?, ?, ?, ?, ?, 'certstream', datetime('now'), ?, ?, ?, ?, ?)
        `).bind(
          `cs_${crypto.randomUUID().slice(0, 12)}`,
          m.domain,
          `https://${m.domain}`,
          m.brandMatch ? 'typosquatting' : 'suspicious_certificate',
          m.brandMatch ? 'high' : (m.phishScore >= 85 ? 'high' : 'medium'),
          Math.min(m.phishScore + (m.brandMatch ? 30 : 0), 100),
          m.brandMatch
            ? `[CERTSTREAM] Brand impersonation: ${m.domain} (matches ${m.brandMatch})`
            : `[CERTSTREAM] Suspicious cert: ${m.domain} (phish score: ${m.phishScore})`,
          JSON.stringify({
            certstream: true,
            issuer: m.issuer,
            fingerprint: m.fingerprint,
            source_log: m.source,
            brand_match: m.brandMatch,
            phish_score: m.phishScore,
            all_domains: m.allDomains,
          }),
          m.serialNumber || null,
          m.issuer || null,
          sanHashes[i] ?? null,
        )
      );

      await db.batch(stmts);
      this.stats.certsWritten += matches.length;
      console.log(`[certstream] Flushed ${matches.length} threats to D1`);
    } catch (err) {
      console.error('[certstream] D1 write error:', err);
      // Put matches back for retry
      this.pendingMatches.unshift(...matches);
      this.stats.errors++;
    }
  }

  private async loadBrandKeywords() {
    try {
      const db = this.env.DB;

      // Load monitored brand names and domains (use monitored_brands join for consistency)
      const brands = await db.prepare(`
        SELECT b.name, b.canonical_domain
        FROM brands b
        LEFT JOIN monitored_brands mb ON mb.brand_id = b.id
        WHERE b.monitoring_status = 'active' OR mb.status = 'active'
      `).all<{ name: string; canonical_domain: string | null }>();

      this.brandDomains = [];
      this.brandKeywords = [];

      for (const brand of (brands.results || [])) {
        if (brand.canonical_domain) this.brandDomains.push(brand.canonical_domain.toLowerCase());
        if (brand.name) {
          const name = brand.name.toLowerCase();
          if (name.length >= 4) this.brandKeywords.push(name);
        }
      }

      // Also load brand_keywords JSON arrays from brands table
      const keywordRows = await db.prepare(`
        SELECT brand_keywords FROM brands
        WHERE brand_keywords IS NOT NULL AND monitoring_status = 'active'
      `).all<{ brand_keywords: string }>();

      for (const row of (keywordRows.results || [])) {
        try {
          const keywords = JSON.parse(row.brand_keywords);
          if (Array.isArray(keywords)) {
            for (const kw of keywords) {
              if (typeof kw === 'string' && kw.length >= 4) {
                this.brandKeywords.push(kw.toLowerCase());
              }
            }
          }
        } catch {
          // Skip malformed JSON
        }
      }

      // Also load aliases from brands table
      const aliasRows = await db.prepare(`
        SELECT aliases FROM brands
        WHERE aliases IS NOT NULL AND monitoring_status = 'active'
      `).all<{ aliases: string }>();

      for (const row of (aliasRows.results || [])) {
        try {
          const aliases = JSON.parse(row.aliases);
          if (Array.isArray(aliases)) {
            for (const a of aliases) {
              if (typeof a === 'string' && a.length >= 4) {
                this.brandKeywords.push(a.toLowerCase());
              }
            }
          }
        } catch {
          // Skip malformed JSON
        }
      }

      // Deduplicate
      this.brandKeywords = [...new Set(this.brandKeywords)];
      this.brandDomains = [...new Set(this.brandDomains)];
      this.lastBrandReload = Date.now();

      console.log(`[certstream] Loaded ${this.brandKeywords.length} keywords, ${this.brandDomains.length} domains`);
    } catch (err) {
      console.error('[certstream] Failed to load brands:', err);
    }
  }

  private disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
      this.stats.connected = false;
    }
  }
}
