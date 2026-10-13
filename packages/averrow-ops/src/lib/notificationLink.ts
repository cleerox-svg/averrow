// Notification `link` values come from the worker (platform-templates.ts) as
// app paths, but may carry the `/v2` mount prefix. react-router runs with
// basename="/v2", so the prefix must be stripped before navigating or the
// route would resolve to /v2/v2/...
export function resolveNotificationLink(link: string | null | undefined, fallback: string): string {
  if (!link) return fallback;
  const trimmed = link.trim();
  // Only in-app paths; never hand an absolute or protocol-relative URL to the router.
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  const stripped = trimmed.replace(/^\/v2(?=[/?#]|$)/, '');
  return stripped === '' ? '/' : stripped.startsWith('/') ? stripped : `/${stripped}`;
}
