// Averrow — Device-code / OAuth-consent phishing technique detector
//
// Detects the BEHAVIOR behind kits like Kali365 (FBI PSA, May 2026):
// Microsoft 365 device-code phishing that steals an OAuth access token
// and bypasses MFA without ever intercepting a password.
//
// Why this exists: the rest of the platform is IOC-centric (domain /
// URL / IP). Device-code phishing is engineered to defeat exactly that —
// the victim visits the REAL `microsoft.com/devicelogin` and pastes a
// REAL device code, so there's no lookalike domain to flag. The only
// detectable artifact is the lure's CONTENT: an email instructing the
// recipient to enter a device code at a Microsoft device-login endpoint.
//
// This module is a pure function over email content. It does NOT touch
// D1, AI, or the network — so it's cheap to run on every captured
// message and trivially unit-tested.
//
// CRITICAL: a legitimate Microsoft device-login URL is NOT malicious.
// `legitEndpointUrls` lists any such URLs found so the caller can EXCLUDE
// them from threat promotion (we must never flag microsoft.com itself).
// The malicious indicator in this technique is the lure-delivery
// infrastructure (sender IP / sender domain / any non-Microsoft link),
// not the endpoint the victim is steered toward.

export type PhishingTechnique = "device_code_phishing" | "oauth_consent_phishing";

export interface DeviceCodeInput {
  subject: string | null;
  body: string | null;
  /** Extracted URLs from the message (any shape with a `url` string). */
  urls: ReadonlyArray<{ url: string; domain?: string | null }>;
}

export interface DeviceCodeResult {
  detected: boolean;
  technique: PhishingTechnique | null;
  /** 0-1 confidence. >=0.8 is a high-specificity match. */
  score: number;
  /** Human-readable signal names that fired (for audit / operator UI). */
  signals: string[];
  /** Legitimate Microsoft device-login endpoints found — must be excluded
   *  from threat promotion. */
  legitEndpointUrls: string[];
}

// Hostnames that ARE the legitimate device-login / consent endpoints.
// Presence of these in a lure is the tell — but the URLs themselves are
// never promotable as threats.
const LEGIT_ENDPOINT_HOSTS = new Set<string>([
  "microsoft.com",
  "www.microsoft.com",
  "aka.ms",
  "login.microsoftonline.com",
  "login.microsoft.com",
  "microsoftonline.com",
]);

// Path/URL fragments that identify a device-login or device-code flow.
const DEVICE_ENDPOINT_RE =
  /(?:microsoft\.com\/devicelogin|aka\.ms\/devicelogin|microsoft\.com\/device\b|login\.microsoftonline\.com\/[^\s"'<>]*device(?:code|auth)|\/oauth2(?:\/v2\.0)?\/devicecode)/i;

// OAuth consent-grant endpoint (the "approve permissions" variant).
const CONSENT_ENDPOINT_RE =
  /login\.microsoftonline\.com\/[^\s"'<>]*\/oauth2\/(?:v2\.0\/)?authorize[^\s"'<>]*(?:prompt=consent|response_type=code)/i;

// Lure phrasing that asks the victim to enter a code.
const CODE_INSTRUCTION_RE =
  /\b(?:enter|type|paste|use)\b[^.\n]{0,40}\b(?:the\s+|this\s+|your\s+)?(?:device\s+)?(?:sign[-\s]?in\s+)?(?:verification\s+)?code\b/i;

const DEVICE_CODE_PHRASE_RE = /\bdevice\s+code\b/i;

// A Microsoft device code looks like 9 alphanumerics, often shown as
// two groups (e.g. "ABCD-EFGHJ" or "A1B2C3D4E5"). Require an adjacency
// to a "code"/"enter" cue to keep this from matching arbitrary tokens.
const CODE_TOKEN_RE = /\b[A-Z0-9]{4}[-\s]?[A-Z0-9]{4,6}\b/;

// OAuth-consent lure phrasing.
const CONSENT_PHRASE_RE =
  /\b(?:grant|approve|accept|review)\b[^.\n]{0,40}\b(?:permission|permissions|access|consent)\b/i;

const MS_CONTEXT_RE =
  /\b(?:microsoft|office\s*365|m365|o365|outlook|onedrive|sharepoint|microsoft\s*teams|azure|entra)\b/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Detect the device-code (and, secondarily, OAuth-consent) phishing
 * technique from a captured email's content. Pure — no I/O.
 *
 * Detection rules (high specificity, low false-positive):
 *   device_code_phishing  — a Microsoft device-login endpoint is present
 *     (in a URL or in the text) AND there is a code cue (an "enter the
 *     code" instruction, the phrase "device code", or a code-shaped token
 *     near a code cue).
 *   oauth_consent_phishing — a consent-grant endpoint is present AND
 *     consent-grant lure phrasing is present.
 *
 * device_code_phishing takes precedence when both could apply.
 */
export function detectDeviceCodePhishing(input: DeviceCodeInput): DeviceCodeResult {
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const urlStrings = input.urls.map((u) => u.url);
  // Haystack for text-based cues: subject + body + the URL strings (so a
  // device endpoint pasted as a bare link is seen even if URL parsing
  // earlier dropped it).
  const haystack = `${subject}\n${body}\n${urlStrings.join("\n")}`;

  const signals: string[] = [];
  const legitEndpointUrls: string[] = [];

  // Find legitimate Microsoft endpoints among the URLs (for exclusion)
  // and note whether any device/consent endpoint is present at all.
  let hasDeviceEndpoint = false;
  let hasConsentEndpoint = false;
  for (const u of input.urls) {
    const host = (u.domain ?? hostOf(u.url));
    const isLegitHost = host ? LEGIT_ENDPOINT_HOSTS.has(host) : false;
    if (DEVICE_ENDPOINT_RE.test(u.url)) {
      hasDeviceEndpoint = true;
      if (isLegitHost) legitEndpointUrls.push(u.url);
    }
    if (CONSENT_ENDPOINT_RE.test(u.url)) {
      hasConsentEndpoint = true;
      if (isLegitHost) legitEndpointUrls.push(u.url);
    }
  }
  // Endpoint may also appear in prose rather than a parsed URL.
  if (!hasDeviceEndpoint && DEVICE_ENDPOINT_RE.test(haystack)) hasDeviceEndpoint = true;
  if (!hasConsentEndpoint && CONSENT_ENDPOINT_RE.test(haystack)) hasConsentEndpoint = true;

  const hasCodeInstruction = CODE_INSTRUCTION_RE.test(haystack);
  const hasDeviceCodePhrase = DEVICE_CODE_PHRASE_RE.test(haystack);
  const hasCodeToken = CODE_TOKEN_RE.test(haystack) && (hasCodeInstruction || hasDeviceCodePhrase);
  const hasMsContext = MS_CONTEXT_RE.test(haystack);

  if (hasDeviceEndpoint) signals.push("device_login_endpoint");
  if (hasDeviceCodePhrase) signals.push("device_code_phrase");
  if (hasCodeInstruction) signals.push("enter_code_instruction");
  if (hasCodeToken) signals.push("code_token");
  if (hasMsContext) signals.push("microsoft_context");

  // ─── device_code_phishing ───
  const codeCue = hasCodeInstruction || hasDeviceCodePhrase || hasCodeToken;
  if (hasDeviceEndpoint && codeCue) {
    // Endpoint + explicit code cue = the canonical signature. High score.
    let score = 0.85;
    if (hasDeviceCodePhrase) score += 0.05;
    if (hasMsContext) score += 0.05;
    return {
      detected: true,
      technique: "device_code_phishing",
      score: Math.min(1, score),
      signals,
      legitEndpointUrls: dedupe(legitEndpointUrls),
    };
  }
  // Softer fallback: strong code language + Microsoft context but no
  // parsed endpoint (e.g. endpoint was image-only / obfuscated). Lower
  // score — flagged for the operator, not auto-promoted.
  if (hasDeviceCodePhrase && hasCodeInstruction && hasMsContext) {
    return {
      detected: true,
      technique: "device_code_phishing",
      score: 0.6,
      signals,
      legitEndpointUrls: dedupe(legitEndpointUrls),
    };
  }

  // ─── oauth_consent_phishing ───
  if (hasConsentEndpoint && CONSENT_PHRASE_RE.test(haystack)) {
    signals.push("consent_endpoint", "consent_grant_phrase");
    return {
      detected: true,
      technique: "oauth_consent_phishing",
      score: hasMsContext ? 0.75 : 0.65,
      signals,
      legitEndpointUrls: dedupe(legitEndpointUrls),
    };
  }

  return {
    detected: false,
    technique: null,
    score: 0,
    signals,
    legitEndpointUrls: dedupe(legitEndpointUrls),
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
