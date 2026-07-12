// VerdictBand — single honest health verdict for /admin.
//
// Replaces the old top-of-page pill (AdminDashboard.tsx, pre-2026-07) that
// was derived ONLY from `agents.errors === 0` — false confidence, since it
// showed "OPERATIONAL" even while feeds were failing or the AI budget was
// in emergency throttle.
//
// Tier 2a: computes a worst-of severity CLIENT-SIDE from the ONE dashboard
// snapshot (useDashboardSnapshot, GET /api/admin/dashboard) instead of 4
// separate hooks:
//   - snapshot.threat_health -> agents_24h.errors > 0
//   - snapshot.budget        -> throttle level (emergency/hard/soft)
//   - snapshot.feeds         -> at_risk_count (+ per-row `severity`, stamped
//                               by the backend directly — see feedsSeverity())
//   - snapshot.pipeline      -> worst_tone (genuine-problem signal only;
//                               benign states like an unconfigured GeoIP
//                               binding are excluded server-side)
//
// Tier 2a fix pass (2026-07): the VerdictBand rewire had a regression where
// an auto-paused-from-failures feed could read OPERATIONAL, because the
// original client-side mapping matched on `verdict.label` text rather than
// a real severity field. The backend now stamps `severity` on each at_risk
// row directly (feedsSeverity() below reads it, no re-derivation).
//
// Guardrail (do not rebuild the bug this replaces): a signal whose data is
// missing/unfetched/errored counts as 'unknown', never 'ok'. The rank order
// below is critical > high > medium > low > unknown > ok, so:
//   - a genuinely bad signal is never masked just because the snapshot (or
//     one of its slices) hasn't resolved yet (unknown can't outrank a real
//     severity), and
//   - the band can never read green while any signal is still unresolved
//     (unknown outranks ok, so it can't be silently dropped to "healthy").
//
// Two distinct "unknown" sources now exist, both handled the same way:
//   1. The whole snapshot is loading/errored/absent — every contributor is
//      unknown (was previously possible per-hook; now it's all-or-nothing
//      since there's one request).
//   2. The snapshot loaded fine but a given SLICE is null — e.g.
//      `threat_health` is null for a plain admin (RBAC — see
//      handleAdminDashboard) even though budget/feeds/pipeline are
//      populated. Exactly this shape is what previously happened when the
//      super-admin-only system-health hook 401'd for a plain admin —
//      behavior preserved.

import { Link } from 'react-router-dom';
import { Card, Badge } from '@/design-system/components';
import type { Severity } from '@/design-system/components';
import {
  useDashboardSnapshot,
  type DashboardFeedsSlice,
  type DashboardPipelineSlice,
} from '@/hooks/useDashboardSnapshot';

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

// Feeds: the backend now stamps a per-row `severity` directly on each
// `at_risk` entry (handleAdminDashboard) — 'critical' covers both
// auto-paused-from-failures feeds AND >=80% to auto-pause / high failure
// rate; 'high' covers 60-79% / failing. This is the fix for the regression
// the VerdictBand rewire introduced: an auto-paused feed used to fall out
// of the OLD label-matching logic (`verdict.label === 'AT RISK'`) because
// its verdict label didn't say "AT RISK", so the band read OPERATIONAL
// while a feed was dead. Reading `severity` directly closes that gap.
function feedsSeverity(feeds: DashboardFeedsSlice): { severity: BandSeverity; detail: string } {
  if (feeds.at_risk_count === 0) {
    return { severity: 'ok', detail: 'healthy' };
  }
  const visibleCritical = feeds.at_risk.some(f => f.severity === 'critical');
  // `at_risk` is capped to the first 20 rows server-side (see
  // handleAdminDashboard) — if the true count exceeds what we can see,
  // don't risk under-reporting: treat the hidden remainder as critical.
  const hasHiddenRows = feeds.at_risk_count > feeds.at_risk.length;
  const severity: BandSeverity = visibleCritical || hasHiddenRows ? 'critical' : 'high';
  const detail = severity === 'critical'
    ? `${feeds.at_risk_count} feed${feeds.at_risk_count === 1 ? '' : 's'} at/near auto-pause`
    : `${feeds.at_risk_count} feed${feeds.at_risk_count === 1 ? '' : 's'} near auto-pause`;
  return { severity, detail };
}

// Pipelines: the snapshot pre-aggregates a worst_tone across all pipeline
// verdicts server-side (handlePipelineStatus's GROWING/STALE/etc, rolled up
// in handleAdminDashboard, with benign states like an unconfigured GeoIP
// binding already excluded — so worst_tone only ever reflects a genuine
// problem). Calibrated to match the severities the old per-pipeline
// client-side filter used: worst_tone 'critical' -> 'high' here, 'warning'
// -> 'medium'. worst_tone === 'unknown' means the pipeline list itself was
// empty (nothing to assess) — treated as unresolved, not healthy.
function pipelineSeverity(pipeline: DashboardPipelineSlice): { severity: BandSeverity; detail: string } {
  if (pipeline.worst_tone === 'unknown') {
    return { severity: 'unknown', detail: 'no pipelines reported' };
  }
  const severity: BandSeverity =
    pipeline.worst_tone === 'critical' ? 'high' :
    pipeline.worst_tone === 'warning'  ? 'medium' :
                                          'ok';
  // Neutral copy — a critical row may be an EMPTY reference dataset, not a
  // growing backlog, so don't hardcode "growing"/"stale" wording onto it.
  const detail = severity === 'ok'
    ? 'healthy'
    : `${pipeline.needs_attention_count} pipeline${pipeline.needs_attention_count === 1 ? '' : 's'} need attention`;
  return { severity, detail };
}

export function VerdictBand() {
  const { data: snapshot, isLoading, isError } = useDashboardSnapshot();
  const snapshotUnavailable = isLoading || isError || !snapshot;

  const contributors: Contributor[] = [];

  // 1 — Agent errors (threat_health slice; null for non-super_admin, and
  // for any whole-snapshot failure).
  const threatHealth = snapshot?.threat_health;
  if (snapshotUnavailable || !threatHealth) {
    contributors.push({ key: 'agents', label: 'Agents', severity: 'unknown', detail: 'status pending', to: '/agents' });
  } else {
    const errors = threatHealth.agents_24h.errors;
    contributors.push({
      key:      'agents',
      label:    'Agents',
      severity: errors > 0 ? 'high' : 'ok',
      detail:   errors > 0 ? `${errors} agent error${errors === 1 ? '' : 's'} (24h)` : 'no errors (24h)',
      to:       '/agents',
    });
  }

  // 2 — AI budget throttle
  const budget = snapshot?.budget;
  if (snapshotUnavailable || !budget) {
    contributors.push({ key: 'budget', label: 'AI budget', severity: 'unknown', detail: 'status pending', to: '/admin?tab=cost#budget-panel' });
  } else {
    const level = budget.status.throttle_level;
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
        ? `${budget.status.pct_used.toFixed(0)}% of monthly limit`
        : `${budget.status.pct_used.toFixed(0)}% budget · ${level} throttle`,
      to: '/admin?tab=cost#budget-panel',
    });
  }

  // 3 — Feeds at/near auto-pause (same tiering as FeedFailures.tsx's
  // feedRiskTier, re-derived from the snapshot's pre-filtered at_risk list)
  const feeds = snapshot?.feeds;
  if (snapshotUnavailable || !feeds) {
    contributors.push({ key: 'feeds', label: 'Feeds', severity: 'unknown', detail: 'status pending', to: '/admin?tab=feeds' });
  } else {
    const { severity, detail } = feedsSeverity(feeds);
    contributors.push({ key: 'feeds', label: 'Feeds', severity, detail, to: '/admin?tab=feeds' });
  }

  // 4 — Pipeline backlog verdicts (GROWING falling behind, STALE unmeasured)
  const pipeline = snapshot?.pipeline;
  if (snapshotUnavailable || !pipeline) {
    contributors.push({ key: 'pipelines', label: 'Pipelines', severity: 'unknown', detail: 'status pending', to: '/admin?tab=pipelines' });
  } else {
    const { severity, detail } = pipelineSeverity(pipeline);
    contributors.push({ key: 'pipelines', label: 'Pipelines', severity, detail, to: '/admin?tab=pipelines' });
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
