import { useCallback, useId, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  BreakdownCard, Card, DataRow, PageHeader, PageState, StatTile,
  Table, Td, Th, Tabs, Sparkline, pageStateKind,
} from '@/design-system/components';
import { DetectionsSection } from './DetectionsSection';
import { useIdentityThreats } from './useIdentityThreats';
import type { IdentityFilters, IdentityThreatsData, IdentityWindow } from './types';

const WINDOW_TABS = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

const VECTOR_LABELS: Record<string, string> = {
  idp_tenant: 'Rogue sign-in tenant',
  idp_lookalike: 'Lookalike sign-in domain',
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

function Empty({ children = 'No data in this window.' }: { children?: ReactNode }) {
  return <p className="text-xs" style={{ color: 'var(--text-secondary)', margin: 0 }}>{children}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mb-4">
      <h2 id={id} className={`${LABEL_CLS} mb-2`} style={{ color: 'var(--text-secondary)' }}>{title}</h2>
      {children}
    </section>
  );
}

const FILTER_KEYS = ['idp', 'vector', 'brand_id', 'mitre'] as const;
type FilterKey = typeof FILTER_KEYS[number];

interface FilterCtl {
  win: IdentityWindow;
  filters: IdentityFilters;
  toggle: (key: FilterKey, value: string) => void;
}

const SELECTABLE_CLS = 'flex w-full min-h-[44px] cursor-pointer items-center justify-between gap-3 rounded-lg border-0 px-2 py-1 text-left text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]';

function selectedStyle(selected: boolean): React.CSSProperties {
  return {
    background: selected ? 'var(--amber-glow)' : 'transparent',
    boxShadow: selected ? 'inset 2px 0 0 var(--amber)' : 'none',
  };
}

function BreakdownRow({ label, count, sub, selected, onSelect }: {
  label: string; count: number; sub?: string; selected: boolean; onSelect: () => void;
}) {
  return (
    <button type="button" aria-pressed={selected} onClick={onSelect} className={SELECTABLE_CLS} style={selectedStyle(selected)}>
      <span style={{ color: 'var(--text-primary)' }}>{label}</span>
      <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
        {count.toLocaleString('en-US')}{sub ? ` · ${sub}` : ''}
      </span>
    </button>
  );
}

function FilterChips({ items, onRemove, onClear }: {
  items: { key: FilterKey; label: string }[]; onRemove: (key: FilterKey) => void; onClear: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div role="group" aria-label="Active filters" className="mb-4 flex flex-wrap items-center gap-2">
      {items.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onRemove(c.key)}
          aria-label={`Remove filter: ${c.label}`}
          className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full px-3 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
          style={{ border: '1px solid var(--amber)', background: 'var(--amber-glow)', color: 'var(--text-primary)' }}
        >
          <span>{c.label}</span><span aria-hidden="true">×</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="min-h-[44px] cursor-pointer border-0 bg-transparent px-2 text-[13px] underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        style={{ color: 'var(--amber-text)' }}
      >
        Clear all
      </button>
    </div>
  );
}

function Content({ data, ctl, detectionsRef }: {
  data: IdentityThreatsData; ctl: FilterCtl; detectionsRef: React.Ref<HTMLElement>;
}) {
  const { kpis } = data;
  const { filters, toggle } = ctl;
  const filterLabels = filterChips(data, filters).map((c) => c.label);
  const vectorTotal = data.by_vector.reduce((n, v) => n + v.count, 0);
  const idpTotal = data.by_idp.reduce((n, v) => n + v.count, 0);
  const trend = data.trend.map((p) => p.count);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <StatTile label="Detections" value={kpis.detections} sub={deltaText(kpis.detections, kpis.detections_prev)} tone="amber" />
        <StatTile label="Brands targeted" value={kpis.brands_targeted} />
        <StatTile label="Identity providers abused" value={kpis.idps_impersonated} />
        <StatTile label="Live threats" value={kpis.live} tone="red" />
        <StatTile label="Taken down" value={kpis.taken_down} tone="green" />
        <StatTile label="Lookalike domains flagged" value={kpis.lookalikes_flagged} />
      </div>

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
        <BreakdownCard title="By attack method" metric={vectorTotal.toLocaleString('en-US')} metricLabel="detections">
          {data.by_vector.length === 0 && <Empty />}
          {data.by_vector.map((v) => (
            <BreakdownRow key={v.vector} label={v.label || VECTOR_LABELS[v.vector] || v.vector} count={v.count} sub={deltaText(v.count, v.prev)} selected={filters.vector === v.vector} onSelect={() => toggle('vector', v.vector)} />
          ))}
        </BreakdownCard>
        <BreakdownCard title="By identity provider" metric={idpTotal.toLocaleString('en-US')} metricLabel="detections">
          {data.by_idp.length === 0 && <Empty />}
          {data.by_idp.map((i) => (
            <BreakdownRow key={i.idp} label={i.label} count={i.count} sub={`${i.brands} ${i.brands === 1 ? 'brand' : 'brands'}`} selected={filters.idp === i.idp} onSelect={() => toggle('idp', i.idp)} />
          ))}
        </BreakdownCard>
      </div>

      <Section title="Most targeted brands">
        <Card padding="sm">
          {data.top_brands.length === 0 ? (
            <p className="text-xs p-2" style={{ color: 'var(--text-tertiary)', margin: 0 }}>No brands targeted in this window.</p>
          ) : data.top_brands.map((b) => {
            const selected = filters.brand_id === b.brand_id;
            return (
              <DataRow key={b.brand_id}>
                <div className="flex w-full min-w-0 items-center gap-1">
                  <button type="button" aria-pressed={selected} onClick={() => toggle('brand_id', b.brand_id)} className={`${SELECTABLE_CLS} min-w-0 flex-1`} style={selectedStyle(selected)}>
                    <span className="min-w-0">
                      <span className="block text-sm" style={{ color: 'var(--text-primary)' }}>{b.brand_name}</span>
                      {b.idps.length > 0 && (
                        <span className="block truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>{b.idps.join(', ')}</span>
                      )}
                    </span>
                    <span className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>{b.count.toLocaleString('en-US')}</span>
                  </button>
                  <Link
                    to={`/brands/${encodeURIComponent(b.brand_id)}`}
                    aria-label={`Open ${b.brand_name} brand page`}
                    className="inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-lg no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
                    style={{ color: 'var(--amber-text)' }}
                  >
                    <span aria-hidden="true">↗</span>
                  </Link>
                </div>
              </DataRow>
            );
          })}
        </Card>
      </Section>

      <Section title="MITRE ATT&CK techniques">
        <Card padding="sm">
          {data.mitre.length === 0 ? <Empty /> : (
          <Table label="MITRE ATT&CK techniques">
            <thead>
              <tr><Th>ID</Th><Th>Technique</Th><Th>Tactic</Th><Th style={{ textAlign: 'right' }}>Count</Th></tr>
            </thead>
            <tbody>
              {data.mitre.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <a href={mitreUrl(m.id)} target="_blank" rel="noopener noreferrer" className="font-mono hover:underline" style={{ color: 'var(--amber-text)' }}>
                      {m.id}<span className="sr-only"> (opens in new tab)</span>
                    </a>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      aria-pressed={filters.mitre === m.id}
                      onClick={() => toggle('mitre', m.id)}
                      className="min-h-[44px] cursor-pointer rounded border-0 bg-transparent px-1 text-left text-inherit focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
                      style={{ ...selectedStyle(filters.mitre === m.id), color: 'var(--text-primary)' }}
                    >
                      {m.name}
                    </button>
                  </Td>
                  <Td>{m.tactic}</Td>
                  <Td style={{ textAlign: 'right' }}>{m.count.toLocaleString('en-US')}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          )}
        </Card>
      </Section>

      {/* KPIs above stay unfiltered; a later iteration may pass `filters` to them. */}
      <DetectionsSection ref={detectionsRef} window={ctl.win} filters={filters} filterLabels={filterLabels} />
    </>
  );
}

function filterChips(data: IdentityThreatsData | undefined, f: IdentityFilters): { key: FilterKey; label: string }[] {
  const out: { key: FilterKey; label: string }[] = [];
  if (f.idp) out.push({ key: 'idp', label: data?.by_idp.find((i) => i.idp === f.idp)?.label ?? f.idp });
  if (f.vector) {
    out.push({ key: 'vector', label: data?.by_vector.find((v) => v.vector === f.vector)?.label || VECTOR_LABELS[f.vector] || f.vector });
  }
  if (f.brand_id) {
    out.push({ key: 'brand_id', label: data?.top_brands.find((b) => b.brand_id === f.brand_id)?.brand_name ?? 'Brand' });
  }
  if (f.mitre) {
    const m = data?.mitre.find((x) => x.id === f.mitre);
    out.push({ key: 'mitre', label: m ? `${m.id} ${m.name}` : f.mitre });
  }
  return out;
}

export function IdentityThreatsPage() {
  const [params, setParams] = useSearchParams();
  const win: IdentityWindow = params.get('window') === '30d' ? '30d' : '7d';
  const filters: IdentityFilters = {
    idp: params.get('idp') || undefined,
    vector: params.get('vector') || undefined,
    brand_id: params.get('brand_id') || undefined,
    mitre: params.get('mitre') || undefined,
  };
  const detectionsRef = useRef<HTMLElement>(null);

  const update = useCallback((mutate: (p: URLSearchParams) => void) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      return next;
    });
  }, [setParams]);

  const toggle = useCallback((key: FilterKey, value: string) => {
    const selecting = params.get(key) !== value;
    update((p) => { if (selecting) p.set(key, value); else p.delete(key); });
    if (selecting) {
      // Move the reader to the list once it has re-rendered with the filter.
      setTimeout(() => {
        const el = detectionsRef.current;
        if (!el) return;
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
      }, 0);
    }
  }, [params, update]);

  const q = useIdentityThreats(win);
  const data = q.data;
  const kind = pageStateKind({
    isLoading: q.isLoading,
    isError: q.isError,
    isEmpty: !!data && data.kpis.detections === 0 && data.recent.length === 0,
  });
  const chips = filterChips(data, filters);

  return (
    <div>
      <PageHeader
        title="Identity Provider Impersonation"
        subtitle="Phishing that abuses or imitates sign-in providers (Okta, Microsoft Entra, OneLogin, Auth0) across every monitored brand."
        actions={
          <Tabs
            tabs={WINDOW_TABS}
            activeTab={win}
            onChange={(id) => update((p) => { if (id === '30d') p.set('window', '30d'); else p.delete('window'); })}
            variant="pills"
            aria-label="Time window"
          />
        }
      />
      <FilterChips
        items={chips}
        onRemove={(key) => update((p) => p.delete(key))}
        onClear={() => update((p) => FILTER_KEYS.forEach((k) => p.delete(k)))}
      />
      {kind ? (
        <PageState
          kind={kind}
          title={kind === 'error' ? "Couldn't load identity threats" : kind === 'empty' ? 'No identity-provider impersonation detected' : undefined}
          description={kind === 'empty' ? `Nothing detected in the last ${win}.` : undefined}
          onRetry={kind === 'error' ? () => { void q.refetch(); } : undefined}
        />
      ) : data ? (
        <Content data={data} ctl={{ win, filters, toggle }} detectionsRef={detectionsRef} />
      ) : null}
    </div>
  );
}
