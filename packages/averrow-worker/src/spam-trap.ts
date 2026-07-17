/**
 * Spam Trap Email Receiver
 *
 * Processes all non-DMARC emails arriving at averrow.com (trustradar.ca and lrxradar.com retained for legacy compat).
 * Extracts authentication signals, IOCs, brand matches, and creates threat records.
 * This is Averrow's proprietary data source.
 *
 * Critical: never call setReject() — accepting silently prevents spammers from
 * learning that the address is monitored.
 */

import type { Env } from "./types";
import type { EmailMessage } from "./dmarc-receiver";
import { extractDomain } from "./lib/domain-utils";
import { createNotification } from "./lib/notifications";

// ─── Interfaces ────────────────────────────────────────────────────

interface TrapInfo {
  domain: string;
  channel: string;
  campaignId: number | null;
  brandTarget: string | null;
}

interface AuthResults {
  spf: string;
  spfDomain: string;
  dkim: string;
  dkimDomain: string;
  dmarc: string;
  dmarcDisposition: string;
}

interface BrandMatch {
  brandId: string;
  spoofedDomain: string;
  method: string;
  confidence: number;
}

// ─── Main Handler ──────────────────────────────────────────────────

export async function handleSpamTrapEmail(message: EmailMessage, env: Env): Promise<void> {
  const startTime = Date.now();
  const to = message.to;
  const from = message.from;
  const subject = message.headers.get("subject") || "";

  const trapInfo = parseTrapAddress(to);

  // Read raw email
  const rawEmail = await streamToArrayBuffer(message.raw);
  const rawText = new TextDecoder().decode(rawEmail);

  // Extract headers
  const headers = extractHeaders(rawText);

  // Parse Authentication-Results — check both standard and ARC headers (Cloudflare Email Routing)
  const authHeader = headers["authentication-results"]
    || headers["arc-authentication-results"]
    || "";
  const authResults = parseAuthenticationResults(authHeader);

  // Extract sending IP from Received headers
  const sendingIp = extractSendingIp(headers);

  // Extract From domain
  const fromDomain = extractDomain(from) ?? '';

  // Extract URLs from body
  const body = extractBody(rawText);
  const urls = extractUrls(body);

  // Extract attachment info
  const attachments = extractAttachmentInfo(rawEmail);

  // Match to a monitored brand
  const brandMatch = await matchBrand(from, subject, urls, headers["reply-to"] || "", env);

  // Classify the email
  const classification = classifyEmail(authResults, urls, attachments, brandMatch);

  // Calculate severity
  const severity = calculateSeverity(authResults, brandMatch, urls.length, attachments.length);

  // Store the capture
  const captureResult = await env.DB.prepare(`
    INSERT INTO spam_trap_captures (
      trap_address, trap_domain, trap_channel, trap_campaign_id,
      from_address, from_domain, reply_to, return_path, helo_hostname, subject,
      spf_result, spf_domain, dkim_result, dkim_domain, dmarc_result, dmarc_disposition,
      sending_ip, x_mailer,
      urls_found, url_count, attachment_hashes, attachment_count,
      spoofed_brand_id, spoofed_domain, brand_match_method, brand_confidence,
      category, severity,
      raw_headers, body_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    to, trapInfo.domain, trapInfo.channel, trapInfo.campaignId,
    from, fromDomain, headers["reply-to"] || null, headers["return-path"] || null,
    extractHeloHostname(headers), subject.substring(0, 500),
    authResults.spf, authResults.spfDomain, authResults.dkim, authResults.dkimDomain,
    authResults.dmarc, authResults.dmarcDisposition,
    sendingIp, headers["x-mailer"] || null,
    JSON.stringify(urls.slice(0, 50)), urls.length,
    JSON.stringify(attachments.slice(0, 10)), attachments.length,
    brandMatch?.brandId || null, brandMatch?.spoofedDomain || fromDomain,
    brandMatch?.method || null, brandMatch?.confidence || 0,
    classification.category, severity,
    truncateHeaders(rawText, 5000), body.substring(0, 500)
  ).run();

  const captureId = captureResult.meta?.last_row_id;

  // Update seed address catch count
  await env.DB.prepare(`
    UPDATE seed_addresses SET total_catches = total_catches + 1, last_catch_at = datetime('now')
    WHERE address = ?
  `).bind(to).run();

  // Update seed campaign catch count
  if (trapInfo.campaignId) {
    await env.DB.prepare(`
      UPDATE seed_campaigns SET total_catches = total_catches + 1, last_catch_at = datetime('now')
      WHERE id = ?
    `).bind(trapInfo.campaignId).run();
  }

  // Create threat record if this looks like phishing/malware
  if (classification.category === "phishing" || classification.category === "malware") {
    const threatId = await createThreatFromCapture(env, {
      fromDomain, sendingIp, urls, brandMatch, classification, severity, subject,
    });

    if (threatId && captureId) {
      await env.DB.prepare(
        "UPDATE spam_trap_captures SET threat_id = ?, processed = 1 WHERE id = ?"
      ).bind(threatId, captureId).run();
    }
  }

  // Fire notification if a monitored brand was spoofed.
  //
  // N1: was a raw INSERT bypassing createNotification — no user_id, no
  // audience routing, no dedup, no push dispatch. Now goes through the
  // canonical helper with explicit tenant audience + brandId so brand
  // subscribers receive it and operators don't get spam-trap pings unless
  // they opted into the tenant firehose.
  //
  // Type uses 'brand_threat' (the closest existing registry key) so this
  // rides the same user-toggleable + dedup machinery as phishing/
  // impersonation alerts. A dedicated `spam_trap_capture` event key can
  // be added to @averrow/shared in a follow-up if operators want to mute
  // it independently.
  const severityForNotification: 'critical' | 'high' | 'medium' | 'low' | 'info' =
    severity === 'critical' || severity === 'high' || severity === 'medium' || severity === 'low' || severity === 'info'
      ? severity
      : 'medium';
  if (brandMatch?.brandId) {
    try {
      await createNotification(env, {
        audience: 'tenant',
        brandId: brandMatch.brandId,
        type: 'brand_threat',
        severity: severityForNotification,
        title: `Spam trap: ${brandMatch.spoofedDomain} spoofed`,
        message: `Caught email from ${from} impersonating ${brandMatch.spoofedDomain}. Subject: "${subject.substring(0, 100)}". Auth: SPF=${authResults.spf}, DKIM=${authResults.dkim}, DMARC=${authResults.dmarc}`,
        link: `/brands/${brandMatch.brandId}`,
        metadata: {
          brand_id: brandMatch.brandId,
          source: 'spam_trap',
          spoofed_domain: brandMatch.spoofedDomain,
          sending_ip: sendingIp,
          spf: authResults.spf,
          dkim: authResults.dkim,
          dmarc: authResults.dmarc,
        },
      });
    } catch (err) {
      console.error('[spam-trap] notification error:', err);
    }
  }

}

// ─── Trap Address Parser ───────────────────────────────────────────

export function parseTrapAddress(address: string): TrapInfo {
  const parts = address.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";

  // Brand traps: apple-support@trustradar.ca, amazon-billing@trustradar.ca
  const brandTrapMatch = local.match(/^([\w]+)-(support|billing|account|verify|security|id|help|sign)$/);
  if (brandTrapMatch) {
    return { domain, channel: "brand", campaignId: null, brandTarget: brandTrapMatch[1] ?? null };
  }

  // Spider traps: spider-pub-footer-0318@trustradar.ca
  if (local.startsWith("spider-")) {
    return { domain, channel: "spider", campaignId: null, brandTarget: null };
  }

  // Paste traps: paste-c012-amz-0318@trustradar.ca
  const pasteMatch = local.match(/^paste-c(\d+)/);
  if (pasteMatch) {
    return { domain, channel: "paste", campaignId: parseInt(pasteMatch[1] ?? "0"), brandTarget: null };
  }

  // Honeypot traps: honey-team-003@trustradar.ca
  if (local.startsWith("honey-")) {
    return { domain, channel: "honeypot", campaignId: null, brandTarget: null };
  }

  // Employee traps: james.wilson@trustradar.ca, ceo@trustradar.ca
  if (local.includes(".") || ["ceo", "cfo", "cto", "hr", "finance"].includes(local)) {
    return { domain, channel: "employee", campaignId: null, brandTarget: null };
  }

  // Seed traps: info-cp01@trustradar.ca, admin-wh01@trustradar.ca, etc.
  const seedMatch = local.match(/^[\w]+-([a-z]{2})\d+$/);
  if (seedMatch) {
    const channelMap: Record<string, string> = { cp: "contact_page", wh: "whois", fp: "forum", ps: "paste", bd: "directory", hp: "honeypot", gp: "github" };
    return { domain, channel: channelMap[seedMatch[1]!] || "seed", campaignId: null, brandTarget: null };
  }

  // Generic traps: admin@, info@, support@, etc.
  return { domain, channel: "generic", campaignId: null, brandTarget: null };
}

// ─── Authentication-Results Parser ─────────────────────────────────

export function parseAuthenticationResults(header: string): AuthResults {
  const result: AuthResults = {
    spf: "none", spfDomain: "", dkim: "none", dkimDomain: "",
    dmarc: "none", dmarcDisposition: "none",
  };

  if (!header) return result;

  // SPF — handle both traditional and Cloudflare formats
  // e.g. "spf=pass smtp.mailfrom=example.com" or "spf=pass (domain of example.com)"
  const spfMatch = header.match(/spf=(\w+)/i);
  if (spfMatch) result.spf = (spfMatch[1] ?? "").toLowerCase();
  const spfDomainMatch = header.match(/spf=\w+[^;]*smtp\.mailfrom=(\S+)/i) ||
                          header.match(/spf=\w+[^;]*smtp\.helo=(\S+)/i) ||
                          header.match(/spf=\w+[^;]*domain[:\s]+of\s+(\S+)/i) ||
                          header.match(/spf=\w+[^;]*\(.*?domain:?\s*(\S+)/i);
  if (spfDomainMatch) result.spfDomain = (spfDomainMatch[1] ?? "").replace(/[);]/g, "");

  // DKIM — e.g. "dkim=pass header.d=example.com header.s=selector header.b=xxx"
  const dkimMatch = header.match(/dkim=(\w+)/i);
  if (dkimMatch) result.dkim = (dkimMatch[1] ?? "").toLowerCase();
  const dkimDomainMatch = header.match(/dkim=\w+[^;]*header\.d=@?(\S+)/i) ||
                           header.match(/dkim=\w+[^;]*header\.[is]=@?(\S+)/i);
  if (dkimDomainMatch) result.dkimDomain = (dkimDomainMatch[1] ?? "").replace(/[;)]/g, "");

  // DMARC — e.g. "dmarc=pass (p=reject dis=none) header.from=example.com"
  const dmarcMatch = header.match(/dmarc=(\w+)/i);
  if (dmarcMatch) result.dmarc = (dmarcMatch[1] ?? "").toLowerCase();
  const dispMatch = header.match(/dmarc=\w+[^;]*\bp=(\w+)/i);
  if (dispMatch) {
    // "p=" is the policy; look for "dis=" for actual disposition
    const disMatch = header.match(/dmarc=\w+[^;]*dis[=:](\w+)/i) ||
                     header.match(/dmarc=\w+[^;]*\(.*?dis[=:](\w+)/i);
    result.dmarcDisposition = disMatch ? (disMatch[1] ?? "").toLowerCase() : (dispMatch[1] ?? "").toLowerCase();
  } else {
    const disMatch = header.match(/dmarc=\w+[^;]*dis[=:](\w+)/i) ||
                     header.match(/dmarc=\w+[^;]*\(.*?dis[=:](\w+)/i);
    if (disMatch) result.dmarcDisposition = (disMatch[1] ?? "").toLowerCase();
  }

  return result;
}

// ─── Brand Matching ────────────────────────────────────────────────

async function matchBrand(
  from: string, subject: string, urls: string[], replyTo: string, env: Env
): Promise<BrandMatch | null> {
  const fromDomain = extractDomain(from) ?? '';

  // Method 1: From domain matches a monitored brand's canonical_domain
  const directMatch = await env.DB.prepare(
    "SELECT id, name, canonical_domain FROM brands WHERE canonical_domain = ? LIMIT 1"
  ).bind(fromDomain).first<{ id: string; name: string; canonical_domain: string }>();
  if (directMatch) {
    return { brandId: directMatch.id, spoofedDomain: fromDomain, method: "from_header", confidence: 90 };
  }

  // Method 2: From domain contains a brand name (typosquat-style)
  const brands = await env.DB.prepare(
    "SELECT id, name, canonical_domain FROM brands WHERE threat_count > 0 ORDER BY threat_count DESC LIMIT 50"
  ).all<{ id: string; name: string; canonical_domain: string }>();

  for (const brand of brands.results) {
    const name = brand.name.toLowerCase();
    const domain = (brand.canonical_domain || "").toLowerCase();

    if (name.length > 3 && fromDomain.includes(name)) {
      return { brandId: brand.id, spoofedDomain: domain, method: "from_header", confidence: 75 };
    }
    if (name.length > 3 && subject.toLowerCase().includes(name)) {
      return { brandId: brand.id, spoofedDomain: domain, method: "subject", confidence: 60 };
    }
    if (name.length > 3 && replyTo.toLowerCase().includes(name)) {
      return { brandId: brand.id, spoofedDomain: domain, method: "reply_to", confidence: 65 };
    }
    for (const url of urls.slice(0, 10)) {
      if (name.length > 3 && url.toLowerCase().includes(name)) {
        return { brandId: brand.id, spoofedDomain: domain, method: "url", confidence: 70 };
      }
    }
  }

  return null;
}

// ─── Threat Creation ───────────────────────────────────────────────

async function createThreatFromCapture(env: Env, data: {
  fromDomain: string;
  sendingIp: string | null;
  urls: string[];
  brandMatch: BrandMatch | null;
  classification: { category: string };
  severity: string;
  subject: string;
}): Promise<string | null> {
  const primaryUrl = data.urls[0] || `https://${data.fromDomain}`;
  const threatId = `st_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  let threatType = "phishing";
  if (data.classification.category === "malware") threatType = "malware_distribution";
  if (data.subject.toLowerCase().includes("invoice") || data.subject.toLowerCase().includes("payment")) {
    threatType = "credential_harvesting";
  }

  try {
    await env.DB.prepare(`
      INSERT INTO threats (id, source_feed, threat_type, malicious_url, malicious_domain,
        target_brand_id, ip_address, severity, confidence_score, ioc_value, status)
      VALUES (?, 'spam_trap', ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).bind(
      threatId, threatType, primaryUrl, data.fromDomain,
      data.brandMatch?.brandId || null, data.sendingIp || null,
      data.severity, data.brandMatch ? 85 : 60,
      data.fromDomain
    ).run();

    // Create threat records for additional phishing URLs
    for (const url of data.urls.slice(1, 5)) {
      const urlThreatId = `st_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const urlDomain = extractDomain(url);
      await env.DB.prepare(`
        INSERT OR IGNORE INTO threats (id, source_feed, threat_type, malicious_url, malicious_domain,
          target_brand_id, ip_address, severity, confidence_score, ioc_value, status)
        VALUES (?, 'spam_trap', 'phishing', ?, ?, ?, ?, ?, 80, ?, 'active')
      `).bind(
        urlThreatId, url, urlDomain,
        data.brandMatch?.brandId || null, data.sendingIp || null,
        data.severity, urlDomain
      ).run();
    }

    // Update brand threat count
    if (data.brandMatch?.brandId) {
      await env.DB.prepare(
        "UPDATE brands SET threat_count = threat_count + 1, last_threat_seen = datetime('now') WHERE id = ?"
      ).bind(data.brandMatch.brandId).run();
    }

    return threatId;
  } catch (e) {
    console.error("[SpamTrap] Failed to create threat:", e);
    return null;
  }
}

// ─── Helper Functions ──────────────────────────────────────────────

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  // PR-BP: 5MB cap. Cloudflare Email Routing accepts up to 25MB per
  // message, but a flood of 25MB payloads would OOM the Worker isolate
  // (128MB ceiling) given the downstream TextDecoder allocation and
  // attachment extraction. Mirrors the cap already in dmarc-receiver.ts.
  const MAX_RAW_BYTES = 5 * 1024 * 1024;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
    if (totalLength > MAX_RAW_BYTES) {
      console.warn("[spam-trap] Email exceeds 5MB — truncating");
      break;
    }
  }

  const result = new Uint8Array(Math.min(totalLength, MAX_RAW_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = result.length - offset;
    if (remaining <= 0) break;
    if (chunk.length <= remaining) {
      result.set(chunk, offset);
      offset += chunk.length;
    } else {
      result.set(chunk.subarray(0, remaining), offset);
      offset += remaining;
      break;
    }
  }
  return result.buffer;
}

function extractHeaders(rawText: string): Record<string, string> {
  let headerEnd = rawText.indexOf("\r\n\r\n");
  if (headerEnd < 0) headerEnd = rawText.indexOf("\n\n");
  const headerSection = headerEnd > 0 ? rawText.substring(0, headerEnd) : rawText.substring(0, 5000);
  const headers: Record<string, string> = {};

  // Unfold continuation lines (handle both \r\n and \n)
  const unfolded = headerSection.replace(/\r?\n(\s+)/g, " ");
  const lines = unfolded.split(/\r?\n/);

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const name = line.substring(0, colonIdx).trim().toLowerCase();
      const value = line.substring(colonIdx + 1).trim();
      // Concatenate duplicate headers (e.g. multiple authentication-results)
      headers[name] = headers[name] ? headers[name] + "; " + value : value;
    }
  }
  return headers;
}

function extractSendingIp(headers: Record<string, string>): string | null {
  const received = headers["received"] || "";
  const ipMatch = received.match(/\[(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]/);
  return ipMatch?.[1] || null;
}


function extractBody(rawText: string): string {
  // Try \r\n\r\n first (standard), then \n\n (Cloudflare Email Routing often normalises)
  let headerEnd = rawText.indexOf("\r\n\r\n");
  let body = "";
  if (headerEnd >= 0) {
    body = rawText.substring(headerEnd + 4);
  } else {
    headerEnd = rawText.indexOf("\n\n");
    if (headerEnd >= 0) {
      body = rawText.substring(headerEnd + 2);
    }
  }
  if (!body) return "";

  // For multipart MIME, extract text parts and decode quoted-printable
  const boundaryMatch = rawText.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1] ?? "";
    const parts = body.split(`--${boundary}`);
    const textParts: string[] = [];
    for (const part of parts) {
      const ctMatch = part.match(/Content-Type:\s*text\/(plain|html)/i);
      if (!ctMatch) continue;
      // Find the part body (after the blank line within this MIME part)
      const partBodyStart = part.match(/(\r?\n){2}/);
      if (!partBodyStart) continue;
      let partBody = part.substring((partBodyStart.index ?? 0) + partBodyStart[0].length);
      // Strip trailing boundary marker
      const endBoundary = partBody.indexOf(`--${boundary}`);
      if (endBoundary >= 0) partBody = partBody.substring(0, endBoundary);
      // Decode quoted-printable if needed
      if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(part)) {
        partBody = decodeQuotedPrintable(partBody);
      }
      // Decode base64 if needed
      if (/Content-Transfer-Encoding:\s*base64/i.test(part)) {
        try { partBody = atob(partBody.replace(/\s/g, "")); } catch { /* leave as-is */ }
      }
      textParts.push(partBody.trim());
    }
    if (textParts.length > 0) return textParts.join("\n");
  }

  // Non-multipart: check if the single body is quoted-printable
  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(rawText)) {
    return decodeQuotedPrintable(body);
  }

  return body;
}

function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, "")                           // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>        // encoded chars
      String.fromCharCode(parseInt(hex, 16))
    );
}

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
  const matches = text.match(urlRegex) || [];
  return [...new Set(matches)].slice(0, 50);
}

function extractAttachmentInfo(raw: ArrayBuffer): Array<{ filename: string; sha256: string; size: number; contentType: string }> {
  const text = new TextDecoder().decode(raw);
  const attachments: Array<{ filename: string; sha256: string; size: number; contentType: string }> = [];

  const boundaryMatch = text.match(/boundary="?([^"\r\n]+)"?/i);
  if (!boundaryMatch) return [];

  const parts = text.split(`--${boundaryMatch[1] ?? ""}`);
  for (const part of parts) {
    const fnMatch = part.match(/filename="?([^"\r\n]+)"?/i);
    const ctMatch = part.match(/Content-Type:\s*([^\r\n;]+)/i);
    if (fnMatch && ctMatch) {
      const contentType = (ctMatch[1] ?? "").trim();
      if (contentType.startsWith("text/")) continue;

      attachments.push({
        filename: (fnMatch[1] ?? "").trim(),
        sha256: "",
        size: part.length,
        contentType,
      });
    }
  }
  return attachments;
}

function extractHeloHostname(headers: Record<string, string>): string | null {
  const received = headers["received"] || "";
  const heloMatch = received.match(/helo=([^\s)]+)/i) || received.match(/ehlo=([^\s)]+)/i);
  return heloMatch?.[1] || null;
}

function truncateHeaders(rawText: string, maxLen: number): string {
  const headerEnd = rawText.indexOf("\r\n\r\n");
  const headers = headerEnd > 0 ? rawText.substring(0, headerEnd) : rawText.substring(0, maxLen);
  return headers.substring(0, maxLen);
}

function classifyEmail(
  auth: AuthResults, urls: string[],
  attachments: Array<{ filename: string; sha256: string; size: number; contentType: string }>,
  brand: BrandMatch | null
): { category: string } {
  if (attachments.some(a => /\.(exe|scr|bat|cmd|ps1|vbs|js|hta|msi)$/i.test(a.filename))) {
    return { category: "malware" };
  }
  if (urls.length > 0 && brand) return { category: "phishing" };
  if (auth.spf === "fail" && urls.length > 0) return { category: "phishing" };
  return { category: urls.length > 0 ? "phishing" : "spam" };
}

function calculateSeverity(auth: AuthResults, brand: BrandMatch | null, urlCount: number, attachmentCount: number): string {
  let score = 0;
  if (auth.spf === "fail") score += 2;
  if (auth.dkim === "fail") score += 2;
  if (auth.dmarc === "fail") score += 3;
  if (brand) score += 3;
  if (urlCount > 0) score += 1;
  if (attachmentCount > 0) score += 2;

  if (score >= 8) return "critical";
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}
