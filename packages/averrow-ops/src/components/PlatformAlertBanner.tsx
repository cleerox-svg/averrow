// Top-of-page banner that surfaces unread platform_* notifications on
// Home, Agents, and Feeds. Built after the Apr 30 - May 2 ingest
// blackout, where platform_feed_silent fired but no operator saw it
// for 3 days because the bell + push channel was either dismissed or
// silently dropped.
//
// This banner is the loudest channel in the in-app stack — it sits
// at the top of the page (not sticky) until the user dismisses it or
// clicks through (View marks it read). Dismissal is per-device,
// per-notification-id (localStorage) so a new platform_* notification
// always re-surfaces even if the previous one was waved away.

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
// Shared-kit Button on purpose (same choice as AlertQueueBanner): the ops barrel Button is mono/uppercase.
import { Banner, Button, type BannerTone } from '@averrow/shared/ui';
import { useNotifications, useMarkRead, type Notification } from '@/hooks/useNotifications';
import { resolveNotificationLink } from '@/lib/notificationLink';

// Overview, plus the Agents and Feeds panes of the Operations workspace
// (`?tab=` absent or unknown renders the default pane, Agents). Only the
// panes known NOT to be health panes hide the banner.
const HIDE_ON_OPERATIONS_TABS: readonly string[] = ['takedown-integrations', 'attribution'];
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

const TONE: Record<Notification['severity'], BannerTone> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info',
};

// Same destination as the notification bell's "View all".
const INBOX_ROUTE = '/notifications';

export function PlatformAlertBanner() {
  const location = useLocation();
  const opsTab = new URLSearchParams(location.search).get('tab');
  const onTargetRoute =
    location.pathname === '/' ||
    (location.pathname === '/admin/operations' && !(opsTab && HIDE_ON_OPERATIONS_TABS.includes(opsTab)));
  // useNotifications takes an `enabled` flag; only fetch on the routes
  // we actually render on, to avoid every page paying the network cost.
  const { data } = useNotifications(onTargetRoute);
  const markRead = useMarkRead();
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  // Highest-severity unread platform_* notification the user hasn't
  // dismissed on this device (newer ties beat older), plus the count of
  // the others still waiting.
  const { alert, moreCount } = useMemo(() => {
    const items = data?.notifications ?? [];
    const candidates = items.filter(
      (n) => n.type.startsWith('platform_') && n.state === 'unread' && !dismissed.has(n.id),
    );
    if (candidates.length === 0) return { alert: null, moreCount: 0 };
    const top = [...candidates].sort((a, b) => {
      const sev = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
      if (sev !== 0) return sev;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })[0]!;
    return { alert: top, moreCount: candidates.length - 1 };
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

  // Defensive: severity comes from API data; an unexpected value falls back
  // to the neutral 'info' tone (Banner also normalises unknown tones).
  const tone = TONE[alert.severity] ?? 'info';
  const href = resolveNotificationLink(alert.link, INBOX_ROUTE);
  const hasExtra = Boolean(alert.reason_text || alert.recommended_action);

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
    <Banner
      // key resets the expanded state when a different alert surfaces.
      key={alert.id}
      aria-label="Platform alert"
      // Polite one-time announcement for new critical/high alerts (never role="alert").
      role={tone === 'critical' || tone === 'high' ? 'status' : undefined}
      variant="inline"
      tone={tone}
      pulse={tone === 'critical'}
      title={alert.title}
      headingLevel="none"
      detailsTrigger="button"
      details={
        hasExtra ? (
          <>
            {alert.reason_text && <p style={{ margin: 0 }}><span style={{ color: 'var(--text-tertiary)' }}>Why:</span> {alert.reason_text}</p>}
            {alert.recommended_action && (
              <p style={{ margin: alert.reason_text ? '4px 0 0' : 0 }}>
                <span style={{ color: 'var(--text-tertiary)' }}>What to do:</span> {alert.recommended_action}
              </p>
            )}
          </>
        ) : undefined
      }
      actions={
        <>
          <Button asChild size="sm" variant="secondary">
            <Link to={href} onClick={handleMarkRead}>View</Link>
          </Button>
          {moreCount > 0 && (
            <Link to={INBOX_ROUTE} className="ds-banner-link">+{moreCount} more</Link>
          )}
        </>
      }
      onDismiss={handleDismiss}
      dismissLabel="Dismiss platform alert"
    >
      {alert.message}
    </Banner>
  );
}
