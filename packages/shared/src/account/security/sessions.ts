// Normalises the sessions payload. Accepts the worker's
// `{ total, current_known, sessions[] }`, or a bare array, and tolerates
// missing fields (a host with an older endpoint) without inventing data.

import type { SecuritySession } from './types';
import { toValidDate } from '../time-format';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/i;

function maskIpv4(ip: string): string | null {
  const m = IPV4_RE.exec(ip);
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null;
  return `${m[1]}.${m[2]}.${m[3]}.•••`;
}

/**
 * Mask the host part of an IP (only used when a host sends a raw address).
 *   203.0.113.42 → 203.0.113.•••    2001:db8:1:2::9 → 2001:db8:1:••••
 *   2001::1      → 2001:0:0:••••    ::1             → 0:0:0:••••
 *   ::ffff:1.2.3.4 → ::ffff:1.2.3.•••
 * IPv6 keeps the first three groups of the EXPANDED address, so a short
 * compressed form never passes through whole. Unparseable → null.
 * Mirror of maskIp in packages/averrow-worker/src/handlers/account-sessions.ts.
 */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const addr = (ip.trim().split('%')[0] ?? '').toLowerCase();
  if (!addr.includes(':')) return maskIpv4(addr);

  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = maskIpv4(tail);
    return v4 ? `${addr.slice(0, lastColon + 1)}${v4}` : null;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): string[] | null => {
    if (!part) return [];
    const groups = part.split(':');
    return groups.every((g) => HEX_GROUP_RE.test(g)) ? groups : null;
  };
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  if (!head || !rest) return null;
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  return `${groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}:••••`;
}

export interface NormalizedSessions {
  sessions: SecuritySession[];
  /** False when the API can't say which row is this device. */
  currentKnown: boolean;
}

export function normalizeSessions(payload: unknown): NormalizedSessions {
  const list = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.sessions) ? payload.sessions : null;
  if (!list) throw new Error('Unexpected sessions response');

  let sawFlag = false;
  const sessions: SecuritySession[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id);
    if (!id) continue;
    if (typeof raw.is_current === 'boolean') sawFlag = true;
    sessions.push({
      id,
      userAgent: str(raw.user_agent),
      ipMasked: str(raw.ip_masked) ?? maskIp(str(raw.ip_address)),
      lastActiveAt: str(raw.last_active_at) ?? str(raw.issued_at),
      signedInAt: str(raw.issued_at),
      authMethod: str(raw.auth_method),
      isCurrent: raw.is_current === true,
    });
  }
  const explicit = isRecord(payload) && typeof payload.current_known === 'boolean' ? payload.current_known : null;
  const currentKnown = explicit ?? sawFlag;
  return { sessions: sortSessions(sessions), currentKnown };
}

/** This device first, then most recently active. */
export function sortSessions(sessions: SecuritySession[]): SecuritySession[] {
  const t = (s: SecuritySession) => toValidDate(s.lastActiveAt)?.getTime() ?? 0;
  return [...sessions].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || t(b) - t(a));
}

export function signInMethodLabel(authMethod: string | null): string | null {
  switch (authMethod) {
    case 'google_oauth': return 'Google';
    case 'passkey': return 'a passkey';
    case 'magic_link': return 'an email link';
    default: return null;
  }
}
