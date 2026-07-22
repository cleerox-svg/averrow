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
  "https://lrxradar.com",
  "https://www.lrxradar.com",
];

// Local-dev origins — only allowed in genuine dev/test environments, so a page
// served from localhost can never make a credentialed cross-origin request
// against a public Worker (Access-Control-Allow-Credentials is always true,
// which makes reflecting localhost a real exposure). staging is a PUBLIC domain
// sharing the same prod D1, so it is treated exactly like production here.
const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
];

// Explicit allowlist of environments permitted to reflect localhost origins.
// Anything else (production, staging, unset, or an unrecognized value) is
// treated as public and excludes localhost.
const LOCALHOST_ENVIRONMENTS = new Set(["development", "test"]);

/**
 * Resolve the allowed-origin whitelist for the current environment.
 * localhost origins are included only in an explicitly allowlisted dev/test
 * environment. When `env` is omitted the safe (production) list is returned —
 * the vast majority of `json()` callers don't thread `env`, and defaulting to
 * no-localhost keeps them secure by construction.
 */
function allowedOrigins(env?: CorsEnv): string[] {
  const allowLocalhost = env?.ENVIRONMENT !== undefined && LOCALHOST_ENVIRONMENTS.has(env.ENVIRONMENT);
  return allowLocalhost ? [...PRODUCTION_ORIGINS, ...DEV_ORIGINS] : PRODUCTION_ORIGINS;
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
