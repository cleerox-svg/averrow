// One-line live summaries for the settings home list (ACCOUNT_DESIGN_SPEC §5.0).
// Pure: hosts fetch the numbers with whatever hooks they already have and pass
// them in. Each returns `undefined` while its data is missing so the caller
// falls back to the generic section description.

import { floorLabel } from './notifications/helpers';
import { pushSummaryState } from './notifications/SummaryStrip';
import type { NotificationPrefsV2, PushState } from './notifications/types';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Passkey on · 3 sessions" / "No passkey · 1 session". Sessions are optional (still loading). */
export function securitySummary(opts: { passkeys?: number | null; sessions?: number | null }): string | undefined {
  const { passkeys, sessions } = opts;
  if (typeof passkeys !== 'number') return undefined;
  const key = passkeys > 0 ? 'Passkey on' : 'No passkey';
  return typeof sessions === 'number' && sessions > 0 ? `${key} · ${plural(sessions, 'session', 'sessions')}` : key;
}

/** "Push on · High and above" / "Push off · Email on" / "Push blocked". */
export function notificationsSummary(
  prefs: Pick<NotificationPrefsV2, 'push_severity_floor' | 'email_severity_floor'> | null | undefined,
  push: PushState | null | undefined,
): string | undefined {
  if (!prefs || !push) return undefined;
  const state = pushSummaryState(prefs, push);
  if (state === 'on') return `Push on · ${floorLabel(prefs.push_severity_floor)}`;
  if (state === 'blocked') return 'Push blocked';
  if (state === 'paused') return 'Push paused';
  const emailOn = prefs.email_severity_floor !== 'off';
  return `Push off · ${emailOn ? 'Email on' : 'Email off'}`;
}

/** "2 devices · App installed". */
export function devicesSummary(opts: { devices?: number | null; installed?: boolean | null }): string | undefined {
  const { devices, installed } = opts;
  if (typeof devices !== 'number') return undefined;
  const count = devices === 0 ? 'No devices' : plural(devices, 'device', 'devices');
  if (typeof installed !== 'boolean') return count;
  return `${count} · ${installed ? 'App installed' : 'App not installed'}`;
}
