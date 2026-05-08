/**
 * Browser Web Push helpers — paired with the backend in PR 3a.
 *
 * Permission + subscription lifecycle:
 *   1. fetchPushBootstrap()  → get the platform's VAPID public key + flag
 *   2. subscribePush()        → ask Notification.requestPermission(), then
 *                               pushManager.subscribe(), POST result to backend
 *   3. unsubscribePush()      → remove from browser AND backend
 *
 * iOS gating (Safari 16.4+):
 *   - `Notification.permission` cannot be requested unless the PWA is
 *     installed (Add to Home Screen). Use isStandalone() (lib/pwa.ts) at
 *     the call site to gate the subscribe button on iOS. Android Chrome
 *     allows requesting permission from any HTTPS page.
 *
 * No new dependencies. Pure browser APIs.
 */

import { api } from './api';
import { isIOS, isStandalone } from './pwa';

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export interface PushBootstrap {
  public_key: string;
  push_enabled: boolean;
}

export interface PushDevice {
  id: string;
  device_label: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface PushStatus {
  /** Browser supports Notification API + service workers + Push API. */
  supported: boolean;
  /** OS-level permission state. */
  permission: PushPermission;
  /** A `pushManager.subscription` exists in the browser for this origin. */
  subscribed: boolean;
  /** iOS quirk: must be installed before requestPermission() can fire. */
  needsInstall: boolean;
}

// ─── Status / capability detection ──────────────────────────────────────

export function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!isPushSupported()) {
    return { supported: false, permission: 'unsupported', subscribed: false, needsInstall: false };
  }
  // iOS: gating on standalone is REQUIRED before requestPermission. On
  // other platforms it's always allowed.
  const needsInstall = isIOS() && !isStandalone();

  const permission = Notification.permission as PushPermission;
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    subscribed = sub !== null;
  } catch {
    // SW not registered yet, or pushManager unavailable — treat as not subscribed.
  }
  return { supported: true, permission, subscribed, needsInstall };
}

// ─── Backend bootstrap ──────────────────────────────────────────────────

export async function fetchPushBootstrap(): Promise<PushBootstrap> {
  // Backend now exposes both fields under a single endpoint
  // (vapid_public_key + push_enabled). Map to our existing
  // PushBootstrap shape so callers don't have to change.
  const res = await api.get<{ vapid_public_key: string; push_enabled: boolean }>(
    '/api/notifications/config',
  );
  return {
    public_key: res.data?.vapid_public_key ?? '',
    push_enabled: res.data?.push_enabled ?? false,
  };
}

// ─── Subscribe / unsubscribe ────────────────────────────────────────────

export async function subscribePush(): Promise<PushStatus> {
  if (!isPushSupported()) throw new Error('This browser does not support Web Push.');
  if (isIOS() && !isStandalone()) {
    throw new Error('On iOS, install the app to your home screen first (Share → Add to Home Screen).');
  }

  const { public_key, push_enabled } = await fetchPushBootstrap();
  if (!push_enabled || !public_key) {
    throw new Error('Push notifications are currently disabled by the platform admin.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { supported: true, permission, subscribed: false, needsInstall: false };
  }

  const reg = await navigator.serviceWorker.ready;
  // If a stale subscription exists for a different VAPID key, drop it
  // before re-subscribing so the new keys actually take effect.
  const existing = await reg.pushManager.getSubscription();
  if (existing) await existing.unsubscribe().catch(() => {});

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    // Cast through BufferSource — recent lib.dom types parameterize Uint8Array
    // by ArrayBufferLike which can be SharedArrayBuffer; PushManager wants
    // a plain ArrayBuffer-backed view.
    applicationServerKey: base64UrlToBytes(public_key) as unknown as BufferSource,
  });

  // FarmTrack-aligned payload — matches PushSubscription.toJSON()
  // exactly. Backend rejects the legacy flat shape now.
  await api.post('/api/notifications/subscribe', {
    subscription: {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: arrayBufferToBase64Url(subscription.getKey('p256dh')),
        auth: arrayBufferToBase64Url(subscription.getKey('auth')),
      },
    },
    device_label: deriveDeviceLabel(),
  });

  return { supported: true, permission: 'granted', subscribed: true, needsInstall: false };
}

export async function unsubscribePush(): Promise<PushStatus> {
  if (!isPushSupported()) {
    return { supported: false, permission: 'unsupported', subscribed: false, needsInstall: false };
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch {
    // ignore — proceed to backend cleanup regardless
  }

  // Delete *all* of the user's subscriptions on this account. The list
  // endpoint returns devices keyed by id; unsubscribing one device on the
  // browser is enough, but the backend may have a stale row for a previous
  // PWA install on the same device. Cleaning all of them avoids ghost
  // entries showing up in the device list UI.
  try {
    const list = await api.get<PushDevice[]>('/api/notifications/subscriptions');
    const devices = list.data ?? [];
    await Promise.all(
      devices.map((d) => api.delete(`/api/notifications/subscribe/${d.id}`).catch(() => {})),
    );
  } catch {
    // ignore — best-effort cleanup
  }

  return { supported: true, permission: Notification.permission as PushPermission, subscribed: false, needsInstall: false };
}

export async function listPushDevices(): Promise<PushDevice[]> {
  const res = await api.get<PushDevice[]>('/api/notifications/subscriptions');
  return res.data ?? [];
}

export async function removePushDevice(id: string): Promise<void> {
  await api.delete(`/api/notifications/subscribe/${id}`);
}

/** Send a test push to the current user's subscribed devices. */
export async function sendTestPush(): Promise<{ attempted: number; delivered: number }> {
  const res = await api.post<{ attempted: number; delivered: number }>(
    '/api/notifications/test',
    {},
  );
  return res.data ?? { attempted: 0, delivered: 0 };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(s.length / 4) * 4,
    '=',
  );
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deriveDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Browser';
  const ua = navigator.userAgent;
  // Quick heuristic — good enough for the device list UI; user can rename later.
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android device';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}
