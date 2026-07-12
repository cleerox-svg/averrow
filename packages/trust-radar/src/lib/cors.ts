// Minimal structural view of the Worker env — cors.ts only needs the
// environment name to decide whether localhost origins are permitted.
// The full `Env` (ENVIRONMENT: string) is assignable to this, so callers
// pass their `env` directly.
export interface CorsEnv {
  ENVIRONMENT?: string;
}

// Production origins — always allowed in every environment.
const PRODUCTION_ORIGINS = [
  "https://averrow.com",
  "https://www.averrow.com",
  "https://averrow.ca",
  "https://www.averrow.ca",
  "https://trustradar.ca",
  "https://www.trustradar.ca",
  "https://imprsn8.com",
  "https://www.imprsn8.com",
];

// Local-dev origins — only allowed when NOT running in production, so a page
// served from localhost can never make a credentialed cross-origin request
// against the production Worker (Access-Control-Allow-Credentials is always
// true, which makes reflecting localhost in prod a real exposure).
const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
];

/**
 * Resolve the allowed-origin whitelist for the current environment.
 * localhost origins are included only outside production. When `env` is
 * omitted the safe (production) list is returned — the vast majority of
 * `json()` callers don't thread `env`, and defaulting to no-localhost keeps
 * them secure by construction.
 */
function allowedOrigins(env?: CorsEnv): string[] {
  const isProduction = !env || env.ENVIRONMENT === "production" || env.ENVIRONMENT === undefined;
  return isProduction ? PRODUCTION_ORIGINS : [...PRODUCTION_ORIGINS, ...DEV_ORIGINS];
}

export function corsHeaders(origin: string | null, env?: CorsEnv): Record<string, string> {
  const whitelist = allowedOrigins(env);
  const allowed = origin && whitelist.includes(origin) ? origin : "https://averrow.com";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

export function handleOptions(request: Request, env?: CorsEnv): Response {
  const origin = request.headers.get("Origin");
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin, env),
  });
}

export function json<T>(data: T, status = 200, origin: string | null = null, env?: CorsEnv): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin, env),
    },
  });
}
