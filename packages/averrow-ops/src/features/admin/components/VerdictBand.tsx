// VerdictBand — single honest health verdict for /admin.
//
// Replaces the old top-of-page pill (AdminDashboard.tsx, pre-2026-07) that
// was derived ONLY from `agents.errors === 0` — false confidence, since it
// showed "OPERATIONAL" even while feeds were failing or the AI budget was
// in emergency throttle.
//
// Computes a worst-of severity CLIENT-SIDE from data already fetched by
// existing hooks (no new endpoint):
//   - useSystemHealth()  -> agents.errors > 0
//   - useBudgetStatus()  -> throttle level (emergency/hard/soft)
//   - useFeedFailures()  -> feeds at/near auto-pause (reuses the exact
//                           tiering FeedFailures.tsx uses, via feedRiskTier)
//   - usePipelineStatus() -> any pipeline verdict GROWING/STALE
//
// Guardrail (do not rebuild the bug this replaces): a signal whose data is
// missing/unfetched/errored counts as 'unknown', never 'ok'. The rank order
// below is critical > high > medium > low > unknown > ok, so:
//   - a genuinely bad signal is never masked just because an unrelated
//     hook hasn't resolved yet (unknown can't outrank a real severity), and
//   - the band can never read green while any signal is still unresolved
//     (unknown outranks ok, so it can't be silently dropped to "healthy").

import { Link } from 'react-router-dom';
import { Card, Badge } from '@/design-system/components';
import type { Severity } from '@/design-system/components';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useBudgetStatus } from '@/hooks/useBudget';
import { useFeedFailures } from '@/hooks/useMetrics';
import { usePipelineStatus } from '@/hooks/useAgents';
import { feedRiskTier } from '../metrics/FeedFailures';

type BandSeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown' | 'ok';

const RANK: Record<BandSeverity, number> = {
  critical: 5,
  high:     4,
  medium:   3,
  low:      2,
  unknown:  1,
  ok:       0,
};

const LABEL: Record<BandSeverity, string> = {
  critical: 'CRITICAL',
  high:     'HIGH',
  medium:   'MEDIUM',
  low:      'LOW',
  unknown:  'PENDING',
  ok:       'OPERATIONAL',
};

interface Contributor {
  key:      string;
  label:    string;
  severity: BandSeverity;
  detail:   string;
  to:       string;
}

function isBadSeverity(s: BandSeverity): s is 'critical' | 'high' | 'medium' | 'low' {
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low';
}

function ContributorBadge({ c }: { c: Contributor }) {
  const text = `${c.label}: ${c.detail}`;
  if (isBadSeverity(c.severity)) {
    return <Badge severity={c.severity as Severity} label={text} size="xs" />;
  }
  if (c.severity === 'ok') {
    return <Badge status="active" label={text} size="xs" />;
  }
  // unknown — represented distinctly (muted), never conflated with 'ok'.
  return <Badge status="inactive" label={text} size="xs" />;
}

export function VerdictBand() {
  const { data: health, isLoading: healthLoading, isError: healthError } = useSystemHealth();
  const { data: budget, isLoading: budgetLoading, isError: budgetError } = useBudgetStatus();
  const { data: feeds, isLoading: feedsLoading, isError: feedsError } = useFeedFailures();
  const { data: pipelines, isLoading: pipelinesLoading, isError: pipelinesError } = usePipelineStatus();

  const contributors: Contributor[] = [];

  // 1 — Agent errors (system health)
  if (healthLoading || healthError || !health) {
    contributors.push({ key: 'agents', label: 'Agents', severity: 'unknown', detail: 'status pending', to: '/agents' });
  } else {
    const errors = health.agents.errors;
    contributors.push({
      key:      'agents',
      label:    'Agents',
      severity: errors > 0 ? 'high' : 'ok',
      detail:   errors > 0 ? `${errors} agent error${errors === 1 ? '' : 's'} (24h)` : 'no errors (24h)',
      to:       '/agents',
    });
  }

  // 2 — AI budget throttle
  if (budgetLoading || budgetError || !budget) {
    contributors.push({ key: 'budget', label: 'AI budget', severity: 'unknown', detail: 'status pending', to: '/admin#budget-panel' });
  } else {
    const level = budget.throttle_level;
    const severity: BandSeverity =
      level === 'emergency' ? 'critical' :
      level === 'hard'      ? 'high' :
      level === 'soft'      ? 'medium' :
                               'ok';
    contributors.push({
      key:      'budget',
      label:    'AI budget',
      severity,
      detail:   level === 'none'
        ? `${budget.pct_used.toFixed(0)}% of monthly limit`
        : `${budget.pct_used.toFixed(0)}% budget · ${level} throttle`,
      to: '/admin#budget-panel',
    });
  }

  // 3 — Feeds at/near auto-pause (same tiering as FeedFailures.tsx)
  if (feedsLoading || feedsError || !feeds) {
    contributors.push({ key: 'feeds', label: 'Feeds', severity: 'unknown', detail: 'status pending', to: '/admin/metrics?tab=feed-failures' });
  } else {
    const rows = feeds.per_feed;
    const criticalCount = rows.filter(r => feedRiskTier(r) === 'critical').length;
    const highCount     = rows.filter(r => feedRiskTier(r) === 'high').length;
    let severity: BandSeverity = 'ok';
    let detail = 'healthy';
    if (criticalCount > 0) {
      severity = 'critical';
      detail = `${criticalCount} feed${criticalCount === 1 ? '' : 's'} at/near auto-pause`;
    } else if (highCount > 0) {
      severity = 'high';
      detail = `${highCount} feed${highCount === 1 ? '' : 's'} near auto-pause`;
    }
    contributors.push({ key: 'feeds', label: 'Feeds', severity, detail, to: '/admin/metrics?tab=feed-failures' });
  }

  // 4 — Pipeline backlog verdicts (GROWING falling behind, STALE unmeasured)
  if (pipelinesLoading || pipelinesError || !pipelines) {
    contributors.push({ key: 'pipelines', label: 'Pipelines', severity: 'unknown', detail: 'status pending', to: '/admin/metrics?tab=pipelines' });
  } else {
    const growing = pipelines.filter(p => p.verdict?.label?.toUpperCase() === 'GROWING');
    const stale   = pipelines.filter(p => p.verdict?.label?.toUpperCase() === 'STALE');
    let severity: BandSeverity = 'ok';
    let detail = 'healthy';
    if (growing.length > 0) {
      severity = 'high';
      detail = `${growing.length} pipeline${growing.length === 1 ? '' : 's'} growing`;
    } else if (stale.length > 0) {
      severity = 'medium';
      detail = `${stale.length} pipeline${stale.length === 1 ? '' : 's'} stale`;
    }
    contributors.push({ key: 'pipelines', label: 'Pipelines', severity, detail, to: '/admin/metrics?tab=pipelines' });
  }

  const overall = contributors.reduce<BandSeverity>(
    (worst, c) => (RANK[c.severity] > RANK[worst] ? c.severity : worst),
    'ok',
  );

  const badContributors = contributors
    .filter(c => c.severity !== 'ok' && c.severity !== 'unknown')
    .sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const unknownContributors = contributors.filter(c => c.severity === 'unknown');

  let summary: string;
  if (overall === 'ok') {
    summary = 'All monitored signals healthy — agents, AI budget, feeds, and pipelines.';
  } else if (overall === 'unknown') {
    summary = `Health check pending — waiting on ${unknownContributors.map(c => c.label).join(', ')}.`;
  } else {
    summary = badContributors.map(c => c.detail).join(' · ');
  }

  // `accent` is only honored by Card when variant === 'active' (see
  // design-system Card.tsx), and cardVariant maps 'ok' to 'base' — so a
  // green accent here would be silently discarded, not rendered as a
  // healthy glow. Intended/correct behavior is a neutral card when
  // healthy (Badge alone stays green), so there's no 'ok' branch below.
  const cardVariant = overall === 'critical' ? 'critical' : isBadSeverity(overall) ? 'active' : 'base';
  const accent =
    overall === 'high'   ? 'var(--sev-high)' :
    overall === 'medium' ? 'var(--sev-medium)' :
    overall === 'low'    ? 'var(--sev-low)' :
                            undefined;

  return (
    <Card variant={cardVariant} accent={accent} padding="16px 20px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Badge
          severity={isBadSeverity(overall) ? overall : undefined}
          status={overall === 'ok' ? 'active' : overall === 'unknown' ? 'inactive' : undefined}
          label={LABEL[overall]}
          size="md"
          pulse={overall === 'critical' || overall === 'high'}
        />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          {summary}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {contributors.map(c => (
          <Link key={c.key} to={c.to} style={{ textDecoration: 'none' }}>
            <ContributorBadge c={c} />
          </Link>
        ))}
      </div>
    </Card>
  );
}
