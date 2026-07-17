/**
 * Shared types + helpers for "push" connectors — destinations that receive
 * every platform event (SIEM/log sinks: Splunk HEC, Microsoft Sentinel,
 * IBM QRadar). Ticketing connectors live in ticketing-types.ts.
 */

export interface ConnectorResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
  /** Set true for transient failures worth retrying (network/timeout/429/5xx). */
  retryable?: boolean;
}

export interface OutboundEvent {
  event: string;
  timestamp: string;
  org_id: number;
  data: Record<string, unknown>;
}

/** A response is worth retrying if it's a network error, timeout, 429, or 5xx. */
export function isRetryableStatus(httpStatus: number | undefined): boolean {
  if (httpStatus === undefined) return true; // network error / timeout / abort
  return httpStatus === 429 || httpStatus >= 500;
}

/** base64 string → bytes (for keys delivered as base64, e.g. Sentinel shared key). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** bytes → base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** UTF-8 byte length of a string (Sentinel signs over Content-Length). */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
