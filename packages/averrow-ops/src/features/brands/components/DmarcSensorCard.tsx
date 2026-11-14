// Hosted DMARC report sensor — staff view on the brand detail page.
//
// Shows whether a brand's DMARC aggregate reports reach Averrow (setup state),
// the exact rua= value to publish, and the classified non-passing sending
// sources the reports reveal. Evidence only: a "spoofing candidate" is a lead
// for an analyst, never a confirmed attacker. Source of truth for the shapes:
// worker handlers/dmarcReports.ts (see hooks/useDmarcSensor.ts).

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, PageState, Table, Th, Td } from '@/design-system/components';
import { SectionLabel } from '@/components/ui/SectionLabel';
import {
  useDmarcSetup,
  useDmarcSpoofSources,
  type DmarcDailyPoint,
  type DmarcSetup,
  type DmarcSetupState,
  type DmarcSourceClass,
  type DmarcSpoofDays,
  type DmarcSpoofSource,
} from '@/hooks/useDmarcSensor';
import { parseUtc, timeAgo } from '@/lib/time';

export const DMARC_SENSOR_ANCHOR_ID = 'dmarc-sensor';

type BadgeStatus = 'active' | 'inactive' | 'pending' | 'degraded' | 'failed' | 'healthy' | 'warning';

const STATE_COPY: Record<DmarcSetupState, { label: string; status: BadgeStatus; explain: string }> = {
  no_dmarc: {
    label: 'No DMARC record',
    status: 'failed',
    explain:
      'The domain publishes no DMARC record, so mail providers have nowhere to read a reporting address from. A DMARC record has to exist before the rua= tag below can be added to it.',
  },
  rua_missing: {
    label: 'Reporting not pointed here',
    status: 'warning',
    explain:
      "The domain has a DMARC record, but its rua= tag does not include Averrow's address, so providers send their aggregate reports elsewhere. Add the value below to the existing rua= list.",
  },
  awaiting_reports: {
    label: 'Awaiting first report',
    status: 'pending',
    explain:
      "The DMARC record already names Averrow in rua=. No report has arrived yet. Providers send aggregate reports about once a day, so the first one can take a day or two after the record changes.",
  },
  receiving: {
    label: 'Receiving reports',
    status: 'healthy',
    explain: 'At least one aggregate report arrived in the last 7 days. The sources below come from those reports.',
  },
  stale: {
    label: 'Reports stopped',
    status: 'degraded',
    explain:
      'Reports used to arrive but none has in the last 7 days. The rua= tag may have been removed or changed, or the domain is sending very little mail.',
  },
};

const CLASS_COPY: Record<DmarcSourceClass, { label: string; severity: 'high' | 'medium' | 'low' | 'info'; hint: string }> = {
  spoof_candidate: {
    label: 'Spoofing candidate',
    severity: 'high',
    hint: 'Fails DMARC, is not a known sender for the brand and is not a shared mail service. A lead for an analyst, not a confirmed finding.',
  },
  unaligned_shared_esp: {
    label: 'Shared mail service (unattributed)',
    severity: 'medium',
    hint: 'Fails DMARC from a shared mail service. It could be the brand using a vendor without alignment or someone abusing the same service; the data cannot tell which.',
  },
  forwarder_likely: {
    label: "Brand's own mail (forwarded / alignment)",
    severity: 'low',
    hint: "Looks like the brand's own mail failing because of forwarding or alignment settings, not an outside sender.",
  },
  aligned_pass: {
    label: 'Aligned pass',
    severity: 'info',
    hint: 'Passes DMARC alignment.',
  },
};

const CLASS_ORDER: DmarcSourceClass[] = ['spoof_candidate', 'unaligned_shared_esp', 'forwarder_likely', 'aligned_pass'];

const UNVERIFIED_HINT =
  'Unverified evidence: report-sender verification is not enabled yet, so every report is currently unverified and could be forged by anyone who can email the reporting address.';

function formatTs(ts: string | null): string | null {
  if (!ts) return null;
  const d = parseUtc(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const ago = timeAgo(ts);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC${ago ? ` (${ago})` : ''}`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    const done = (s: 'copied' | 'failed') => {
      setState(s);
      setTimeout(() => setState('idle'), 2000);
    };
    try {
      navigator.clipboard.writeText(value).then(() => done('copied')).catch(() => done('failed'));
    } catch {
      done('failed');
    }
  };
  return (
    <Button size="sm" variant="secondary" onClick={copy} aria-label={label}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </Button>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-xs break-all rounded px-1.5 py-0.5 bg-[var(--border-base)] text-[var(--text-primary)]">
      {children}
    </code>
  );
}

// ── Daily pass/fail series ────────────────────────────────────────────────
// Stacked bars (CSS only): height = that day's share of the busiest day,
// failing portion on top in the critical colour.
function DailySeries({ daily }: { daily: DmarcDailyPoint[] }) {
  if (daily.length === 0) return null;
  const max = Math.max(1, ...daily.map((d) => d.total));
  const passed = daily.reduce((n, d) => n + d.passed, 0);
  const failed = daily.reduce((n, d) => n + d.failed, 0);
  const summary = `Daily DMARC results over ${daily.length} day${daily.length === 1 ? '' : 's'}: ${passed.toLocaleString()} passed, ${failed.toLocaleString()} failed`;
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">Daily pass / fail</span>
        <span className="flex items-center gap-3 font-mono text-[10px] text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block h-2 w-2 rounded-sm bg-[var(--green)]" />
            {passed.toLocaleString()} pass
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block h-2 w-2 rounded-sm bg-[var(--sev-critical)]" />
            {failed.toLocaleString()} fail
          </span>
        </span>
      </div>
      <div role="img" aria-label={summary} className="flex items-end gap-[3px] h-14">
        {daily.map((d) => {
          const h = Math.max(4, Math.round((d.total / max) * 100));
          const failPct = d.total > 0 ? (d.failed / d.total) * 100 : 0;
          return (
            <div
              key={d.date}
              title={`${d.date}: ${d.passed.toLocaleString()} passed, ${d.failed.toLocaleString()} failed`}
              className="flex-1 min-w-[3px] max-w-[24px] flex flex-col justify-end overflow-hidden rounded-sm bg-[var(--green)]"
              style={{ height: `${h}%` }}
            >
              <div className="bg-[var(--sev-critical)]" style={{ height: `${failPct}%` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sources table ─────────────────────────────────────────────────────────
function AsnDropBadge() {
  return (
    <span title="Listed on the Spamhaus ASN-DROP list (networks Spamhaus advises not to route). Source: The Spamhaus Project.">
      <Badge severity="high" size="xs">ASN-DROP</Badge>
    </span>
  );
}

function SourceRow({ s }: { s: DmarcSpoofSource }) {
  const cls = CLASS_COPY[s.source_class];
  return (
    <tr>
      <Td className="font-mono text-xs whitespace-nowrap">{s.source_ip}</Td>
      <Td>
        <span title={cls.hint}>
          <Badge severity={cls.severity} size="xs" font="sans">{cls.label}</Badge>
        </span>
        {s.unverified_only && (
          <span className="ml-1.5" title={UNVERIFIED_HINT}>
            <Badge status="inactive" size="xs" font="sans">Unverified only</Badge>
          </span>
        )}
      </Td>
      <Td className="font-mono text-xs text-right whitespace-nowrap">
        {s.fail_messages.toLocaleString()} <span className="text-[var(--text-muted)]">/ {s.messages.toLocaleString()}</span>
      </Td>
      <Td className="text-xs">
        <div className="font-mono">{s.asn ?? '—'}</div>
        {s.as_org && <div className="text-[var(--text-secondary)] max-w-[200px] truncate" title={s.as_org}>{s.as_org}</div>}
        {s.asn_drop_listed && <div className="mt-1"><AsnDropBadge /></div>}
      </Td>
      <Td className="font-mono text-xs">{s.country_code ?? '—'}</Td>
      <Td className="text-xs">
        {s.provider ? (
          <Link
            to={`/explore?tab=providers&focus=${encodeURIComponent(s.provider.id)}`}
            className="hover:underline [color:var(--primary-as-text)]"
          >
            {s.provider.name ?? s.provider.id}
          </Link>
        ) : '—'}
      </Td>
      <Td className="font-mono text-[11px] text-[var(--text-secondary)]">
        {/* Ops has no operation/cluster detail route yet, so the id is shown as text. */}
        {s.cluster_id ? <span title={s.cluster_id}>{s.cluster_id.length > 14 ? `${s.cluster_id.slice(0, 14)}…` : s.cluster_id}</span> : '—'}
      </Td>
      <Td className="font-mono text-[11px] text-[var(--text-secondary)] whitespace-nowrap">
        {s.first_seen === s.last_seen ? s.first_seen : `${s.first_seen} → ${s.last_seen}`}
      </Td>
    </tr>
  );
}

function SourcesTable({ sources }: { sources: DmarcSpoofSource[] }) {
  const sorted = [...sources].sort(
    (a, b) => CLASS_ORDER.indexOf(a.source_class) - CLASS_ORDER.indexOf(b.source_class) || b.fail_messages - a.fail_messages,
  );
  return (
    <Table label="DMARC sending sources" wrapperClassName="-mx-1">
      <thead>
        <tr>
          <Th>IP</Th>
          <Th>Class</Th>
          <Th className="text-right">Failing / total</Th>
          <Th>ASN</Th>
          <Th>Country</Th>
          <Th>Provider</Th>
          <Th>Cluster</Th>
          <Th>Seen</Th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => <SourceRow key={s.source_ip} s={s} />)}
      </tbody>
    </Table>
  );
}

// ── Setup block ───────────────────────────────────────────────────────────
function SetupBlock({ setup }: { setup: DmarcSetup }) {
  if (!setup.eligible) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge status="inactive" font="sans">Cannot enrol</Badge>
        </div>
        <p className="text-xs text-[var(--text-secondary)]">
          This brand is not eligible for the DMARC sensor. Reports are only stored for brands that are monitored or customer tier,
          whose domain is the brand's own trusted domain (not a catalogue or shared-hosting domain). For any other brand, reports
          sent to Averrow are discarded whatever its DNS says, so there is nothing to set up here.
        </p>
      </div>
    );
  }

  const copy = STATE_COPY[setup.state];
  const lastReport = formatTs(setup.last_report_at);
  const verifiedAt = formatTs(setup.verified_at);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge status={copy.status} font="sans">{copy.label}</Badge>
        {setup.enrolled && <Badge status="active" size="xs" font="sans">Enrolled</Badge>}
      </div>
      <p className="text-xs text-[var(--text-secondary)]">{copy.explain}</p>

      {setup.rua_checked_via === 'live_dns_failed' && (
        <p className="text-xs [color:var(--sev-medium-text)]">
          The live DNS lookup for this domain failed, so the state above may be understated. It will correct itself on the next check.
        </p>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px]">
        <div className="flex gap-2"><dt className="text-[var(--text-tertiary)]">Last report</dt><dd className="text-[var(--text-primary)]">{lastReport ?? 'none yet'}</dd></div>
        {verifiedAt && (
          <div className="flex gap-2">
            <dt className="text-[var(--text-tertiary)]">rua= verified</dt>
            <dd className="text-[var(--text-primary)]">{verifiedAt}{setup.verified_via ? ` via ${setup.verified_via === 'scan' ? 'scan' : 'live DNS'}` : ''}</dd>
          </div>
        )}
      </dl>

      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] mb-1">
          rua= value to publish on {setup.domain}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Mono>rua={setup.rua_value}</Mono>
          <CopyButton value={`rua=${setup.rua_value}`} label="Copy rua value" />
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          Goes in the domain's existing <span className="font-mono">_dmarc</span> TXT record; add it to the rua= list if there already is one.
        </p>
      </div>

      {!setup.authorization_record_ok && (
        <div
          role="alert"
          className="rounded-lg border p-3 text-xs"
          style={{ background: 'var(--sev-medium-bg)', borderColor: 'var(--sev-medium-border)', color: 'var(--text-primary)' }}
        >
          <div className="font-semibold [color:var(--sev-medium-text)]">Authorisation DNS record missing</div>
          <p className="mt-1 text-[var(--text-secondary)]">
            Mail providers will not send this domain's reports to Averrow until the platform-side authorisation record exists
            (RFC 7489 §7.1). This is an Averrow DNS step, not something the customer publishes.
          </p>
          {setup.authorization_record_name && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[var(--text-tertiary)]">TXT</span>
              <Mono>{setup.authorization_record_name}</Mono>
              <span className="text-[var(--text-tertiary)]">=</span>
              <Mono>{setup.authorization_record_value}</Mono>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────
export function DmarcSensorCard({ brandId }: { brandId: string }) {
  const [days, setDays] = useState<DmarcSpoofDays>(7);
  const setupQ = useDmarcSetup(brandId);
  const setup = setupQ.data;
  const sourcesQ = useDmarcSpoofSources(brandId, days, { enabled: !!setup?.eligible });
  const sources = sourcesQ.data;

  let body: React.ReactNode;
  if (setupQ.isLoading) {
    body = <PageState kind="loading" layout="inline" title="Loading DMARC sensor…" />;
  } else if (setupQ.isError || !setup) {
    body = (
      <PageState
        kind="error"
        layout="card"
        compact
        title="Couldn't load the DMARC sensor"
        description="The setup state for this brand could not be loaded."
        onRetry={() => { void setupQ.refetch(); }}
      />
    );
  } else {
    body = (
      <div className="space-y-5">
        <SetupBlock setup={setup} />
        {setup.eligible && (
          <SourcesSection
            days={days}
            onDays={setDays}
            state={setup.state}
            loading={sourcesQ.isLoading}
            error={sourcesQ.isError}
            onRetry={() => { void sourcesQ.refetch(); }}
            data={sources}
          />
        )}
      </div>
    );
  }

  return (
    <Card id={DMARC_SENSOR_ANCHOR_ID} className="scroll-mt-24">
      <SectionLabel>DMARC report sensor</SectionLabel>
      <div className="mt-3">{body}</div>
    </Card>
  );
}

function SourcesSection({
  days, onDays, state, loading, error, onRetry, data,
}: {
  days: DmarcSpoofDays;
  onDays: (d: DmarcSpoofDays) => void;
  state: DmarcSetupState;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  data: ReturnType<typeof useDmarcSpoofSources>['data'];
}) {
  const hasSources = !!data && data.sources.length > 0;
  const allUnverified = hasSources && data.summary.unverified_only_sources === data.summary.sources;

  return (
    <div className="space-y-3 border-t border-[var(--border-base)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">Non-passing sending sources</div>
        <div role="group" aria-label="Window" className="inline-flex rounded-md border border-[var(--border-base)] overflow-hidden">
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => onDays(d)}
              className={`px-3 py-1 font-mono text-[11px] transition-colors ${
                days === d ? 'bg-[var(--primary-tint)] [color:var(--primary-text)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {loading && <PageState kind="loading" layout="inline" title="Loading sources…" />}

      {!loading && error && (
        <PageState
          kind="error"
          layout="card"
          compact
          title="Couldn't load sending sources"
          description="The classified sources for this brand could not be loaded."
          onRetry={onRetry}
        />
      )}

      {!loading && !error && data && (
        <>
          <DailySeries daily={data.daily} />

          {!hasSources ? (
            <PageState
              kind="empty"
              layout="card"
              compact
              title={`No sending sources in the last ${days} days`}
              description={
                state === 'receiving' || state === 'stale'
                  ? 'Reports arrived but none showed a non-passing source in this window. Try the 30 day window.'
                  : 'This is normal until reports arrive. Sources appear after (1) the domain publishes a DMARC record with the rua= value above, (2) mail providers send their daily aggregate reports, and (3) the nightly rollup processes them. Nothing is wrong yet.'
              }
            />
          ) : (
            <>
              <p className="text-[11px] text-[var(--text-muted)]">
                {data.summary.sources.toLocaleString()} source{data.summary.sources === 1 ? '' : 's'},{' '}
                {data.summary.spoof_candidate_sources.toLocaleString()} spoofing candidate{data.summary.spoof_candidate_sources === 1 ? '' : 's'},{' '}
                {data.summary.fail_messages.toLocaleString()} failing messages. Classes are leads for an analyst, not confirmed findings.
                {data.summary.truncated && ' Showing the top 200 by failing messages.'}
              </p>
              {allUnverified && (
                <p className="text-[11px] text-[var(--text-secondary)]">{UNVERIFIED_HINT}</p>
              )}
              <SourcesTable sources={data.sources} />
            </>
          )}
        </>
      )}
    </div>
  );
}
