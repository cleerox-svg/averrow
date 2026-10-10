import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  BreakdownCard, Card, DataRow, PageHeader, PageState, StatTile,
  Table, Td, Th, Tabs, Sparkline, pageStateKind,
} from '@/design-system/components';
import { DetectionsSection } from './DetectionsSection';
import { useIdentityDetections, useIdentityThreats } from './useIdentityThreats';
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

const LABEL_CLS = 'font-mono text-[11px] font-bold uppercase tracking-[0.18em]';

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

const IDP_IDS = ['okta', 'entra', 'onelogin', 'auth0', 'ping', 'duo', 'google', 'generic_sso'];
const VECTOR_IDS = ['idp_tenant', 'idp_lookalike', 'device_code'];

/** Drop stale/hand-edited enum values (the API 400s on them). brand_id passes through. */
function sanitizeFilters(f: IdentityFilters, data: IdentityThreatsData | undefined): IdentityFilters {
  return {
    idp: f.idp && IDP_IDS.includes(f.idp) ? f.idp : undefined,
    vector: f.vector && VECTOR_IDS.includes(f.vector) ? f.vector : undefined,
    brand_id: f.brand_id,
    mitre: f.mitre && data?.mitre.some((m) => m.id === f.mitre) ? f.mitre : undefined,
  };
}

interface FilterCtl {
  brandName?: string | null;
  win: IdentityWindow;
  clear: () => void;
  filters: IdentityFilters;
  toggle: (key: FilterKey, value: string) => void;
}

const SELECTABLE_CLS = 'flex w-full min-h-[44px] cursor-pointer items-center justify-between gap-3 rounded-lg border-0 px-2 py-1 text-left text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]';

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
    <button type="button" aria-pressed={selected} onClick={onSelect} className={`${SELECTABLE_CLS} flex-wrap`} style={selectedStyle(selected)}>
      <span style={{ color: 'var(--text-primary)' }}>{label}</span>
      <span className="font-mono text-right" style={{ color: 'var(--text-secondary)' }}>
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
    <div
      role="group"
      aria-label="Active filters"
      className="sticky top-0 z-10 -mx-1 mb-4 flex flex-wrap items-center gap-2 px-1 py-1"
      style={{ background: 'var(--bg-page)' }}
    >
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
      {items.length > 1 && <button
        type="button"
        onClick={onClear}
        className="min-h-[44px] cursor-pointer border-0 bg-transparent px-2 text-[13px] underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        style={{ color: 'var(--amber-text)' }}
      >
        Clear all
      </button>}
    </div>
  );
}

function Content({ data, ctl, detectionsRef }: {
  data: IdentityThreatsData; ctl: FilterCtl; detectionsRef: React.Ref<HTMLElement>;
}) {
  const { kpis } = data;
  const { filters, toggle } = ctl;
  const filterLabels = filterChips(data, filters, ctl.brandName).map((c) => c.label);
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

      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' }}>
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
                        <span className="block text-[12px]" style={{ color: 'var(--text-secondary)' }}>{b.idps.join(', ')}</span>
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
          <>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 sm:hidden" aria-label="MITRE ATT&CK techniques">
            {data.mitre.map((m) => {
              const sel = filters.mitre === m.id;
              return (
                <li key={m.id} className="relative">
                  <button
                    type="button"
                    aria-pressed={sel}
                    aria-label={`${m.id} ${m.name}, ${m.tactic}, ${m.count} detections`}
                    onClick={() => toggle('mitre', m.id)}
                    className="block min-h-[56px] w-full cursor-pointer rounded-lg px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
                    style={{ ...selectedStyle(sel), border: '1px solid var(--border-base)', color: 'var(--text-primary)' }}
                  >
                    <span className="block text-[13px]"><span className="font-mono">{m.id}</span> · {m.name}</span>
                    <span className="block text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      {m.tactic} · {m.count.toLocaleString('en-US')}
                    </span>
                  </button>
                  <a
                    href={mitreUrl(m.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="absolute right-0 top-0 inline-flex h-[44px] w-[44px] items-center justify-center text-[13px] no-underline"
                    style={{ color: 'var(--amber-text)' }}
                  >
                    <span aria-hidden="true">↗</span><span className="sr-only">{m.id} on MITRE ATT&CK (opens in new tab)</span>
                  </a>
                </li>
              );
            })}
          </ul>
          <div className="hidden sm:block">
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
          </div>
          </>
          )}
        </Card>
      </Section>

      {/* KPIs above stay unfiltered; a later iteration may pass `filters` to them. */}
      <DetectionsSection ref={detectionsRef} window={ctl.win} filters={filters} filterLabels={filterLabels} onClearFilters={ctl.clear} />
    </>
  );
}

function filterChips(data: IdentityThreatsData | undefined, f: IdentityFilters, brandName?: string | null): { key: FilterKey; label: string }[] {
  const out: { key: FilterKey; label: string }[] = [];
  if (f.idp) out.push({ key: 'idp', label: data?.by_idp.find((i) => i.idp === f.idp)?.label ?? f.idp });
  if (f.vector) {
    out.push({ key: 'vector', label: data?.by_vector.find((v) => v.vector === f.vector)?.label || VECTOR_LABELS[f.vector] || f.vector });
  }
  if (f.brand_id) {
    out.push({ key: 'brand_id', label: data?.top_brands.find((b) => b.brand_id === f.brand_id)?.brand_name ?? brandName ?? 'Brand' });
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
  const detectionsRef = useRef<HTMLElement>(null);
  const moveToList = useRef(false);

  const update = useCallback((mutate: (p: URLSearchParams) => void, replace = false) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      return next;
    }, { replace });
  }, [setParams]);

  const q = useIdentityThreats(win);
  const data = q.data;
  const filters = sanitizeFilters({
    idp: params.get('idp') || undefined,
    vector: params.get('vector') || undefined,
    brand_id: params.get('brand_id') || undefined,
    mitre: params.get('mitre') || undefined,
  }, data);
  // Same query key as DetectionsSection, so this shares its cache; used only for the brand chip label.
  const dq = useIdentityDetections(win, filters, { enabled: !!data && !!filters.brand_id });
  const brandName = dq.data?.pages[0]?.items.find((i) => i.brand_id === filters.brand_id)?.brand_name ?? null;
  const clearFilters = useCallback(() => update((p) => FILTER_KEYS.forEach((k) => p.delete(k)), true), [update]);

  const toggle = useCallback((key: FilterKey, value: string) => {
    const selecting = params.get(key) !== value;
    update((p) => { if (selecting) p.set(key, value); else p.delete(key); }, true);
    moveToList.current = selecting;
  }, [params, update]);

  // After the filtered render, move the reader to the list (not on first load).
  const filterKey = `${filters.idp ?? ''}|${filters.vector ?? ''}|${filters.brand_id ?? ''}|${filters.mitre ?? ''}`;
  useEffect(() => {
    if (!moveToList.current) return;
    moveToList.current = false;
    const el = detectionsRef.current;
    if (!el) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [filterKey]);

  const kind = pageStateKind({
    isLoading: q.isLoading,
    isError: q.isError,
    isEmpty: !!data && data.kpis.detections === 0 && data.recent.length === 0,
  });
  const chips = filterChips(data, filters, brandName);

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
        onRemove={(key) => update((p) => p.delete(key), true)}
        onClear={clearFilters}
      />
      {kind ? (
        <PageState
          kind={kind}
          title={kind === 'error' ? "Couldn't load identity threats" : kind === 'empty' ? 'No identity-provider impersonation detected' : undefined}
          description={kind === 'empty' ? `Nothing detected in the last ${win}.` : undefined}
          onRetry={kind === 'error' ? () => { void q.refetch(); } : undefined}
        />
      ) : data ? (
        <Content data={data} ctl={{ win, filters, toggle, clear: clearFilters, brandName }} detectionsRef={detectionsRef} />
      ) : null}
    </div>
  );
}
