import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge, BreakdownCard, Card, DataRow, PageHeader, PageState, StatGrid, StatTile,
  Table, Td, Th, Tabs, Sparkline, pageStateKind,
} from '@/design-system/components';
import { relativeTime } from '@/lib/time';
import { useIdentityThreats } from './useIdentityThreats';
import type { IdentityThreatsData, IdentityWindow } from './types';

const WINDOW_TABS = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

const VECTOR_LABELS: Record<string, string> = {
  idp_tenant: 'Hosted on provider tenant',
  idp_lookalike: 'Lookalike sign-in page',
  device_code: 'Device-code phishing',
};

const LABEL_CLS = 'font-mono text-[10px] font-bold uppercase tracking-[0.18em]';

function mitreUrl(id: string): string {
  return `https://attack.mitre.org/techniques/${id.replace('.', '/')}/`;
}

function deltaText(cur: number, prev: number): string {
  const d = cur - prev;
  if (d === 0) return `no change vs previous`;
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')} vs previous`;
}

function statusBadge(status: string): ReactNode {
  const s = status.toLowerCase();
  if (s === 'active') return <Badge severity="high">Live</Badge>;
  if (s === 'taken_down' || s === 'down' || s === 'resolved' || s === 'remediated') {
    return <Badge status="success">Taken down</Badge>;
  }
  return <Badge status="pending">{status.replace(/_/g, ' ')}</Badge>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-4">
      <h2 className={`${LABEL_CLS} mb-2`} style={{ color: 'var(--text-secondary)', margin: '0 0 8px' }}>{title}</h2>
      {children}
    </section>
  );
}

function BrandLink({ id, name }: { id: string | null; name: string | null }) {
  if (!id || !name) return <span style={{ color: 'var(--text-tertiary)' }}>Unattributed</span>;
  return (
    <Link to={`/brands/${encodeURIComponent(id)}`} className="no-underline hover:underline" style={{ color: 'var(--amber-text)' }}>
      {name}
    </Link>
  );
}

function BreakdownRow({ label, count, sub }: { label: string; count: number; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
      <span style={{ color: 'var(--text-primary)' }}>{label}</span>
      <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
        {count.toLocaleString('en-US')}{sub ? ` · ${sub}` : ''}
      </span>
    </div>
  );
}

function Content({ data }: { data: IdentityThreatsData }) {
  const { kpis } = data;
  const vectorTotal = data.by_vector.reduce((n, v) => n + v.count, 0);
  const idpTotal = data.by_idp.reduce((n, v) => n + v.count, 0);
  const trend = data.trend.map((p) => p.count);

  return (
    <>
      <StatGrid cols={3}>
        <StatTile label="Detections" value={kpis.detections} sub={deltaText(kpis.detections, kpis.detections_prev)} tone="amber" />
        <StatTile label="Brands targeted" value={kpis.brands_targeted} />
        <StatTile label="Identity providers abused" value={kpis.idps_impersonated} />
        <StatTile label="Live" value={kpis.live} tone="red" />
        <StatTile label="Taken down" value={kpis.taken_down} tone="green" />
        <StatTile label="Lookalike domains flagged" value={kpis.lookalikes_flagged} />
      </StatGrid>

      <Section title="Daily detections">
        <Card padding="md">
          {trend.length >= 2 ? (
            <Sparkline data={trend} fill height={64} baseline="zero" label={`Daily detections, ${data.window}`} />
          ) : (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)', margin: 0 }}>Not enough days to chart yet.</p>
          )}
          <ul className="sr-only">
            {data.trend.map((p) => <li key={p.day}>{p.day}: {p.count}</li>)}
          </ul>
        </Card>
      </Section>

      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <BreakdownCard title="By technique" metric={vectorTotal.toLocaleString('en-US')} metricLabel="detections">
          {data.by_vector.map((v) => (
            <BreakdownRow key={v.vector} label={v.label || VECTOR_LABELS[v.vector] || v.vector} count={v.count} sub={deltaText(v.count, v.prev)} />
          ))}
        </BreakdownCard>
        <BreakdownCard title="By identity provider" metric={idpTotal.toLocaleString('en-US')} metricLabel="detections">
          {data.by_idp.map((i) => (
            <BreakdownRow key={i.idp} label={i.label} count={i.count} sub={`${i.brands} ${i.brands === 1 ? 'brand' : 'brands'}`} />
          ))}
        </BreakdownCard>
      </div>

      <Section title="Most targeted brands">
        <Card padding="sm">
          {data.top_brands.length === 0 ? (
            <p className="text-xs p-2" style={{ color: 'var(--text-tertiary)', margin: 0 }}>No brands targeted in this window.</p>
          ) : data.top_brands.map((b) => (
            <DataRow key={b.brand_id}>
              <div className="flex items-center justify-between gap-3 w-full min-w-0">
                <div className="min-w-0">
                  <BrandLink id={b.brand_id} name={b.brand_name} />
                  {b.idps.length > 0 && (
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{b.idps.join(', ')}</div>
                  )}
                </div>
                <span className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>{b.count.toLocaleString('en-US')}</span>
              </div>
            </DataRow>
          ))}
        </Card>
      </Section>

      <Section title="MITRE ATT&CK techniques">
        <Card padding="sm">
          <Table label="MITRE ATT&CK techniques">
            <thead>
              <tr><Th>ID</Th><Th>Technique</Th><Th>Tactic</Th><Th style={{ textAlign: 'right' }}>Count</Th></tr>
            </thead>
            <tbody>
              {data.mitre.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <a href={mitreUrl(m.id)} target="_blank" rel="noopener noreferrer" className="font-mono hover:underline" style={{ color: 'var(--amber-text)' }}>
                      {m.id}
                    </a>
                  </Td>
                  <Td>{m.name}</Td>
                  <Td>{m.tactic}</Td>
                  <Td style={{ textAlign: 'right' }}>{m.count.toLocaleString('en-US')}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </Section>

      <Section title="Latest detections">
        <Card padding="sm">
          {data.recent.length === 0 ? (
            <p className="text-xs p-2" style={{ color: 'var(--text-tertiary)', margin: 0 }}>No recent detections.</p>
          ) : data.recent.map((r) => (
            <DataRow key={r.threat_id}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 w-full min-w-0">
                <div className="min-w-0">
                  <div className="font-mono text-sm truncate" style={{ color: 'var(--text-primary)' }}>{r.domain}</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    <BrandLink id={r.brand_id} name={r.brand_name} />
                    {' · '}{r.idp ?? 'Unknown provider'}{' · '}{VECTOR_LABELS[r.vector] ?? r.vector}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {statusBadge(r.status)}
                  <span className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>{relativeTime(r.created_at)}</span>
                </div>
              </div>
            </DataRow>
          ))}
        </Card>
      </Section>
    </>
  );
}

export function IdentityThreatsPage() {
  const [win, setWin] = useState<IdentityWindow>('7d');
  const q = useIdentityThreats(win);
  const data = q.data;
  const kind = pageStateKind({
    isLoading: q.isLoading,
    isError: q.isError,
    isEmpty: !!data && data.kpis.detections === 0 && data.recent.length === 0,
  });

  return (
    <div>
      <PageHeader
        title="Identity Provider Impersonation"
        subtitle="Phishing that abuses or imitates sign-in providers (Okta, Microsoft Entra, OneLogin, Auth0) across every monitored brand."
        actions={
          <Tabs
            tabs={WINDOW_TABS}
            activeTab={win}
            onChange={(id) => setWin(id === '30d' ? '30d' : '7d')}
            variant="pills"
            aria-label="Time window"
          />
        }
      />
      {kind ? (
        <PageState
          kind={kind}
          title={kind === 'error' ? "Couldn't load identity threats" : kind === 'empty' ? 'No identity-provider impersonation detected' : undefined}
          description={kind === 'empty' ? `Nothing detected in the last ${win}.` : undefined}
          onRetry={kind === 'error' ? () => { void q.refetch(); } : undefined}
        />
      ) : data ? (
        <Content data={data} />
      ) : null}
    </div>
  );
}
