import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import { Card, DataRow, FilterBar, PageHeader, SaasTechniqueBadge } from '@/components/ui';
import { ThreatInflowChart } from './ThreatInflowChart';
import { relativeTime } from '@/lib/time';
import { CheckCircle, Search } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Severity } from '@/components/ui/Badge';

interface Threat {
  id: string;
  threat_type: string;
  severity: string | null;
  status: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  ip_address: string | null;
  target_brand_id: string | null;
  brand_name: string | null;
  actor_id: string | null;
  actor_name: string | null;
  country_code: string | null;
  created_at: string;
  saas_technique_id: string | null;
  saas_technique_name: string | null;
  saas_technique_phase: string | null;
  saas_technique_phase_label: string | null;
  saas_technique_severity: string | null;
}

function toSeverity(s: string | null): Severity | undefined {
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low' || s === 'info') return s;
  return undefined;
}

export function Threats() {
  const [severity, setSeverity] = useState<string>('all');
  const [page, setPage] = useState(0);
  const limit = 50;

  const { data, isLoading } = useQuery({
    queryKey: ['threats', severity, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(page * limit));
      if (severity && severity !== 'all') params.set('severity', severity);
      const res = await api.get<{ threats: Threat[]; total: number }>(`/api/threats?${params}`);
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed');
      return res.data;
    },
  });

  return (
    <div className="p-6 space-y-4 max-w-7xl">
      <PageHeader
        title="Threats"
        subtitle={data ? `${data.total.toLocaleString()} active indicators` : undefined}
      />

      <ThreatInflowChart />

      <FilterBar
        filters={[
          { value: 'all',      label: 'All' },
          { value: 'critical', label: 'Critical' },
          { value: 'high',     label: 'High' },
          { value: 'medium',   label: 'Medium' },
          { value: 'low',      label: 'Low' },
        ]}
        active={severity}
        onChange={(v) => { setSeverity(v); setPage(0); }}
      />

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : (
        <>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {(data?.threats ?? []).length === 0 ? (
              <EmptyState
                icon={severity !== 'all' ? <Search /> : <CheckCircle />}
                title={severity !== 'all' ? 'No threats match filters' : 'No active threats'}
                subtitle={severity !== 'all'
                  ? 'Try a different severity filter or time window'
                  : 'All monitored brands are clean for this time window'}
                action={severity !== 'all'
                  ? { label: 'Clear filters', onClick: () => { setSeverity('all'); setPage(0); } }
                  : undefined}
                variant="clean"
                compact
              />
            ) : (
              (data?.threats ?? []).map((t) => (
                <DataRow key={t.id} severity={toSeverity(t.severity)}>
                  <div className="grid grid-cols-[1fr_1.5fr_1fr_1fr_0.6fr_0.6fr_0.8fr] gap-3 items-center w-full font-mono text-[11px]">
                    <span style={{ color: 'var(--text-primary)' }}>{t.threat_type}</span>
                    <div className="flex flex-col gap-1 min-w-0">
                      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{t.malicious_domain ?? '-'}</span>
                      {t.saas_technique_id && t.saas_technique_name && t.saas_technique_phase && t.saas_technique_phase_label && (
                        <SaasTechniqueBadge
                          techniqueId={t.saas_technique_id}
                          techniqueName={t.saas_technique_name}
                          phase={t.saas_technique_phase}
                          phaseLabel={t.saas_technique_phase_label}
                          severity={t.saas_technique_severity ?? 'medium'}
                          size="xs"
                        />
                      )}
                    </div>
                    <span>
                      {t.target_brand_id ? (
                        <Link
                          to={`/brands/${t.target_brand_id}`}
                          className="hover:underline underline-offset-2"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {t.brand_name ?? t.target_brand_id}
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </span>
                    <span>
                      {t.actor_id ? (
                        <Link
                          to={`/threat-actors/${t.actor_id}`}
                          className="hover:underline underline-offset-2"
                          style={{ color: 'var(--amber)' }}
                        >
                          {t.actor_name ?? 'Unknown Actor'}
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>Unattributed</span>
                      )}
                    </span>
                    <span className="text-[10px] font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>
                      {t.severity ?? '-'}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{t.status}</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{relativeTime(t.created_at)}</span>
                  </div>
                </DataRow>
              ))
            )}
          </Card>

          {data && data.total > limit && (
            <div className="flex items-center gap-3 justify-center">
              <button
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="font-mono text-[11px] disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ color: 'var(--text-secondary)' }}
              >
                Prev
              </button>
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                Page {page + 1} of {Math.ceil(data.total / limit)}
              </span>
              <button
                onClick={() => setPage(page + 1)}
                disabled={(page + 1) * limit >= data.total}
                className="font-mono text-[11px] disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ color: 'var(--text-secondary)' }}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
