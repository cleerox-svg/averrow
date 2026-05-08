// Hooks for the platform Web Push admin surface — wraps the four
// super_admin endpoints in `handlers/adminPush.ts`:
//
//   GET  /api/admin/push/config              — current state
//   POST /api/admin/push/generate-vapid-keys — fresh keypair (one-time private key reveal)
//   PUT  /api/admin/push/config              — flip enabled / update subject + public_key
//   POST /api/admin/push/test                — send a test push to caller's devices
//
// The bootstrap sequence is deliberately manual because the VAPID
// private key has to be a Worker secret (`wrangler secret put`),
// which can't run from inside a Worker request. The UI walks the
// operator through the steps; the secret-put still happens offline.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface PushAdminConfig {
  push_enabled: boolean;
  vapid_public_key: string;
  vapid_subject: string;
  vapid_private_key_configured: boolean;
  last_updated: string | null;
}

export function usePushConfig() {
  return useQuery({
    queryKey: ["admin-push-config"],
    queryFn: async () => {
      const res = await api.get<PushAdminConfig>("/api/admin/push/config");
      return res.data ?? {
        push_enabled: false,
        vapid_public_key: "",
        vapid_subject: "",
        vapid_private_key_configured: false,
        last_updated: null,
      };
    },
    refetchInterval: 30_000,
  });
}

export interface GenerateVapidResponse {
  public_key: string;
  /** Returned ONCE — the operator must persist this themselves; the server doesn't keep it. */
  private_key: string;
  subject: string;
  next_steps: string[];
}

export function useGenerateVapidKeys() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (subject?: string) => {
      const res = await api.post<GenerateVapidResponse>(
        "/api/admin/push/generate-vapid-keys",
        subject ? { subject } : {},
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-push-config"] });
    },
  });
}

export interface UpdatePushConfigBody {
  enabled?: boolean;
  subject?: string;
  public_key?: string;
}

export function useUpdatePushConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdatePushConfigBody) => {
      return api.put("/api/admin/push/config", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-push-config"] });
    },
  });
}

// Matches the dispatchPush() return shape the admin handler relays back
// (handlers/adminPush.ts:188 returns the result object directly).
// No per-device breakdown — dispatchPush gives aggregate counts only.
export interface PushTestResponse {
  sent: number;
  expired: number;
  failed: number;
}

export function useTestPush() {
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<PushTestResponse>("/api/admin/push/test", {});
      return res.data;
    },
  });
}
