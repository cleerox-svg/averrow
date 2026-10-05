// Envelope adapter for the shared account pages.
//
// The tenant `apiGet/apiPost/...` helpers throw on non-2xx; the shared account
// pages (ProfileSettings, SecuritySettings, passkey adapter) expect a
// `{ success, data?, error? }` envelope instead. One adapter, used by all of them.

import { apiDelete, apiGet, apiPatch, apiPost } from './api';

export interface AccountApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function adapt<T>(p: Promise<{ success: true; data: T }>): Promise<AccountApiResponse<T>> {
  try {
    const res = await p;
    return { success: res.success, data: res.data };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Request failed' };
  }
}

export const accountApi = {
  get:    <T,>(path: string) => adapt<T>(apiGet<T>(path)),
  post:   <T,>(path: string, body?: unknown) => adapt<T>(apiPost<T>(path, body ?? {})),
  patch:  <T,>(path: string, body: unknown) => adapt<T>(apiPatch<T>(path, body)),
  delete: <T,>(path: string) => adapt<T>(apiDelete<T>(path)),
};
