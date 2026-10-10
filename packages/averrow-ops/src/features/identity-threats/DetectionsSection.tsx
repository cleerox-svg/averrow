import { forwardRef, useId, useState, type ReactNode } from 'react';
import { CopyField } from '@averrow/shared/ui';
import { Badge, Button, Card, PageState, pageStateKind } from '@/design-system/components';
import { formatDateTime, relativeTime } from '@/lib/time';
import { useIdentityDetection, useIdentityDetections } from './useIdentityThreats';
import type {
  IdentityDetectionDetail, IdentityDetectionListItem, IdentityFilters, IdentityWindow,
} from './types';

const LABEL_CLS = 'font-mono text-[11px] font-bold uppercase tracking-[0.14em]';
const DASH = '—';

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function statusBadge(status: string): ReactNode {
  const s = status.toLowerCase();
  if (s === 'active') return <Badge status="active" pulse>Live</Badge>;
  if (s === 'taken_down' || s === 'down' || s === 'resolved' || s === 'remediated') {
    return <Badge status="success">Taken down</Badge>;
  }
  return <Badge status="pending">{titleCase(status)}</Badge>;
}

// ── Detail panel ───────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 py-1 text-[13px] sm:grid-cols-[140px_1fr]">
      <dt style={{ color: 'var(--text-secondary)' }}>{label}</dt>
      <dd className="m-0 min-w-0 break-words font-mono" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
        {children}
      </dd>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <h4 className={`${LABEL_CLS} mb-1`} style={{ color: 'var(--text-secondary)', margin: 0 }}>{title}</h4>
      <dl className="m-0">{children}</dl>
    </div>
  );
}

function val(v: string | number | null | undefined): ReactNode {
  return v === null || v === undefined || v === '' ? DASH : String(v);
}

function ts(v: string | null): ReactNode {
  if (!v) return DASH;
  return <span title={formatDateTime(v)}>{relativeTime(v)} <span style={{ color: 'var(--text-secondary)' }}>({formatDateTime(v)})</span></span>;
}

function yesNo(v: boolean | null): string {
  return v === null ? DASH : v ? 'Listed' : 'Not listed';
}

function DetailBody({ d }: { d: IdentityDetectionDetail }) {
  const r = d.reputation;
  return (
    <div>
      <div className="mb-3">
        <h4 className={`${LABEL_CLS} mb-1`} style={{ color: 'var(--text-secondary)', margin: 0 }}>Tactics, techniques and procedures</h4>
        <p className="text-[13px] my-1" style={{ color: 'var(--text-primary)' }}>
          {d.vector_label}
          {d.matched_lure && <> · Matched: <span className="font-mono">{d.matched_lure}</span></>}
        </p>
        {d.ttps.length === 0 ? (
          <p className="text-[13px] m-0" style={{ color: 'var(--text-secondary)' }}>No mapped techniques.</p>
        ) : (
          <ul className="flex flex-wrap gap-2 list-none p-0 m-0">
            {d.ttps.map((t) => (
              <li key={t.id}>
                <a
                  href={t.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[44px] flex-col justify-center rounded-lg px-3 py-1 no-underline hover:underline"
                  style={{ border: '1px solid var(--border-base)', background: 'var(--bg-card)', color: 'var(--amber-text)' }}
                >
                  <span className="font-mono text-[13px] font-bold">
                    {t.id} · {t.name}<span className="sr-only"> (opens in new tab)</span>
                  </span>
                  <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{t.tactic}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Group title="Target">
        <Field label="Brand">{val(d.brand_name)}</Field>
        <Field label="Identity provider">{val(d.idp_label)}</Field>
      </Group>
      <Group title="Infrastructure">
        <Field label="IP address">{val(d.infrastructure.ip_address)}</Field>
        <Field label="Country">{val(d.infrastructure.country_code)}</Field>
        <Field label="ASN">{val(d.infrastructure.asn)}</Field>
        <Field label="Hosting provider">{val(d.infrastructure.hosting_provider?.name)}</Field>
        <Field label="Cert issuer">{val(d.infrastructure.ssl_cert_issuer)}</Field>
      </Group>
      <Group title="Registration">
        <Field label="Domain created">{ts(d.registration.domain_created_at)}</Field>
        <Field label="Domain age">{d.registration.domain_age_days === null ? DASH : `${d.registration.domain_age_days} days`}</Field>
        <Field label="Weaponization">
          {d.registration.weaponization_hours === null ? DASH : `${d.registration.weaponization_hours} h`}
          {d.registration.weaponization_flag ? ` · ${titleCase(d.registration.weaponization_flag)}` : ''}
        </Field>
      </Group>
      <Group title="Reputation">
        <Field label="VirusTotal">{r.vt_checked ? `${r.vt_malicious ?? 0} malicious` : 'Not checked'}</Field>
        <Field label="Safe Browsing">
          {r.gsb_checked ? (r.gsb_flagged ? `Flagged${r.gsb_threat_type ? ` · ${r.gsb_threat_type}` : ''}` : 'Not flagged') : 'Not checked'}
        </Field>
        <Field label="GreyNoise">{r.greynoise_checked ? val(r.greynoise_classification) : 'Not checked'}</Field>
        <Field label="SecLookup">{r.seclookup_checked ? val(r.seclookup_risk_score) : 'Not checked'}</Field>
        <Field label="SURBL">{yesNo(r.surbl_listed)}</Field>
        <Field label="Spamhaus DBL">{yesNo(r.dbl_listed)}</Field>
      </Group>
      <Group title="Timeline">
        <Field label="First seen">{ts(d.timeline.first_seen)}</Field>
        <Field label="Last seen">{ts(d.timeline.last_seen)}</Field>
        <Field label="Detected">{ts(d.timeline.created_at)}</Field>
        <Field label="Enriched">{ts(d.timeline.enriched_at)}</Field>
      </Group>
      <Group title="Response">
        <Field label="Takedown">
          {d.takedown ? <>{titleCase(d.takedown.status)}{d.takedown.updated_at ? <> · {ts(d.takedown.updated_at)}</> : null}</> : 'No takedown'}
        </Field>
        <Field label="Cluster">{d.cluster ? (d.cluster.name ?? d.cluster.id) : DASH}</Field>
        <Field label="Source feed">{val(d.source_feed)}</Field>
        <Field label="Technique">{val(d.technique)}</Field>
      </Group>
      <div>
        <h4 className={`${LABEL_CLS} mb-1`} style={{ color: 'var(--text-secondary)', margin: 0 }}>Full URL</h4>
        {d.url ? (
          <CopyField value={d.url} label="URL" />
        ) : (
          <p className="m-0 text-[13px]" style={{ color: 'var(--text-secondary)' }}>{DASH}</p>
        )}
      </div>
    </div>
  );
}

function DetailPanel({ id, open }: { id: string; open: boolean }) {
  const q = useIdentityDetection(id, open);
  const kind = pageStateKind({ isLoading: q.isLoading, isError: q.isError, isEmpty: false });
  if (kind) {
    return (
      <PageState
        kind={kind}
        layout="inline"
        title={kind === 'error' ? "Couldn't load detection" : undefined}
        onRetry={kind === 'error' ? () => { void q.refetch(); } : undefined}
      />
    );
  }
  return q.data ? <DetailBody d={q.data} /> : null;
}

// ── List ───────────────────────────────────────────────────────────────────

function DetectionItem({ item, open, onToggle }: { item: IdentityDetectionListItem; open: boolean; onToggle: () => void }) {
  const panelId = useId();
  return (
    <li style={{ borderBottom: '1px solid var(--border-base)' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full min-h-[56px] cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-1 border-0 bg-transparent px-2 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-sm" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{item.domain}</span>
          <span className="block text-xs" style={{ color: 'var(--text-secondary)' }}>
            {item.brand_name ?? 'Unattributed'} · {item.idp_label ?? 'Unknown provider'} · {item.vector_label}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {statusBadge(item.status)}
          <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }} title={formatDateTime(item.created_at)}>
            {relativeTime(item.created_at)}
          </span>
          <span aria-hidden="true" style={{ color: 'var(--text-secondary)' }}>{open ? '▾' : '▸'}</span>
        </span>
      </button>
      <div id={panelId} role="region" aria-label={`Details for ${item.domain}`} hidden={!open} className="px-3 pb-3">
        {open && <DetailPanel id={item.threat_id} open={open} />}
      </div>
    </li>
  );
}

export interface DetectionsSectionProps {
  window: IdentityWindow;
  filters: IdentityFilters;
  /** Human labels for the active filters, joined into the header ("12 detections · Okta"). */
  filterLabels: string[];
}

export const DetectionsSection = forwardRef<HTMLElement, DetectionsSectionProps>(function DetectionsSection(
  { window: win, filters, filterLabels }, ref,
) {
  const headingId = useId();
  const q = useIdentityDetections(win, filters);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[q.data.pages.length - 1]?.total ?? 0;
  const kind = pageStateKind({ isLoading: q.isLoading, isError: q.isError && items.length === 0, isEmpty: !!q.data && items.length === 0 });

  const toggle = (id: string) => setOpenIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const header = q.data
    ? `${total.toLocaleString('en-US')} ${total === 1 ? 'detection' : 'detections'}${filterLabels.length ? ` · ${filterLabels.join(' · ')}` : ''}`
    : 'Detections';

  return (
    <section ref={ref} aria-labelledby={headingId} className="mb-4">
      <h2
        id={headingId}
        tabIndex={-1}
        className={`${LABEL_CLS} mb-2 outline-none`}
        style={{ color: 'var(--text-secondary)' }}
      >
        Detections
      </h2>
      <p role="status" className="mb-2 mt-0 text-[13px]" style={{ color: 'var(--text-primary)' }}>{header}</p>
      <Card padding="sm">
        {kind ? (
          <PageState
            kind={kind}
            layout="inline"
            title={kind === 'error' ? "Couldn't load detections" : kind === 'empty' ? 'No detections match these filters' : undefined}
            onRetry={kind === 'error' ? () => { void q.refetch(); } : undefined}
          />
        ) : (
          <>
            <ul className="m-0 list-none p-0">
              {items.map((it) => (
                <DetectionItem key={it.threat_id} item={it} open={openIds.has(it.threat_id)} onToggle={() => toggle(it.threat_id)} />
              ))}
            </ul>
            {q.isError && <PageState kind="error" layout="inline" title="Couldn't load more detections" onRetry={() => { void q.fetchNextPage(); }} />}
            {q.hasNextPage && (
              <div className="flex justify-center p-2">
                <Button variant="secondary" onClick={() => { void q.fetchNextPage(); }} loading={q.isFetchingNextPage}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  );
});
