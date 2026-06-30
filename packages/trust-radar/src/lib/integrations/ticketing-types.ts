/** Shared shapes for ticketing connectors (Jira, ServiceNow, …). */

export interface TicketContext {
  summary: string;
  description: string;
  severity?: string;
}

export interface TicketCreateResult {
  ok: boolean;
  externalKey?: string;
  externalUrl?: string;
  httpStatus?: number;
  error?: string;
}

export interface TicketCloseResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
}

export interface ConnectorTestResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
}

/** Fetch with a hard timeout. Returns null on abort/network error. */
export async function timedFetch(
  url: string,
  init: RequestInit,
  ms = 10_000,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function strField(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
