/**
 * Security headers middleware.
 * Adds defense-in-depth HTTP headers to every response.
 */

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Paths whose pages may load Cloudflare Turnstile (free scan): the
 * homepage hero form, /scan and the /assess form. Only these get
 * challenges.cloudflare.com in script-src / connect-src / frame-src
 * (appsec L1). Today all three pages are static assets served with the
 * public/_headers policy; this keeps any Worker-rendered response on those
 * paths consistent with it, and every other Worker response stricter.
 */
export function cspAllowsTurnstile(pathname: string | undefined): boolean {
  if (pathname === undefined) return false;
  return pathname === "/" || pathname === "/scan" || pathname.startsWith("/scan/")
    || pathname === "/assess" || pathname.startsWith("/assess/");
}

export function buildContentSecurityPolicy(pathname?: string): string {
  const turnstile = cspAllowsTurnstile(pathname);
  const t = turnstile ? ` ${TURNSTILE_ORIGIN}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://static.cloudflareinsights.com${t}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com https://cdn.jsdelivr.net https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com https://cdn.fontshare.com",
    "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://www.google.com https://*.google.com https://t3.gstatic.com https://*.gstatic.com https://*.mzstatic.com https://*.googleusercontent.com",
    `connect-src 'self' wss: https://averrow.com https://www.averrow.com https://averrow.ca https://www.averrow.ca https://trustradar.ca https://www.trustradar.ca https://accounts.google.com https://oauth2.googleapis.com https://*.basemaps.cartocdn.com https://basemaps.cartocdn.com https://cloudflareinsights.com${t}`,
    // Cloudflare Turnstile (free scan): api.js + its challenge iframe.
    ...(turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
  ].join("; ");
}

/** `pathname` scopes the Turnstile CSP sources; omitted → not allowed. */
export function applySecurityHeaders(response: Response, pathname?: string): Response {
  const headers = new Headers(response.headers);

  // Prevent clickjacking
  headers.set("X-Frame-Options", "DENY");

  // Prevent MIME-type sniffing
  headers.set("X-Content-Type-Options", "nosniff");

  // Basic XSS protection (legacy browsers)
  headers.set("X-XSS-Protection", "1; mode=block");

  // Referrer policy — send origin only to same-origin, nothing to cross-origin
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions policy — disable features we don't use
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  // Content Security Policy
  headers.set("Content-Security-Policy", buildContentSecurityPolicy(pathname));

  // HSTS — enforce HTTPS (1 year, include subdomains)
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
