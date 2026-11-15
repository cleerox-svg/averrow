// Notification `link` values come from the worker (platform-templates.ts) as
// app paths, but may carry a mount prefix. react-router runs with
// basename="/ops", so the prefix must be stripped before navigating or the
// route would resolve to /ops/ops/... A legacy `/v2` prefix (stored before the
// 2026-11-15 move) is stripped too, so old stored notifications still open the
// right page inside the app.
//
// Order matters: strip first, THEN validate, so `/ops//evil.com` can never
// become a protocol-relative `//evil.com` that the router renders as an
// external href.
import { stripOpsBase } from './basePath';

export function resolveNotificationLink(link: string | null | undefined, fallback: string): string {
  if (!link) return fallback;
  const stripped = stripOpsBase(link.trim());
  const path = stripped === '' || stripped[0] === '?' || stripped[0] === '#' ? `/${stripped}` : stripped;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return fallback;
  if (!path.startsWith('/') || path.startsWith('//')) return fallback;
  return path;
}
