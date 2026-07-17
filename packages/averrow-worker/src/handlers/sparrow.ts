/**
 * Sparrow (Takedown Pipeline) API Handlers
 *
 * POST /api/admin/sparrow/scan-capture/:id          — Scan URLs from a specific capture
 * POST /api/admin/sparrow/scan-batch                — Batch scan unprocessed captures
 * GET  /api/admin/sparrow/results/:captureId        — Get scan results for a capture
 * GET  /api/admin/sparrow/malicious                 — List all malicious URL scan results
 * GET  /api/admin/sparrow/providers                 — List takedown providers
 * POST /api/admin/sparrow/assemble-evidence/:id     — Trigger AI evidence assembly
 * GET  /api/admin/sparrow/evidence/:id              — Get all evidence for a takedown
 */

import { handler, success, error } from "../lib/handler-utils";
import { scanCaptureUrls, scanUnprocessedCaptures } from "../lib/url-scanner";
import { assembleEvidence } from "../lib/evidence-assembler";

// ── POST /api/admin/sparrow/scan-capture/:id ─────────────────────

export const handleScanCapture = (captureId: string) => handler(async (_request, env, ctx) => {
  const id = parseInt(captureId, 10);
  if (isNaN(id)) return error("Invalid capture ID", 400, ctx.origin);

  const results = await scanCaptureUrls(env, id);
  return success({
    urls_scanned: results.length,
    malicious: results.filter(r => r.is_malicious).length,
    results,
  }, ctx.origin);
});

// ── POST /api/admin/sparrow/scan-batch ──────────────────────────

export const handleScanBatch = handler(async (_request, env, ctx) => {
  const result = await scanUnprocessedCaptures(env);
  return success(result, ctx.origin);
});

// ── GET /api/admin/sparrow/results/:captureId ───────────────────

export const handleScanResults = (captureId: string) => handler(async (_request, env, ctx) => {
  const results = await env.DB.prepare(
    "SELECT * FROM url_scan_results WHERE source_type = 'spam_trap' AND source_id = ? ORDER BY confidence_score DESC"
  ).bind(captureId).all();
  return success(results.results, ctx.origin);
});

// ── GET /api/admin/sparrow/malicious ────────────────────────────

export const handleMaliciousResults = handler(async (_request, env, ctx) => {
  const results = await env.DB.prepare(`
    SELECT usr.*, b.name as brand_name
    FROM url_scan_results usr
    LEFT JOIN brands b ON b.id = usr.brand_id
    WHERE usr.is_malicious = 1
    ORDER BY usr.scanned_at DESC
    LIMIT 100
  `).all();
  return success(results.results, ctx.origin);
});

// ── GET /api/admin/sparrow/providers ────────────────────────────

export const handleProviders = handler(async (_request, env, ctx) => {
  const results = await env.DB.prepare(
    "SELECT * FROM takedown_providers ORDER BY provider_type, provider_name"
  ).all();
  return success(results.results, ctx.origin);
});

// ── POST /api/admin/sparrow/assemble-evidence/:takedownId ──────

export const handleAssembleEvidence = (takedownId: string) => handler(async (_request, env, ctx) => {
  if (!takedownId) return error("Missing takedown ID", 400, ctx.origin);
  const result = await assembleEvidence(env, takedownId);
  return success(result, ctx.origin);
});

// ── GET /api/admin/sparrow/evidence/:takedownId ────────────────

export const handleGetEvidence = (takedownId: string) => handler(async (_request, env, ctx) => {
  if (!takedownId) return error("Missing takedown ID", 400, ctx.origin);
  const evidence = await env.DB.prepare(
    "SELECT * FROM takedown_evidence WHERE takedown_id = ? ORDER BY created_at"
  ).bind(takedownId).all();
  return success(evidence.results, ctx.origin);
});

// ── GET /api/admin/sparrow/resolve-provider/:domain ────────────

export const handleResolveProvider = (domain: string) => handler(async (_request, env, ctx) => {
  if (!domain) return error("Missing domain", 400, ctx.origin);
  const { resolveProvider } = await import("../lib/provider-resolver");
  const result = await resolveProvider(env, domain);
  return success(result, ctx.origin);
});

// ── POST /api/admin/sparrow/generate-draft/:takedownId ─────────

export const handleGenerateDraft = (takedownId: string) => handler(async (_request, env, ctx) => {
  if (!takedownId) return error("Missing takedown ID", 400, ctx.origin);

  const takedown = await env.DB.prepare(
    "SELECT tr.*, b.name as brand_name FROM takedown_requests tr LEFT JOIN brands b ON b.id = tr.brand_id WHERE tr.id = ?"
  ).bind(takedownId).first();
  if (!takedown) return error("Takedown not found", 404, ctx.origin);

  const { resolveProvider, generateSubmissionDraft } = await import("../lib/provider-resolver");
  const providerInfo = await resolveProvider(env, takedown.target_value as string);
  const draft = generateSubmissionDraft(
    {
      target_type: takedown.target_type as string,
      target_value: takedown.target_value as string,
      target_url: takedown.target_url as string | null,
      evidence_summary: takedown.evidence_summary as string,
      evidence_detail: takedown.evidence_detail as string | null,
      brand_name: takedown.brand_name as string,
    },
    providerInfo.abuse_contact,
    providerInfo,
  );
  return success({ provider: providerInfo, draft }, ctx.origin);
});
