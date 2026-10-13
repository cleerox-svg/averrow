// Alerts queue banner — replaces the two glowing red banners.
//   - Expandable banner (default): native <details>, tone follows whether
//     anything is past SLA.
//   - Incident card: only when critical alerts are past SLA and the card is
//     not snoozed. Snooze falls back to the expandable banner.
// Pure presentational: counts in, callbacks out. Styling uses design-system
// tokens only so both themes work.

import { useEffect, useRef, useState } from 'react';
// Shared-kit Button on purpose: the ops barrel Button is mono/uppercase, which this design moves away from.
import { Banner, Button } from '@averrow/shared/ui';
import { formatSpan } from '@/lib/time';

export interface AlertQueueBannerProps {
  /** Alerts waiting for review (stats.new_count). */
  unreviewed: number;
  /** Open alerts past SLA. */
  breached: number;
  /** Critical alerts past SLA. */
  breachedCritical: number;
  /** Open alerts approaching SLA. */
  atRisk: number;
  /** Age past deadline of the worst breach, in ms. */
  oldestBreachMs: number;
  /** True when the numbers were computed from the loaded page only. */
  sampled?: boolean;
  /** Number of alerts the sampled numbers are based on. */
  sampledCount?: number;
  onShowBreached: () => void;
  onShowApproaching: () => void;
  /** Sets severity=critical and SLA=breached. */
  onShowCritical: () => void;
  /** Polite screen-reader announcement (e.g. the page's live region). */
  onAnnounce?: (msg: string) => void;
}

export const QUEUE_BANNER_OPEN_KEY = 'alerts.queue_banner.open';
export const INCIDENT_SNOOZE_KEY = 'alerts.incident_snoozed_until';
const SNOOZE_MS = 60 * 60_000;

const n = (v: number) => v.toLocaleString();
const plural = (v: number, one: string, many: string) => (v === 1 ? one : many);

function readOpen(): boolean {
  try { return localStorage.getItem(QUEUE_BANNER_OPEN_KEY) === '1'; } catch { return false; }
}
function writeOpen(open: boolean) {
  try { localStorage.setItem(QUEUE_BANNER_OPEN_KEY, open ? '1' : '0'); } catch { /* storage unavailable */ }
}
interface Snooze { until: number; count: number }
function readSnooze(): Snooze | null {
  try {
    const raw = localStorage.getItem(INCIDENT_SNOOZE_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null; // old numeric format = expired
    const { until, count } = v as Record<string, unknown>;
    return typeof until === 'number' && Number.isFinite(until) && typeof count === 'number' ? { until, count } : null;
  } catch { return null; }
}
function writeSnooze(s: Snooze) {
  try { localStorage.setItem(INCIDENT_SNOOZE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

const NUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontVariantNumeric: 'tabular-nums' };

function SampledNote({ count }: { count?: number }) {
  return (
    <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
      Based on the {count !== undefined ? `${n(count)} ` : ''}most recent alerts loaded
    </p>
  );
}

export function AlertQueueBanner(props: AlertQueueBannerProps) {
  const {
    unreviewed, breached, breachedCritical, atRisk, oldestBreachMs, sampled, sampledCount,
    onShowBreached, onShowApproaching, onShowCritical, onAnnounce,
  } = props;

  const [open, setOpen] = useState<boolean>(readOpen);
  const [snooze, setSnooze] = useState<Snooze | null>(readSnooze);
  const [now, setNow] = useState<number>(() => Date.now());
  const headerRef = useRef<HTMLElement | null>(null);

  // Valid only while unexpired, not implausibly far in the future (clock
  // skew / tampering), and the incident has not worsened since.
  const t = Math.max(now, Date.now());
  const snoozed = !!snooze && snooze.until > t && snooze.until <= t + SNOOZE_MS && breachedCritical <= snooze.count;

  // Re-check when a snooze expires so the incident card returns on its own.
  useEffect(() => {
    if (!snooze) return undefined;
    const delay = Math.min(snooze.until - Date.now(), SNOOZE_MS);
    if (delay <= 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), delay + 250);
    return () => clearTimeout(timer);
  }, [snooze, now]);

  if (unreviewed === 0 && breached === 0 && atRisk === 0) return null;

  if (breachedCritical > 0 && !snoozed) {
    const stat = (label: string, value: string, mono = false) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
        <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', ...(mono ? MONO : NUM) }}>{value}</span>
      </div>
    );
    return (
      <Banner
        variant="prominent"
        tone="critical"
        eyebrow="SLA breach"
        pulse
        labelFromTitle
        headingLevel={2}
        title="Critical alerts are past their response deadline"
        footer={
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: '12px 20px', marginTop: 12 }}>
              {stat('Breached', n(breached))}
              {stat('Critical', n(breachedCritical))}
              {stat('Approaching', n(atRisk))}
              {stat('Oldest', formatSpan(oldestBreachMs), true)}
            </div>
            {sampled && <div style={{ marginTop: 12 }}><SampledNote count={sampledCount} /></div>}
          </>
        }
        actions={
          <>
            <Button size="sm" onClick={onShowCritical}>Show critical breaches</Button>
            <Button size="sm" variant="secondary" onClick={onShowBreached}>Show all breached</Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const next = { until: Date.now() + SNOOZE_MS, count: breachedCritical };
                writeSnooze(next);
                setSnooze(next);
                setNow(Date.now());
                onAnnounce?.('Critical SLA card snoozed for 1 hour');
                requestAnimationFrame(() => headerRef.current?.focus());
              }}
            >
              Snooze 1 hour
            </Button>
          </>
        }
      >
        Clear these first.
      </Banner>
    );
  }

  const critical = breached > 0;
  const title = critical
    ? <><span style={NUM}>{n(breached)}</span> {plural(breached, 'alert', 'alerts')} past SLA</>
    : unreviewed > 0
      ? <><span style={NUM}>{n(unreviewed)}</span> {plural(unreviewed, 'alert', 'alerts')} waiting for review</>
      : <><span style={NUM}>{n(atRisk)}</span> {plural(atRisk, 'alert', 'alerts')} approaching SLA</>;
  const subtitle = critical
    ? <><span style={NUM}>{n(unreviewed)}</span> waiting for review in total</>
    : unreviewed > 0 && atRisk > 0 ? <><span style={NUM}>{n(atRisk)}</span> approaching SLA</> : 'None past SLA';

  const row = (label: string, value: React.ReactNode, mono = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: '1px dashed var(--border-base)', fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600, ...(mono ? MONO : NUM) }}>{value}</span>
    </div>
  );

  return (
    <Banner
      variant="inline"
      tone={critical ? 'critical' : 'high'}
      pulse={critical}
      headingLevel="none"
      detailsTrigger="header"
      headerRef={headerRef}
      open={open}
      onOpenChange={next => { setOpen(next); writeOpen(next); }}
      title={title}
      details={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            {row('Critical past SLA', n(breachedCritical))}
            {row('Approaching SLA', n(atRisk))}
            {breached > 0 && row('Oldest breach', formatSpan(oldestBreachMs), true)}
          </div>
          {(breached > 0 || atRisk > 0) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {breached > 0 && <Button size="sm" onClick={onShowBreached}>Show breached</Button>}
              {atRisk > 0 && <Button size="sm" variant="secondary" onClick={onShowApproaching}>Show approaching</Button>}
            </div>
          )}
          {sampled && <SampledNote count={sampledCount} />}
        </div>
      }
    >
      {subtitle}
    </Banner>
  );
}
