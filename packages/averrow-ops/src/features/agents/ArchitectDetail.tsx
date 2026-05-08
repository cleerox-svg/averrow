// ARCHITECT — agent detail view.
//
// Single Run button that hits the standard agent-trigger endpoint
// (/api/agents/architect/trigger) like every other agent. The
// markdown report, computed scorecard, and per-section analyses all
// live inside the latest agent_outputs row's `details` JSON, which
// this page reads via the standard useAgentOutputsByName hook.
//
// No bespoke admin routes, no Queue polling, no three-stage flow —
// the architect AgentModule runs collect → analyze → synthesize
// inline inside one execute() call and persists everything in one
// shot. While the run is in flight we poll the outputs feed every
// 5s so the new row appears as soon as it lands.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compass } from 'lucide-react';

import { api } from '@/lib/api';
import {
  useAgentOutputsByName,
  type AgentOutput,
} from '@/hooks/useAgents';
import { Badge, Button, Card, PageHeader } from '@/design-system/components';

/* ─── Types ───────────────────────────────────────────────────────── */

interface SectionScorecard {
  green: number;
  amber: number;
  red: number;
  total: number;
}

interface ComputedScorecard {
  agents: SectionScorecard;
  feeds: SectionScorecard;
  data_layer: SectionScorecard;
  overall: SectionScorecard;
  kill_count: number;
  refactor_count: number;
  split_count: number;
}

interface ArchitectReportDetails {
  run_id: string;
  bundle_r2_key: string;
  report_md: string;
  computed_scorecard: ComputedScorecard;
  cost_breakdown: {
    agents: number;
    feeds: number;
    data_layer: number;
    synthesis: number;
    total: number;
  };
  analyses: Array<{
    section: 'agents' | 'feeds' | 'data_layer';
    model: string;
    cost_usd: number;
    duration_ms: number;
    analysis: unknown;
  }>;
}

interface ParsedArchitectOutput {
  output: AgentOutput;
  details: ArchitectReportDetails;
}

type ModalKind = 'report' | 'analysis' | 'scorecard';

const POLL_INTERVAL_MS = 5_000;

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 0) return 'just now';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(then).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function parseDetails(raw: string | null): ArchitectReportDetails | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ArchitectReportDetails>;
    if (
      typeof parsed.run_id === 'string' &&
      typeof parsed.report_md === 'string' &&
      parsed.computed_scorecard &&
      Array.isArray(parsed.analyses)
    ) {
      return parsed as ArchitectReportDetails;
    }
    return null;
  } catch {
    return null;
  }
}

function severityStyle(scorecard: ComputedScorecard): {
  color: string;
  label: string;
} {
  if (scorecard.overall.red > 0) {
    return { color: 'var(--sev-critical)', label: 'red' };
  }
  if (scorecard.overall.amber > 0) {
    return { color: 'var(--sev-medium)', label: 'amber' };
  }
  return { color: 'var(--green)', label: 'green' };
}

/* ─── Main page ───────────────────────────────────────────────────── */

export function ArchitectDetail() {
  const { data: rawOutputs, refetch } = useAgentOutputsByName('architect');
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [modalKind, setModalKind] = useState<ModalKind | null>(null);

  // Latest valid architect run output, parsed.
  const latest: ParsedArchitectOutput | null = useMemo(() => {
    if (!rawOutputs || rawOutputs.length === 0) return null;
    for (const output of rawOutputs) {
      const details = parseDetails(output.details);
      if (details) return { output, details };
    }
    return null;
  }, [rawOutputs]);

  // Track which output id we've seen so we know when a fresh row
  // lands and can stop polling.
  const latestOutputId = latest?.output.id ?? null;

  // While polling, refetch every 5s. Stop as soon as a new output id
  // shows up that wasn't there when we started.
  useEffect(() => {
    if (!polling) return;
    const startId = latestOutputId;
    const id = setInterval(() => {
      void refetch().then((res) => {
        const newOutputs = res.data;
        if (!newOutputs || newOutputs.length === 0) return;
        for (const output of newOutputs) {
          const details = parseDetails(output.details);
          if (details && output.id !== startId) {
            setPolling(false);
            setMessage('Audit complete.');
            return;
          }
        }
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [polling, latestOutputId, refetch]);

  const handleRun = useCallback(async () => {
    setStarting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.post('/api/agents/architect/trigger', {});
      if (res.success === false) {
        throw new Error(res.error ?? 'Failed to start ARCHITECT audit');
      }
      setMessage('Audit started — collecting bundle, analyzing, synthesizing…');
      setPolling(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start audit');
    } finally {
      setStarting(false);
    }
  }, []);

  const closeModal = useCallback(() => {
    setModalKind(null);
  }, []);

  // Modal content depends on which viewer was opened.
  const modalContent: { title: string; body: string } | null = useMemo(() => {
    if (!modalKind || !latest) return null;
    switch (modalKind) {
      case 'report':
        return {
          title: 'Report',
          body: latest.details.report_md,
        };
      case 'analysis':
        return {
          title: 'Analyses',
          body: JSON.stringify(latest.details.analyses, null, 2),
        };
      case 'scorecard':
        return {
          title: 'Scorecard',
          body: JSON.stringify(latest.details.computed_scorecard, null, 2),
        };
    }
  }, [modalKind, latest]);

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="ARCHITECT"
        subtitle="Meta-agent — audits agents, feeds, and the data layer"
        badge={
          <Compass
            size={22}
            strokeWidth={1.8}
            style={{
              color: 'var(--amber)',
              filter: 'drop-shadow(0 0 6px rgba(229,168,50,0.45))',
            }}
          />
        }
      />

      {/* Action card */}
      <Card variant="base" padding={20}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.18em]"
              style={{ color: 'var(--amber)' }}
            >
              Run Audit
            </div>
            <p
              className="mt-2 text-[13px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              Runs the full ARCHITECT pipeline as one chain — collect
              context bundle, run three Haiku section analyzers in
              parallel, then a Sonnet synthesis. The run takes about
              one to three minutes; this page polls for the new output
              row every 5 seconds while it&apos;s in flight.
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="md"
              onClick={() => void handleRun()}
              loading={starting || polling}
              disabled={starting || polling}
            >
              {polling ? 'Running…' : 'Run Audit'}
            </Button>
          </div>
        </div>

        {(error || message) && (
          <div
            className="mt-4 rounded-md px-3 py-2 font-mono text-[11px]"
            style={
              error
                ? {
                    background: 'var(--sev-critical-bg)',
                    border: '1px solid var(--sev-critical-border)',
                    color: 'var(--sev-critical)',
                  }
                : {
                    background: 'rgba(229,168,50,0.08)',
                    border: '1px solid rgba(229,168,50,0.25)',
                    color: 'var(--amber)',
                  }
            }
          >
            {error ?? message}
          </div>
        )}
      </Card>

      {/* Latest report card */}
      <Card variant="base" padding={0}>
        <div
          className="flex items-center justify-between px-5 py-3"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div
            className="font-mono text-[10px] uppercase tracking-[0.18em]"
            style={{ color: 'var(--amber)' }}
          >
            Latest Audit
          </div>
          <div
            className="font-mono text-[10px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {polling ? 'Polling every 5s…' : '—'}
          </div>
        </div>

        {!latest ? (
          <div
            className="px-5 py-12 text-center font-mono text-[11px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            No audit yet. Trigger a run to populate this card.
          </div>
        ) : (
          <div className="space-y-5 p-5">
            {/* Headline row — when, severity, cost */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <div
                  className="font-mono text-[9px] uppercase tracking-wider"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Completed
                </div>
                <div
                  className="font-mono text-[12px]"
                  style={{ color: 'var(--text-primary)' }}
                  title={latest.output.created_at}
                >
                  {formatRelative(latest.output.created_at)}
                </div>
              </div>
              <div>
                <div
                  className="font-mono text-[9px] uppercase tracking-wider"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Severity
                </div>
                <Badge
                  severity={
                    latest.details.computed_scorecard.overall.red > 0
                      ? 'high'
                      : latest.details.computed_scorecard.overall.amber > 0
                        ? 'medium'
                        : 'info'
                  }
                  label={severityStyle(latest.details.computed_scorecard).label}
                  size="xs"
                />
              </div>
              <div>
                <div
                  className="font-mono text-[9px] uppercase tracking-wider"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Cost
                </div>
                <div
                  className="font-mono text-[12px]"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {formatCost(latest.details.cost_breakdown.total)}
                </div>
              </div>
              <div>
                <div
                  className="font-mono text-[9px] uppercase tracking-wider"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Run ID
                </div>
                <div
                  className="font-mono text-[11px]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {latest.details.run_id.slice(0, 8)}…
                </div>
              </div>
            </div>

            {/* Summary line from agent_outputs.summary */}
            <div
              className="rounded-md px-3 py-2 font-mono text-[11px]"
              style={{
                background: 'rgba(255,255,255,0.03)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {latest.output.summary}
            </div>

            {/* Scorecard mini table */}
            <div>
              <div
                className="mb-2 font-mono text-[9px] uppercase tracking-widest"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Scorecard
              </div>
              <div className="grid grid-cols-4 gap-3 sm:grid-cols-4">
                {(
                  [
                    ['Agents', latest.details.computed_scorecard.agents],
                    ['Feeds', latest.details.computed_scorecard.feeds],
                    ['Data Layer', latest.details.computed_scorecard.data_layer],
                    ['Overall', latest.details.computed_scorecard.overall],
                  ] as const
                ).map(([label, sc]) => (
                  <div
                    key={label}
                    className="rounded-md p-3"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div
                      className="font-mono text-[10px] uppercase tracking-wider"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {label}
                    </div>
                    <div className="mt-1 flex items-baseline gap-2 font-mono text-[11px]">
                      <span style={{ color: 'var(--green)' }}>{sc.green}g</span>
                      <span style={{ color: 'var(--sev-medium)' }}>
                        {sc.amber}a
                      </span>
                      <span style={{ color: 'var(--sev-critical)' }}>
                        {sc.red}r
                      </span>
                      <span
                        className="ml-auto"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {sc.total}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Viewer buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => setModalKind('report')}
              >
                View Report
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setModalKind('analysis')}
              >
                View Analyses
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setModalKind('scorecard')}
              >
                View Scorecard JSON
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Viewer modal — portaled to body so it covers the full viewport. */}
      {modalKind &&
        modalContent &&
        createPortal(
          <div
            className="fixed inset-0 flex items-center justify-center p-4"
            style={{
              background: 'rgba(0,0,0,0.70)',
              backdropFilter: 'blur(4px)',
              WebkitBackdropFilter: 'blur(4px)',
              zIndex: 'var(--z-modal)' as unknown as number,
            }}
            onClick={closeModal}
          >
            <div
              className="flex max-h-[85vh] min-h-0 w-full max-w-4xl flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <Card
                variant="elevated"
                padding={0}
                className="flex min-h-0 flex-1 flex-col"
              >
                <div
                  className="flex flex-shrink-0 items-center justify-between px-5 py-3"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <div
                    className="font-mono text-[11px] uppercase tracking-[0.18em]"
                    style={{ color: 'var(--amber)' }}
                  >
                    {modalContent.title} · {latest?.details.run_id.slice(0, 8)}…
                  </div>
                  <Button variant="ghost" size="sm" onClick={closeModal}>
                    Close
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <pre
                    className="whitespace-pre-wrap break-all p-5 font-mono text-[11px]"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {modalContent.body}
                  </pre>
                </div>
              </Card>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
