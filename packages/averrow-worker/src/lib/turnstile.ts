/**
 * Cloudflare Turnstile verification for the anonymous public scan + lead
 * forms (owner decision 2026-10-05).
 *
 * Rollout switch — `env.TURNSTILE_MODE` (wrangler.toml [vars]):
 *   - `off` (default when unset, or any unrecognised value): no verification,
 *     no siteverify call, zero overhead.
 *   - `monitor`: verify every request and log the verdict, never block. Use it
 *     to confirm the marketing widget is sending valid tokens before enforcing.
 *   - `enforce`: block a request whose token is missing or fails verification.
 *     A siteverify network error / timeout BLOCKS (fail closed).
 * Missing `TURNSTILE_SECRET_KEY` (logged once per isolate as
 * `turnstile_secret_missing`):
 *   - `monitor` → behaves as `off` (monitoring never blocks anyway);
 *   - `enforce` → FAILS CLOSED: every guarded request is refused with 503
 *     `Verification unavailable` (form route: redirect with
 *     `?error=verification_unavailable`). A missing secret must never
 *     silently disable enforcement.
 *
 * Token sources (the gate never consumes the request body — it reads a clone):
 *   - header `CF-Turnstile-Response`
 *   - JSON body field `turnstileToken` (or `cf-turnstile-response`)
 *   - form field `cf-turnstile-response` (the widget's default hidden input;
 *     read by the POST /assess route itself, which already parses the form)
 *
 * The siteverify response is additionally checked for:
 *   - `hostname` ∈ TURNSTILE_ALLOWED_HOSTNAMES (a token minted for the site
 *     key on any other host is refused);
 *   - `action`: when the widget set one (`data-action`), it must equal the
 *     action the endpoint expects (`scan` / `lead` / `monitor`). A widget with
 *     no action passes this check.
 *
 * Nothing here logs the token or the client IP.
 */

import { json } from "./cors";
import { logger } from "./logger";
import type { Env } from "../types";

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Hostnames a token may have been solved on. Must match the hostnames
 *  configured on the Turnstile widget in the Cloudflare dashboard. */
export const TURNSTILE_ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set([
  "averrow.com",
  "www.averrow.com",
  "averrow.ca",
  "www.averrow.ca",
]);

/** siteverify budget. Cloudflare answers in well under a second; anything
 *  slower is treated as a failure (blocks in enforce). */
export const TURNSTILE_TIMEOUT_MS = 3000;

/** Cloudflare documents a 2048-character maximum token length. */
export const TURNSTILE_MAX_TOKEN_LENGTH = 2048;

export const TURNSTILE_HEADER = "CF-Turnstile-Response";
export const TURNSTILE_FORM_FIELD = "cf-turnstile-response";
export const TURNSTILE_JSON_FIELD = "turnstileToken";

export type TurnstileMode = "off" | "monitor" | "enforce";

/** Effective gate state: a mode, or `enforce_unconfigured` (enforce requested
 *  but TURNSTILE_SECRET_KEY missing → refuse every guarded request). */
export type TurnstileEffectiveMode = TurnstileMode | "enforce_unconfigured";

/** Widget `data-action` values each protected endpoint expects. */
export type TurnstileAction = "scan" | "lead" | "monitor";

export type TurnstileReason =
  | "ok"
  | "missing-token"
  | "invalid-token-format"
  | "missing-secret"
  | "siteverify-rejected"
  | "hostname-mismatch"
  | "action-mismatch"
  | "bad-response"
  | "timeout"
  | "network-error";

export interface TurnstileResult {
  ok: boolean;
  reason: TurnstileReason;
  /** siteverify `error-codes`, when it rejected the token. */
  errorCodes?: string[];
  /** Hostname siteverify reported (only on hostname-mismatch / ok). */
  hostname?: string;
}

export interface VerifyTurnstileOptions {
  /** Expected widget action; enforced only when the widget supplied one. */
  expectedAction?: TurnstileAction;
  timeoutMs?: number;
}

interface SiteverifyResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  "error-codes"?: unknown;
}

/**
 * Verify a Turnstile token against Cloudflare siteverify. Never throws:
 * every failure (no secret, no token, rejection, hostname/action mismatch,
 * non-2xx, unparsable body, timeout, network error) is `ok: false` with a
 * reason, so callers fail closed by construction.
 */
export async function verifyTurnstile(
  env: Pick<Env, "TURNSTILE_SECRET_KEY">,
  token: string | null | undefined,
  ip?: string | null,
  opts: VerifyTurnstileOptions = {},
): Promise<TurnstileResult> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: false, reason: "missing-secret" };
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing-token" };
  if (token.length > TURNSTILE_MAX_TOKEN_LENGTH) return { ok: false, reason: "invalid-token-format" };

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TURNSTILE_TIMEOUT_MS);
  let parsed: SiteverifyResponse;
  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: "bad-response" };
    const raw: unknown = await res.json().catch(() => null);
    if (!raw || typeof raw !== "object") return { ok: false, reason: "bad-response" };
    parsed = raw as SiteverifyResponse;
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network-error" };
  } finally {
    clearTimeout(timer);
  }

  if (parsed.success !== true) {
    const codes = Array.isArray(parsed["error-codes"])
      ? parsed["error-codes"].filter((c): c is string => typeof c === "string")
      : [];
    return { ok: false, reason: "siteverify-rejected", errorCodes: codes };
  }

  const hostname = typeof parsed.hostname === "string" ? parsed.hostname.toLowerCase() : "";
  if (!TURNSTILE_ALLOWED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: "hostname-mismatch", hostname };
  }

  const action = typeof parsed.action === "string" ? parsed.action : "";
  if (opts.expectedAction && action !== "" && action !== opts.expectedAction) {
    return { ok: false, reason: "action-mismatch", hostname };
  }

  return { ok: true, reason: "ok", hostname };
}

// ─── Mode resolution ─────────────────────────────────────────────

let warnedMissingSecret = false;
let warnedUnknownMode = false;

/** Test hook: re-arm the once-per-isolate warnings. */
export function resetTurnstileWarningsForTest(): void {
  warnedMissingSecret = false;
  warnedUnknownMode = false;
}

/** Effective mode: `off` unless TURNSTILE_MODE is monitor/enforce. Without
 *  the secret, monitor → `off`; enforce → `enforce_unconfigured` (fail closed). */
export function resolveTurnstileMode(
  env: Pick<Env, "TURNSTILE_MODE" | "TURNSTILE_SECRET_KEY">,
): TurnstileEffectiveMode {
  const raw = (env.TURNSTILE_MODE ?? "").trim().toLowerCase();
  if (raw !== "monitor" && raw !== "enforce") {
    if (raw !== "" && raw !== "off" && !warnedUnknownMode) {
      warnedUnknownMode = true;
      logger.warn("turnstile_mode_unknown", { value: raw, effective_mode: "off" });
    }
    return "off";
  }
  if (!env.TURNSTILE_SECRET_KEY) {
    const effective: TurnstileEffectiveMode = raw === "enforce" ? "enforce_unconfigured" : "off";
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      logger.warn("turnstile_secret_missing", { configured_mode: raw, effective_mode: effective });
    }
    return effective;
  }
  return raw;
}

// ─── Request gate ────────────────────────────────────────────────

export interface TurnstileDecision {
  mode: TurnstileEffectiveMode;
  /** True in enforce mode with a failed verification, and always in
   *  enforce_unconfigured. */
  blocked: boolean;
  /** True when blocked because verification is impossible (enforce with no
   *  secret) — callers answer 503 instead of 403. */
  unavailable: boolean;
  /** null when mode is off (nothing was verified). */
  result: TurnstileResult | null;
}

export interface TurnstileGateOptions {
  /** Route label for logs, e.g. "POST /api/leads". */
  route: string;
  expectedAction: TurnstileAction;
}

function normaliseToken(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Header first, then the JSON body (read from a clone — the handler can
 *  still read the original body). */
export async function extractTurnstileTokenFromJsonRequest(request: Request): Promise<string | null> {
  const header = normaliseToken(request.headers.get(TURNSTILE_HEADER));
  if (header) return header;
  const body: unknown = await request.clone().json().catch(() => null);
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  return normaliseToken(o[TURNSTILE_JSON_FIELD]) ?? normaliseToken(o[TURNSTILE_FORM_FIELD]);
}

/**
 * Resolve the mode, and — unless off — fetch the token lazily and verify it.
 * The verdict is logged in monitor mode (every request) and on every enforce
 * failure; the token and IP are never logged.
 */
export async function evaluateTurnstile(
  request: Request,
  env: Env,
  getToken: () => Promise<string | null> | string | null,
  opts: TurnstileGateOptions,
): Promise<TurnstileDecision> {
  const mode = resolveTurnstileMode(env);
  if (mode === "off") return { mode, blocked: false, unavailable: false, result: null };
  if (mode === "enforce_unconfigured") {
    // Fail closed. The once-per-isolate turnstile_secret_missing warning
    // already fired in resolveTurnstileMode; no per-request log line.
    return { mode, blocked: true, unavailable: true, result: { ok: false, reason: "missing-secret" } };
  }

  const token = await getToken();
  const ip = request.headers.get("CF-Connecting-IP");
  const result = await verifyTurnstile(env, token, ip, { expectedAction: opts.expectedAction });
  const blocked = mode === "enforce" && !result.ok;

  if (mode === "monitor" || !result.ok) {
    const data = {
      route: opts.route,
      mode,
      ok: result.ok,
      reason: result.reason,
      blocked,
      ...(result.errorCodes && result.errorCodes.length > 0 ? { error_codes: result.errorCodes } : {}),
      ...(result.reason === "hostname-mismatch" ? { hostname: result.hostname } : {}),
    };
    if (result.ok) logger.info("turnstile_verdict", data);
    else logger.warn("turnstile_verdict", data);
  }

  return { mode, blocked, unavailable: false, result };
}

/** The response every blocked JSON endpoint returns: 403 for a failed
 *  verification, 503 when enforce is on but the secret is missing. */
export function turnstileBlockedResponse(request: Request, decision: Pick<TurnstileDecision, "unavailable">): Response {
  const origin = request.headers.get("Origin");
  return decision.unavailable
    ? json({ success: false, error: "Verification unavailable" }, 503, origin)
    : json({ success: false, error: "Verification failed" }, 403, origin);
}

/** Redirect target for a blocked browser form post (POST /assess). */
export function turnstileBlockedRedirectPath(decision: Pick<TurnstileDecision, "unavailable">): string {
  return decision.unavailable ? "/?error=verification_unavailable" : "/?error=verification_failed";
}

/**
 * Gate for a JSON endpoint: returns the 403/503 Response when enforce mode
 * blocks the request, null when it may proceed (off, monitor, or verified).
 */
export async function turnstileGuardJson(
  request: Request,
  env: Env,
  opts: TurnstileGateOptions,
): Promise<Response | null> {
  const decision = await evaluateTurnstile(
    request, env, () => extractTurnstileTokenFromJsonRequest(request), opts,
  );
  return decision.blocked ? turnstileBlockedResponse(request, decision) : null;
}
