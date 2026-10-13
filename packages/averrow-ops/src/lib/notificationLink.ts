// Notification `link` values come from the worker (platform-templates.ts) as
// app paths, but may carry the `/v2` mount prefix. react-router runs with
// basename="/v2", so the prefix must be stripped before navigating or the
// route would resolve to /v2/v2/...
//
// Order matters: strip first, THEN validate, so `/v2//evil.com` can never
// become a protocol-relative `//evil.com` that the router renders as an
// external href.
export function resolveNotificationLink(link: string | null | undefined, fallback: string): string {
  if (!link) return fallback;
  const stripped = link.trim().replace(/^\/v2(?=[/?#]|$)/, '');
  const path = stripped === '' || stripped[0] === '?' || stripped[0] === '#' ? `/${stripped}` : stripped;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return fallback;
  if (!path.startsWith('/') || path.startsWith('//')) return fallback;
  return path;
}
