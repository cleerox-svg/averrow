// Alerts queue banner — replaces the two glowing red banners.
//   - Expandable banner (default): native <details>, tone follows whether
//     anything is past SLA.
//   - Incident card: only when critical alerts are past SLA and the card is
//     not snoozed. Snooze falls back to the expandable banner.
// Pure presentational: counts in, callbacks out. Styling uses design-system
// tokens only so both themes work.

import { useEffect, useId, useRef, useState } from 'react';
// Shared-kit Button on purpose: the ops barrel Button is mono/uppercase, which this design moves away from.
import { Button } from '@averrow/shared/ui';
import { formatSpan } from '@/lib/time';
import './alert-queue-banner.css';

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

function PulseDot({ pulse }: { pulse: boolean }) {
  const color = pulse ? 'var(--sev-critical)' : 'var(--sev-high)';
  return (
    <span aria-hidden="true" style={{ position: 'relative', width: 8, height: 8, flexShrink: 0, display: 'inline-block' }}>
      {pulse && (
        <span
          style={{
            position: 'absolute', inset: 0, borderRadius: '50%', background: color, opacity: 0.6,
            animation: 'live-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite',
          }}
        />
      )}
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color }} />
    </span>
  );
}

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
  const headingId = useId();
  const summaryRef = useRef<HTMLElement | null>(null);

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
      <section
        aria-labelledby={headingId}
        className="aqb-hairline"
        style={{
          borderRadius: 'var(--card-radius)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12,
          background: 'var(--card-critical-bg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PulseDot pulse />
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sev-critical-text)' }}>
            SLA breach
          </span>
        </div>
        <div>
          <h2 id={headingId} style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
            <span style={NUM}>{n(breachedCritical)}</span> critical {plural(breachedCritical, 'alert', 'alerts')} past the response deadline
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
            Oldest breach is <span style={MONO}>{formatSpan(oldestBreachMs)}</span> past its deadline.
          </p>
        </div>
        <div className="aqb-stats">
          {stat('Breached', n(breached))}
          {stat('Critical', n(breachedCritical))}
          {stat('Approaching', n(atRisk))}
          {stat('Oldest', formatSpan(oldestBreachMs), true)}
        </div>
        {sampled && <SampledNote count={sampledCount} />}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Button size="sm" onClick={onShowCritical}>Show critical breaches</Button>
          <Button size="sm" variant="secondary" onClick={onShowBreached}>Show all breached</Button>
          <button
            type="button"
            className="aqb-snooze"
            onClick={() => {
              const next = { until: Date.now() + SNOOZE_MS, count: breachedCritical };
              writeSnooze(next);
              setSnooze(next);
              setNow(Date.now());
              onAnnounce?.('Critical SLA card snoozed for 1 hour');
              requestAnimationFrame(() => summaryRef.current?.focus());
            }}
            style={{ background: 'none', border: 0, cursor: 'pointer', minHeight: 36, padding: '8px 10px', fontSize: 12, color: 'var(--text-tertiary)', borderRadius: 8 }}
          >
            Snooze 1 hour
          </button>
        </div>
      </section>
    );
  }

  const critical = breached > 0;
  const accent = critical ? 'var(--sev-critical)' : 'var(--sev-high)';
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
    <details
      open={open}
      onToggle={e => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) { setOpen(next); writeOpen(next); }
      }}
      style={{
        borderRadius: 'var(--radius-md)', border: '1px solid var(--border-base)', background: 'var(--bg-card)',
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <summary ref={summaryRef} className="aqb-summary" tabIndex={-1} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
        <PulseDot pulse={critical} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{subtitle}</span>
        </span>
        <svg className="aqb-chevron" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </summary>
      <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
    </details>
  );
}
