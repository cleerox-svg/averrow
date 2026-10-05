import { describe, it, expect } from 'vitest';
import { devicesSummary, notificationsSummary, securitySummary } from '@averrow/shared/account';

const push = (over = {}) => ({ supported: true, permission: 'granted' as const, subscribed: true, needsInstall: false, ...over });

describe('settings home summaries', () => {
  it('security', () => {
    expect(securitySummary({ passkeys: 1, sessions: 3 })).toBe('Passkey on · 3 sessions');
    expect(securitySummary({ passkeys: 0, sessions: 1 })).toBe('No passkey · 1 session');
    expect(securitySummary({ passkeys: 2 })).toBe('Passkey on');
    expect(securitySummary({})).toBeUndefined();
  });
  it('notifications', () => {
    const prefs = { push_severity_floor: 'high' as const, email_severity_floor: 'high' as const };
    expect(notificationsSummary(prefs, push())).toBe('Push on · High and above');
    expect(notificationsSummary(prefs, push({ subscribed: false }))).toBe('Push off · Email on');
    expect(notificationsSummary(prefs, push({ permission: 'denied' }))).toBe('Push blocked');
    expect(notificationsSummary(null, push())).toBeUndefined();
  });
  it('devices', () => {
    expect(devicesSummary({ devices: 2, installed: true })).toBe('2 devices · App installed');
    expect(devicesSummary({ devices: 1, installed: false })).toBe('1 device · App not installed');
    expect(devicesSummary({})).toBeUndefined();
  });
});
