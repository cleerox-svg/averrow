// useMilestone — feeds the Home celebration banner.
//
// Reads /api/v1/public/milestones/latest (no auth, edge-cacheable).
// The endpoint returns the most-recently fired platform_milestones row
// (e.g. when threats_ingested crossed 400K, 1M, etc.).

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface PlatformMilestone {
  value:        number;
  metric:       string;
  fired_at:     string;
  agent_run_id: string | null;
  notes:        string | null;
}

const POLL_MS = 5 * 60_000;
const DISMISSED_KEY = 'averrow_milestone_dismissed';

export function useMilestoneLatest() {
  return useQuery({
    queryKey: ['platform-milestone-latest'],
    queryFn: async (): Promise<PlatformMilestone | null> => {
      try {
        const res = await api.get<PlatformMilestone | null>('/api/v1/public/milestones/latest');
        return res.data ?? null;
      } catch {
        return null;
      }
    },
    refetchInterval: POLL_MS,
    staleTime: 60_000,
  });
}

/**
 * Returns true when the user has already dismissed this exact milestone
 * value on this device. Dismissals are scoped to the milestone value so
 * crossing the next threshold (e.g. 500K after 400K) shows the banner
 * again automatically.
 */
export function useMilestoneDismissed(value: number | null): {
  dismissed: boolean;
  dismiss: () => void;
} {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (value == null || typeof window === 'undefined') return false;
    try {
      const raw = window.localStorage.getItem(DISMISSED_KEY);
      if (!raw) return false;
      const list = JSON.parse(raw) as number[];
      return Array.isArray(list) && list.includes(value);
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (value == null || typeof window === 'undefined') {
      setDismissed(false);
      return;
    }
    try {
      const raw = window.localStorage.getItem(DISMISSED_KEY);
      const list = raw ? (JSON.parse(raw) as number[]) : [];
      setDismissed(Array.isArray(list) && list.includes(value));
    } catch {
      setDismissed(false);
    }
  }, [value]);

  const dismiss = () => {
    if (value == null || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(DISMISSED_KEY);
      const list = raw ? (JSON.parse(raw) as number[]) : [];
      const next = Array.from(new Set([...(Array.isArray(list) ? list : []), value]));
      window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      setDismissed(true);
    } catch {
      // Ignore — banner will just keep showing on this device.
    }
  };

  return { dismissed, dismiss };
}
