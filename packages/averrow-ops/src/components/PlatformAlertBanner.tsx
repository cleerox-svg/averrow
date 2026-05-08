// Top-of-page banner that surfaces unread platform_* notifications on
// Home, Agents, and Feeds. Built after the Apr 30 - May 2 ingest
// blackout, where platform_feed_silent fired but no operator saw it
// for 3 days because the bell + push channel was either dismissed or
// silently dropped.
//
// This banner is the loudest channel in the in-app stack — it sits
// pinned above the page content until the user explicitly dismisses
// it, marks it read, or clicks through. Dismissal is per-device,
// per-notification-id (localStorage) so a new platform_* notification
// always re-surfaces even if the previous one was waved away.

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { useNotifications, useMarkRead, type Notification } from '@/hooks/useNotifications';

const SHOW_ON_PATHS = ['/', '/agents', '/feeds'];
const DISMISSED_KEY = 'averrow:platform-alerts:dismissed-v1';

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((s): s is string => typeof s === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(set: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]));
  } catch {
    // Storage unavailable (private mode) — non-fatal; the banner
    // simply re-surfaces on next load.
  }
}

const SEVERITY_RANK: Record<Notification['severity'], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

interface PaletteEntry {
  bg: string;
  border: string;
  text: string;
  dot: string;
  glow: string;
}

const PALETTE: Record<Notification['severity'], PaletteEntry> = {
  critical: {
    bg: 'rgba(239,68,68,0.10)',
    border: 'rgba(239,68,68,0.35)',
    text: '#fca5a5',
    dot: '#f87171',
    glow: 'rgba(248,113,113,0.9)',
  },
  high: {
    bg: 'rgba(249,115,22,0.10)',
    border: 'rgba(249,115,22,0.30)',
    text: '#fdba74',
    dot: '#fb923c',
    glow: 'rgba(251,146,60,0.9)',
  },
  medium: {
    bg: 'rgba(229,168,50,0.10)',
    border: 'rgba(229,168,50,0.30)',
    text: '#fcd34d',
    dot: '#fbbf24',
    glow: 'rgba(251,191,36,0.9)',
  },
  low: {
    bg: 'rgba(59,130,246,0.10)',
    border: 'rgba(59,130,246,0.30)',
    text: '#93c5fd',
    dot: '#60a5fa',
    glow: 'rgba(96,165,250,0.9)',
  },
  info: {
    bg: 'rgba(255,255,255,0.05)',
    border: 'rgba(255,255,255,0.15)',
    text: 'rgba(255,255,255,0.85)',
    dot: '#9ca3af',
    glow: 'rgba(156,163,175,0.6)',
  },
};

export function PlatformAlertBanner() {
  const location = useLocation();
  const onTargetRoute = SHOW_ON_PATHS.includes(location.pathname);
  // useNotifications takes an `enabled` flag; only fetch on the routes
  // we actually render on, to avoid every page paying the network cost.
  const { data } = useNotifications(onTargetRoute);
  const markRead = useMarkRead();
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  // Pick the highest-severity unread platform_* notification that the
  // user hasn't already dismissed on this device. Newer ties beat older.
  const alert = useMemo(() => {
    const items = data?.notifications ?? [];
    const candidates = items.filter(
      (n) => n.type.startsWith('platform_') && n.state === 'unread' && !dismissed.has(n.id),
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => {
      const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sev !== 0) return sev;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })[0]!;
  }, [data, dismissed]);

  // Trim the dismissed set to only ids that are still in the inbox so
  // the localStorage entry doesn't grow unbounded across months. Run
  // whenever the notifications payload changes.
  useEffect(() => {
    if (!data?.notifications) return;
    const live = new Set(data.notifications.map((n) => n.id));
    let pruned = false;
    const next = new Set<string>();
    dismissed.forEach((id) => {
      if (live.has(id)) next.add(id);
      else pruned = true;
    });
    if (pruned) {
      setDismissed(next);
      saveDismissed(next);
    }
  }, [data, dismissed]);

  if (!onTargetRoute || !alert) return null;

  const palette = PALETTE[alert.severity];

  const handleDismiss = () => {
    const next = new Set(dismissed);
    next.add(alert.id);
    setDismissed(next);
    saveDismissed(next);
  };

  const handleMarkRead = () => {
    markRead.mutate(alert.id);
    // Optimistically dismiss so the banner disappears immediately
    // even if the mutation is in flight.
    handleDismiss();
  };

  return (
    <div
      role="alert"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        margin: '0 0 12px',
        padding: '10px 14px',
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div style={{ position: 'relative', width: 8, height: 8, flexShrink: 0 }}>
        <div
          style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            background: palette.dot, opacity: 0.7,
            animation: 'mcc-ping 1.4s ease-in-out infinite',
          }}
        />
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: palette.dot, boxShadow: `0 0 8px ${palette.glow}` }} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: 700, color: palette.text,
          fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
          textTransform: 'uppercase',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {alert.title}
        </div>
        <div style={{
          fontSize: 12, color: 'var(--text-secondary)',
          marginTop: 2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {alert.message}
        </div>
      </div>

      <Link
        to="/alerts"
        onClick={handleMarkRead}
        style={{
          fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700,
          color: 'var(--amber)', textDecoration: 'none',
          letterSpacing: '0.06em', padding: '6px 10px',
          flexShrink: 0,
        }}
      >
        VIEW →
      </Link>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss platform alert"
        style={{
          width: 28, height: 28, padding: 0,
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--text-tertiary)', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 6,
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
