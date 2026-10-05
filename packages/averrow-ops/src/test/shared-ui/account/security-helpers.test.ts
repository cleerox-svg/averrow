import { describe, it, expect } from 'vitest';
import { parseUserAgent } from '../../../../../shared/src/account/security/userAgent';
import { normalizeSessions, maskIp } from '../../../../../shared/src/account/security/sessions';
import { parseTimestamp, formatRelative, isActiveNow } from '../../../../../shared/src/account/security/time';

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

describe('parseUserAgent', () => {
  it('labels common browser/OS pairs', () => {
    expect(parseUserAgent(UA.chromeMac).label).toBe('Chrome on macOS');
    expect(parseUserAgent(UA.safariIphone).label).toBe('Safari on iOS');
    expect(parseUserAgent(UA.chromeIphone).label).toBe('Chrome on iOS');
    expect(parseUserAgent(UA.edgeWin).label).toBe('Edge on Windows');
    expect(parseUserAgent(UA.firefoxLinux).label).toBe('Firefox on Linux');
    expect(parseUserAgent(UA.chromeAndroid).label).toBe('Chrome on Android');
  });

  it('classifies the device', () => {
    expect(parseUserAgent(UA.chromeMac).device).toBe('desktop');
    expect(parseUserAgent(UA.safariIphone).device).toBe('phone');
    expect(parseUserAgent(UA.chromeAndroid).device).toBe('phone');
    expect(parseUserAgent(UA.ipad).device).toBe('tablet');
  });

  it('degrades to "Unknown device" instead of guessing', () => {
    for (const ua of [null, undefined, '', '   ']) {
      expect(parseUserAgent(ua)).toMatchObject({ label: 'Unknown device', device: 'unknown' });
    }
    expect(parseUserAgent('curl/8.4.0').label).toBe('Unknown device');
  });

  it('falls back to whichever half it knows', () => {
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0)').label).toBe('Windows');
    expect(parseUserAgent('Firefox/127.0').label).toBe('Firefox');
  });
});

describe('normalizeSessions', () => {
  const base = { ip_masked: '203.0.113.•••', user_agent: UA.chromeMac, issued_at: '2026-10-01 10:00:00' };

  it('puts this device first, then most recently active', () => {
    const out = normalizeSessions({
      current_known: true,
      sessions: [
        { id: 'old', ...base, last_active_at: '2026-10-01 10:00:00', is_current: false },
        { id: 'cur', ...base, last_active_at: '2026-09-30 10:00:00', is_current: true },
        { id: 'new', ...base, last_active_at: '2026-10-03 10:00:00', is_current: false },
      ],
    });
    expect(out.sessions.map((s) => s.id)).toEqual(['cur', 'new', 'old']);
    expect(out.currentKnown).toBe(true);
  });

  it('accepts a bare array, masks a raw ip_address, and reports an unknown current session', () => {
    const out = normalizeSessions([{ id: 'a', ip_address: '198.51.100.7', issued_at: '2026-10-01 10:00:00' }]);
    expect(out.sessions[0]).toMatchObject({ ipMasked: '198.51.100.•••', isCurrent: false });
    expect(out.currentKnown).toBe(false);
  });

  it('rejects an unusable payload (so the UI shows an error, not "0 sessions")', () => {
    expect(() => normalizeSessions(null)).toThrow();
    expect(() => normalizeSessions({ total: 3 })).toThrow();
  });

  it('skips rows without an id', () => {
    expect(normalizeSessions([{ user_agent: 'x' }, { id: 'ok' }]).sessions.map((s) => s.id)).toEqual(['ok']);
  });
});

describe('maskIp', () => {
  it('masks v4 and v6, and drops junk', () => {
    expect(maskIp('203.0.113.42')).toBe('203.0.113.•••');
    expect(maskIp('2001:db8:1:2::9')).toBe('2001:db8:1:••••');
    expect(maskIp('nope')).toBeNull();
    expect(maskIp(null)).toBeNull();
  });
});

describe('time helpers', () => {
  it('reads D1 "YYYY-MM-DD HH:MM:SS" as UTC', () => {
    expect(parseTimestamp('2026-10-04 12:00:00')?.toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(parseTimestamp('2026-10-04T12:00:00Z')?.toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(parseTimestamp('garbage')).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });

  it('formats relative time', () => {
    const now = Date.UTC(2026, 9, 4, 12, 0, 0);
    expect(formatRelative(new Date(now - 10_000), now)).toBe('just now');
    expect(formatRelative(new Date(now - 5 * 60_000), now)).toBe('5 min ago');
    expect(formatRelative(new Date(now - 3 * 3_600_000), now)).toBe('3 hours ago');
    expect(formatRelative(new Date(now - 3_600_000), now)).toBe('1 hour ago');
    expect(formatRelative(new Date(now - 2 * 86_400_000), now)).toBe('2 days ago');
    expect(isActiveNow(new Date(now - 60_000), now)).toBe(true);
    expect(isActiveNow(new Date(now - 10 * 60_000), now)).toBe(false);
  });
});
