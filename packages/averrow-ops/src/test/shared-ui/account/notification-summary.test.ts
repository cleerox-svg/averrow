import { describe, it, expect } from 'vitest';
import {
  summarizeNotifications, pushSummaryState, formatClockTime,
} from '../../../../../shared/src/account/notifications/SummaryStrip';
import type { NotificationPrefsV2, PushState } from '../../../../../shared/src/account/notifications/types';

const prefs: NotificationPrefsV2 = {
  inapp_severity_floor: 'info', push_severity_floor: 'high', email_severity_floor: 'critical',
  digest_mode: 'off', digest_severity_floor: 'medium', quiet_hours_start: null, quiet_hours_end: null,
  quiet_hours_timezone: 'UTC', critical_bypasses_quiet: 1, show_tenant_notifications: 0,
  cadence_intel: 'realtime', cadence_platform: 'realtime',
};
const push = (o: Partial<PushState>): PushState => ({
  supported: true, permission: 'granted', subscribed: true, needsInstall: false, ...o,
});
const pushRow = (p: PushState, pr = prefs) => summarizeNotifications(pr, p).find((r) => r.id === 'push')!;

describe('push summary states', () => {
  it('granted + subscribed is the only green "on" state', () => {
    expect(pushRow(push({}))).toMatchObject({ text: 'Push on this device', on: true });
  });
  it('subscribed but floor off reads paused, not on', () => {
    expect(pushRow(push({}), { ...prefs, push_severity_floor: 'off' })).toMatchObject({ text: 'Push paused', on: false });
  });
  it('denied reads blocked and never green, even with a stale subscription', () => {
    expect(pushRow(push({ permission: 'denied', subscribed: true }))).toMatchObject({ text: 'Push blocked', on: false, warn: true });
    expect(pushRow(push({ permission: 'denied', subscribed: false }))).toMatchObject({ text: 'Push blocked', on: false });
  });
  it('unsupported never shows on', () => {
    expect(pushRow(push({ supported: false, subscribed: true }))).toMatchObject({ text: 'Push not available', on: false });
    expect(pushSummaryState(prefs, push({ permission: 'unsupported' }))).toBe('unsupported');
  });
  it('not subscribed (default or granted) reads off', () => {
    expect(pushRow(push({ permission: 'default', subscribed: false }))).toMatchObject({ text: 'Push off on this device', on: false });
    expect(pushRow(push({ subscribed: false }))).toMatchObject({ on: false });
  });
  it('subscribed without granted permission is off', () => {
    expect(pushSummaryState(prefs, push({ permission: 'default', subscribed: true }))).toBe('off');
  });
});

describe('quiet hours formatting', () => {
  it('formats with the given locale', () => {
    expect(formatClockTime('22:00', 'en-US')).toMatch(/10:00\s?PM/);
    expect(formatClockTime('07:05', 'en-GB')).toBe('07:05');
  });
  it('summary uses formatted times', () => {
    const q = summarizeNotifications({ ...prefs, quiet_hours_start: '22:00', quiet_hours_end: '07:00' }, push({})).find((r) => r.id === 'quiet')!;
    expect(q.text).toBe(`Quiet hours ${formatClockTime('22:00')}–${formatClockTime('07:00')}`);
  });
  it('passes through unparsable input', () => {
    expect(formatClockTime('')).toBe('');
  });
});
