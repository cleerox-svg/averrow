// Hosted DMARC report sensor — staff view on the brand detail page.
//
// Shows whether a brand's DMARC aggregate reports reach Averrow (setup state),
// the exact rua= value to publish, and the classified non-passing sending
// sources the reports reveal. Evidence only: a "spoofing candidate" is a lead
// for an analyst, never a confirmed attacker. Source of truth for the shapes:
// worker handlers/dmarcReports.ts (see hooks/useDmarcSensor.ts).

import { useEffect, useRef, useState } from 'react';
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
import { useWindowWidth } from '@/hooks/useWindowWidth';

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
    hint: "Fails DMARC and shows none of the evidence that the brand's own or shared-service mail leaves behind. A lead, not a finding.",
  },
  unaligned_shared_esp: {
    label: 'Shared mail service (unattributed)',
    severity: 'medium',
    hint: 'Fails DMARC from a shared mail service. It could be the brand using a vendor without alignment or someone abusing the same service; the data cannot tell which.',
  },
  forwarder_likely: {
    label: 'Likely forwarded or own mail',
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

const ASN_DROP_HINT =
  "the source's network is on Spamhaus's list of networks that should not be routed. Source: The Spamhaus Project.";

const EMPTY_COPY: Record<DmarcSetupState, string> = {
  no_dmarc: 'No reports can arrive until the domain publishes a DMARC record with the rua= value above.',
  rua_missing: "No reports can arrive until the rua= value above is added to the domain's DMARC record.",
  awaiting_reports:
    'The rua= record is in place. Sources appear once a mail provider sends its first daily report; each report is processed as soon as it arrives.',
  receiving: 'Reports arrived but none showed a non-passing source in this window. Try the 30 day window.',
  stale: 'Reports arrived but none showed a non-passing source in this window. Try the 30 day window.',
};

/** States where the domain's DNS can deliver reports, so sources are worth fetching. */
const FETCH_STATES: ReadonlySet<DmarcSetupState> = new Set(['awaiting_reports', 'receiving', 'stale']);

function fmtDate(ts: string): string {
  const d = parseUtc(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function seenRange(s: DmarcSpoofSource): string {
  return s.first_seen === s.last_seen ? fmtDate(s.first_seen) : `${fmtDate(s.first_seen)} to ${fmtDate(s.last_seen)}`;
}

function formatTs(ts: string | null): string | null {
  if (!ts) return null;
  const d = parseUtc(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const ago = timeAgo(ts);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC${ago ? ` (${ago})` : ''}`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = () => {
    const done = (st: 'copied' | 'failed') => {
      setState(st);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2000);
    };
    try {
      navigator.clipboard.writeText(value).then(() => done('copied')).catch(() => done('failed'));
    } catch {
      done('failed');
    }
  };
  return (
    <>
      <Button size="sm" variant="secondary" onClick={copy} aria-label={label}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
      </Button>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Copy failed. Select and copy the value manually.' : ''}
      </span>
    </>
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
// failing segment on top. The bars are decorative; the figures are in an
// sr-only table.
function DailySeries({ daily }: { daily: DmarcDailyPoint[] }) {
  if (daily.length === 0) return null;
  const max = Math.max(1, ...daily.map((d) => d.total));
  const passed = daily.reduce((n, d) => n + d.passed, 0);
  const failed = daily.reduce((n, d) => n + d.failed, 0);
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
      <div aria-hidden className="flex items-end gap-[3px] h-14">
        {daily.map((d) => {
          if (d.total <= 0) return <div key={d.date} className="flex-1 min-w-[3px] max-w-[48px]" />;
          const h = Math.max(4, Math.round((d.total / max) * 100));
          return (
            <div
              key={d.date}
              title={`${d.date}: ${d.passed.toLocaleString()} passed, ${d.failed.toLocaleString()} failed`}
              className="flex-1 min-w-[3px] max-w-[48px] flex flex-col justify-end gap-px"
              style={{ height: `${h}%` }}
            >
              {d.failed > 0 && (
                <div className="rounded-t-sm bg-[var(--sev-critical)]" style={{ flex: `${d.failed} 1 0`, minHeight: 2 }} />
              )}
              {d.passed > 0 && <div className="rounded-sm bg-[var(--green)]" style={{ flex: `${d.passed} 1 0` }} />}
            </div>
          );
        })}
      </div>
      <table className="sr-only">
        <caption>Daily DMARC results</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Messages</th><th scope="col">Passed</th><th scope="col">Failed</th></tr></thead>
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}><td>{d.date}</td><td>{d.total}</td><td>{d.passed}</td><td>{d.failed}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Sources ───────────────────────────────────────────────────────────────
type VerifyMode = 'all_unverified' | 'mixed' | 'none';

function SourceBadges({ s, mode }: { s: DmarcSpoofSource; mode: VerifyMode }) {
  const cls = CLASS_COPY[s.source_class];
  return (
    <>
      <Badge severity={cls.severity} size="xs" font="sans">{cls.label}</Badge>
      {mode === 'mixed' && !s.unverified_only && (
        <span className="ml-1.5"><Badge status="healthy" size="xs" font="sans">Verified</Badge></span>
      )}
    </>
  );
}

function ProviderLink({ s }: { s: DmarcSpoofSource }) {
  if (!s.provider) return <>—</>;
  return (
    <Link
      to={`/explore?tab=providers&focus=${encodeURIComponent(s.provider.id)}`}
      className="hover:underline [color:var(--primary-as-text)]"
    >
      {s.provider.name ?? s.provider.id}
    </Link>
  );
}

function SourceRow({ s, mode }: { s: DmarcSpoofSource; mode: VerifyMode }) {
  return (
    <tr title={s.cluster_id ? `Cluster ${s.cluster_id}` : undefined}>
      <Td className="font-mono text-xs whitespace-nowrap">{s.source_ip}</Td>
      <Td><SourceBadges s={s} mode={mode} /></Td>
      <Td className="font-mono text-xs text-right whitespace-nowrap">
        {s.fail_messages.toLocaleString()} <span className="text-[var(--text-muted)]">/ {s.messages.toLocaleString()}</span>
      </Td>
      <Td className="text-xs">
        <div className="font-mono">{s.asn ?? '—'}</div>
        {s.as_org && <div className="text-[var(--text-secondary)] max-w-[200px] truncate" title={s.as_org}>{s.as_org}</div>}
        {s.asn_drop_listed && <div className="mt-1"><Badge severity="high" size="xs">ASN-DROP</Badge></div>}
      </Td>
      <Td className="font-mono text-xs">{s.country_code ?? '—'}</Td>
      <Td className="text-xs"><ProviderLink s={s} /></Td>
      <Td className="font-mono text-[11px] text-[var(--text-secondary)] whitespace-nowrap">{seenRange(s)}</Td>
    </tr>
  );
}

function SourceCard({ s, mode }: { s: DmarcSpoofSource; mode: VerifyMode }) {
  return (
    <li className="py-2.5 border-b border-[var(--border-base)] space-y-1" title={s.cluster_id ? `Cluster ${s.cluster_id}` : undefined}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs break-all">{s.source_ip}</span>
        <span className="font-mono text-xs whitespace-nowrap">
          {s.fail_messages.toLocaleString()} <span className="text-[var(--text-muted)]">/ {s.messages.toLocaleString()} failing</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1"><SourceBadges s={s} mode={mode} /></div>
      <div className="text-xs text-[var(--text-secondary)]">
        <span className="font-mono">{s.asn ?? '—'}</span>
        {s.as_org ? ` ${s.as_org}` : ''}
        {s.country_code ? ` · ${s.country_code}` : ''}
        {s.asn_drop_listed && <span className="ml-1.5"><Badge severity="high" size="xs">ASN-DROP</Badge></span>}
      </div>
      {s.provider && <div className="text-xs"><ProviderLink s={s} /></div>}
      <div className="font-mono text-[11px] text-[var(--text-muted)]">{seenRange(s)}</div>
    </li>
  );
}

function SourcesLegend({ sources }: { sources: DmarcSpoofSource[] }) {
  const present = CLASS_ORDER.filter((c) => sources.some((s) => s.source_class === c));
  const anyDrop = sources.some((s) => s.asn_drop_listed);
  return (
    <ul className="space-y-1 text-[11px] text-[var(--text-muted)]">
      {present.map((c) => (
        <li key={c}><span className="text-[var(--text-secondary)]">{CLASS_COPY[c].label}:</span> {CLASS_COPY[c].hint}</li>
      ))}
      {anyDrop && <li><span className="text-[var(--text-secondary)]">ASN-DROP:</span> {ASN_DROP_HINT}</li>}
    </ul>
  );
}

function SourcesTable({ sources, mode }: { sources: DmarcSpoofSource[]; mode: VerifyMode }) {
  const narrow = useWindowWidth() < 640;
  const sorted = [...sources].sort(
    (a, b) => CLASS_ORDER.indexOf(a.source_class) - CLASS_ORDER.indexOf(b.source_class) || b.fail_messages - a.fail_messages,
  );
  return (
    <div className="space-y-3">
      {narrow ? (
        <ul aria-label="DMARC sending sources">
          {sorted.map((s) => <SourceCard key={s.source_ip} s={s} mode={mode} />)}
        </ul>
      ) : (
        <Table label="DMARC sending sources" wrapperClassName="-mx-1">
          <thead>
            <tr>
              <Th>IP</Th>
              <Th>Class</Th>
              <Th className="text-right whitespace-nowrap">Failing / total</Th>
              <Th>ASN</Th>
              <Th>Country</Th>
              <Th>Provider</Th>
              <Th className="whitespace-nowrap">Seen</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => <SourceRow key={s.source_ip} s={s} mode={mode} />)}
          </tbody>
        </Table>
      )}
      <SourcesLegend sources={sources} />
    </div>
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
            <dt className="text-[var(--text-tertiary)]">{setup.enrolled ? 'rua= verified' : 'rua= last verified'}</dt>
            <dd className="text-[var(--text-primary)]">
              {verifiedAt}{setup.verified_via ? ` via ${setup.verified_via === 'scan' ? 'scan' : 'live DNS'}` : ''}
              {!setup.enrolled && (
                <span className="block text-[var(--text-muted)]">
                  Verification lapsed (older than {setup.reverify_after_days} days); it is re-checked when the next report arrives.
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>

      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] mb-1">
          rua= value to publish on {setup.domain}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Mono>{setup.rua_value}</Mono>
          <CopyButton value={setup.rua_value} label="Copy rua value" />
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          Goes in the domain's existing <span className="font-mono">_dmarc</span> TXT record; add it to the rua= list if there already is one.
        </p>
      </div>

      {setup.authorization_required && setup.authorization_record_ok === false && (
        <div
          className="rounded-lg border p-3 text-xs"
          style={{ background: 'var(--sev-medium-bg)', borderColor: 'var(--sev-medium-border)', color: 'var(--text-primary)' }}
        >
          <div className="font-semibold [color:var(--sev-medium-text)]">Authorisation DNS record missing</div>
          <p className="mt-1 text-[var(--text-secondary)]">
            Mail providers may not send this domain's reports to Averrow until an authorisation record exists (RFC 7489 §7.1).
            The check found no <span className="font-mono">v=DMARC1</span> TXT answer for the per-domain name below. A single
            platform wildcard, <span className="font-mono">*._report._dmarc.averrow.ca</span>, would cover every customer; either
            the wildcard or the per-domain record fixes this. It is an Averrow DNS step, not something the customer publishes.
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
      {setup.authorization_required && setup.authorization_record_ok === null && (
        <p className="text-xs text-[var(--text-muted)]">Could not check the authorisation record just now.</p>
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────
export function DmarcSensorCard({ brandId }: { brandId: string }) {
  const [days, setDays] = useState<DmarcSpoofDays>(7);
  const setupQ = useDmarcSetup(brandId);
  const setup = setupQ.data;
  const fetchSources = !!setup && setup.eligible && FETCH_STATES.has(setup.state);
  const sourcesQ = useDmarcSpoofSources(brandId, days, { enabled: fetchSources });
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
            fetching={fetchSources}
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
    <Card id={DMARC_SENSOR_ANCHOR_ID} className="scroll-mt-16">
      <SectionLabel>DMARC report sensor</SectionLabel>
      <div className="mt-3">{body}</div>
    </Card>
  );
}

function SourcesSection({
  fetching, days, onDays, state, loading, error, onRetry, data,
}: {
  fetching: boolean;
  days: DmarcSpoofDays;
  onDays: (d: DmarcSpoofDays) => void;
  state: DmarcSetupState;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  data: ReturnType<typeof useDmarcSpoofSources>['data'];
}) {
  const hasSources = !!data && data.sources.length > 0;
  const unverified = hasSources ? data.sources.filter((s) => s.unverified_only).length : 0;
  const total = hasSources ? data.sources.length : 0;
  const mode: VerifyMode = unverified === 0 ? 'none' : unverified === total ? 'all_unverified' : 'mixed';
  // Label from what was loaded, not what was asked for (the toggle may be mid-fetch).
  const windowDays = data?.days ?? days;

  return (
    <div className="space-y-3 border-t border-[var(--border-base)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">Non-passing sending sources</div>
        {fetching && (
          <div role="group" aria-label="Window" className="inline-flex rounded-md border border-[var(--border-base)] overflow-hidden">
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days === d}
                aria-label={`Last ${d} days`}
                onClick={() => onDays(d)}
                className={`px-3 py-1 font-mono text-[11px] transition-colors ${
                  days === d ? 'bg-[var(--primary-tint)] [color:var(--primary-text)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        )}
      </div>

      {!fetching && (
        <PageState kind="empty" layout="card" compact title="No sending sources yet" description={EMPTY_COPY[state]} />
      )}

      {fetching && loading && <PageState kind="loading" layout="inline" title="Loading sources…" />}

      {fetching && !loading && error && (
        <PageState
          kind="error"
          layout="card"
          compact
          title="Couldn't load sending sources"
          description="The classified sources for this brand could not be loaded."
          onRetry={onRetry}
        />
      )}

      {fetching && !loading && !error && data && (
        <>
          <DailySeries daily={data.daily} />

          {!hasSources ? (
            <PageState
              kind="empty"
              layout="card"
              compact
              title={`No sending sources in the last ${windowDays} days`}
              description={EMPTY_COPY[state]}
            />
          ) : (
            <>
              <p className="text-[11px] text-[var(--text-muted)]">
                {data.summary.sources.toLocaleString()} source{data.summary.sources === 1 ? '' : 's'},{' '}
                {data.summary.spoof_candidate_sources.toLocaleString()} spoofing candidate{data.summary.spoof_candidate_sources === 1 ? '' : 's'},{' '}
                {data.summary.fail_messages.toLocaleString()} failing messages in the last {windowDays} days. Classes are leads for an analyst, not confirmed findings.
                {data.summary.truncated && ' Showing the top 200 by failing messages.'}
              </p>
              {mode !== 'none' && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                  {mode === 'all_unverified'
                    ? 'None of the reports behind these sources came from a verified reporter. Report-sender verification is not enabled yet, so this evidence could be forged by anyone who can email the reporting address.'
                    : `${unverified} of ${total} sources are unverified: none of the reports behind them came from a verified reporter, so that evidence could be forged. Sources marked Verified have verified reports behind them.`}
                </p>
              )}
              <SourcesTable sources={data.sources} mode={mode} />
            </>
          )}
        </>
      )}
    </div>
  );
}
