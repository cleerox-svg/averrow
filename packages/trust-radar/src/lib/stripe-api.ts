// Minimal Stripe API client (outbound).
//
// Cloudflare Workers don't have easy access to the official `stripe`
// npm package (it pulls in node-fetch + crypto polyfills). Stripe's
// API is form-urlencoded POST + Bearer auth, which is two lines of
// fetch — small enough to inline rather than ship the upstream lib.
//
// We currently call only:
//   POST /v1/checkout/sessions
//   POST /v1/billing_portal/sessions
//
// Future calls can extend `stripeApiCall()` rather than reaching for
// the SDK; the surface is genuinely small and the dependency cost is
// not worth carrying.
//
// v3 Phase D Stripe sprint 6.

const STRIPE_API_BASE = "https://api.stripe.com/v1";

export class StripeApiError extends Error {
  constructor(
    public status: number,
    public stripeError: { type?: string; code?: string; message?: string } | null,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

/**
 * Form-urlencode a flat or nested object into Stripe's expected
 * format. Stripe accepts `key[subkey]=value` and `key[]=value`
 * (arrays). Nested arrays-of-objects use `key[0][subkey]=value`.
 */
export function stripeUrlEncode(obj: Record<string, unknown>): string {
  const params: string[] = [];

  function encode(prefix: string, value: unknown): void {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => encode(`${prefix}[${i}]`, item));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        encode(`${prefix}[${k}]`, v);
      }
      return;
    }
    params.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }

  for (const [k, v] of Object.entries(obj)) {
    encode(k, v);
  }
  return params.join("&");
}

export async function stripeApiCall<T>(
  apiKey:   string,
  method:   "POST" | "GET",
  path:     string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
  };
  let body: string | undefined;
  if (method === "POST" && payload) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = stripeUrlEncode(payload);
  }

  const res = await fetch(`${STRIPE_API_BASE}${path}`, { method, headers, body });
  const text = await res.text();

  if (!res.ok) {
    let parsed: { error?: { type?: string; code?: string; message?: string } } | null = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    throw new StripeApiError(
      res.status,
      parsed?.error ?? null,
      parsed?.error?.message ?? `Stripe ${method} ${path} returned HTTP ${res.status}`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new StripeApiError(res.status, null, `Stripe returned non-JSON body for ${method} ${path}`);
  }
}

// ─── Specific call shapes we use ────────────────────────────────

export interface CheckoutSessionInput {
  customer?:        string;                     // existing stripe_customer_id
  customer_email?:  string;                     // for first-time signup (Stripe creates the customer)
  line_items:       Array<{ price: string; quantity: number }>;
  mode:             "subscription" | "payment";
  success_url:      string;
  cancel_url:       string;
  client_reference_id?: string;                 // we put the org_id here
  subscription_data?: { trial_period_days?: number; metadata?: Record<string, string> };
  allow_promotion_codes?: boolean;
}

export interface CheckoutSessionResponse {
  id:     string;
  url:    string;
  status: string;
}

export async function createCheckoutSession(
  apiKey: string,
  input:  CheckoutSessionInput,
): Promise<CheckoutSessionResponse> {
  return stripeApiCall<CheckoutSessionResponse>(
    apiKey, "POST", "/checkout/sessions", input as unknown as Record<string, unknown>,
  );
}

export interface PortalSessionInput {
  customer:    string;
  return_url:  string;
}

export interface PortalSessionResponse {
  id:     string;
  url:    string;
}

export async function createPortalSession(
  apiKey: string,
  input:  PortalSessionInput,
): Promise<PortalSessionResponse> {
  return stripeApiCall<PortalSessionResponse>(
    apiKey, "POST", "/billing_portal/sessions", input as unknown as Record<string, unknown>,
  );
}
