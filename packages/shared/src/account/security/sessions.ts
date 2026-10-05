// Normalises the sessions payload. Accepts the worker's
// `{ total, current_known, sessions[] }`, or a bare array, and tolerates
// missing fields (a host with an older endpoint) without inventing data.

import type { SecuritySession } from './types';
import { parseTimestamp } from './time';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** 203.0.113.42 → 203.0.113.•••  (only used when a host sends a raw address). */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}:••••`;
  const octets = ip.split('.');
  return octets.length === 4 ? `${octets.slice(0, 3).join('.')}.•••` : null;
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
  const t = (s: SecuritySession) => parseTimestamp(s.lastActiveAt)?.getTime() ?? 0;
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
