import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProviderDetail, useProviderThreats } from '@/hooks/useProviders';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { StatCard } from '@/components/ui/StatCard';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Tabs } from '@/components/ui/Tabs';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Globe } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, Th, Td } from '@/components/ui/Table';
import { relativeTime } from '@/lib/time';

const THREAT_TYPES = ['all', 'phishing', 'typosquatting', 'impersonation', 'credential_harvesting'] as const;

function statusVariant(status: string): 'critical' | 'high' | 'success' | 'default' {
  if (status === 'active' || status === 'malicious') return 'critical';
  if (status === 'suspicious') return 'high';
  if (status === 'resolved' || status === 'taken_down') return 'success';
  return 'default';
}

export function ProviderDetail() {
  const { providerId } = useParams<{ providerId: string }>();
  const navigate = useNavigate();
  const [threatType, setThreatType] = useState('all');
  const [page, setPage] = useState(0);
  const limit = 20;

  const { data: provider, isLoading } = useProviderDetail(providerId || '');
  const { data: threatsRes } = useProviderThreats(providerId || '', {
    limit,
    offset: page * limit,
    type: threatType === 'all' ? undefined : threatType,
  });

  const threats = (threatsRes ?? []) as Array<{
    id: string;
    malicious_url: string | null;
    malicious_domain: string | null;
    ip_address: string | null;
    threat_type: string;
    brand_name: string;
    first_seen: string;
    status: string;
  }>;
  const threatTotal = (threatsRes as { total?: number } | undefined)?.total ?? threats.length;
  const totalPages = Math.ceil(threatTotal / limit);

  const threatTabs = THREAT_TYPES.map(t => ({
    id: t,
    label: t === 'all' ? 'All' : t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
  }));

  if (isLoading) return <PageLoader />;

  if (!provider) {
    return (
      <div className="animate-fade-in">
        <button onClick={() => navigate('/providers')} className="font-mono text-xs text-[rgba(255,255,255,0.30)] hover:text-accent transition-colors mb-4">
          &larr; Back to Providers
        </button>
        <Card hover={false}><p className="text-sm text-[rgba(255,255,255,0.36)]">Provider not found</p></Card>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-6">
      <button onClick={() => navigate('/providers')} className="font-mono text-xs text-[rgba(255,255,255,0.30)] hover:text-accent transition-colors">
        &larr; Back to Providers
      </button>

      <div className="flex items-center gap-3">
        <h1 className="font-display text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{provider.name}</h1>
        {provider.asn && <Badge variant="info">{provider.asn}</Badge>}
        {provider.country && <Badge variant="default">{provider.country}</Badge>}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Active Threats" value={provider.active_threats ?? 0} />
        <StatCard label="Total Threats" value={provider.total_threats ?? 0} />
        <StatCard label="Brands Targeted" value={provider.brands_targeted ?? 0} />
        <StatCard label="Avg Response" value={provider.avg_response_time ? `${provider.avg_response_time}h` : '—'} />
        <StatCard label="Reputation" value={provider.reputation_score ?? '—'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center gap-3">
            <SectionLabel>Threats Hosted</SectionLabel>
            <Badge variant="info">{threatTotal}</Badge>
          </div>

          <Tabs
            tabs={threatTabs}
            activeTab={threatType}
            onChange={(id) => { setThreatType(id); setPage(0); }}
          />

          <Table>
            <thead>
              <tr>
                <Th>Malicious URL/IP</Th>
                <Th>Type</Th>
                <Th>Target Brand</Th>
                <Th>First Seen</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {threats.map(threat => (
                <tr key={threat.id} className="data-row">
                  <Td>
                    <span className="font-mono text-xs text-[rgba(255,255,255,0.83)] break-all">
                      {threat.malicious_url || threat.malicious_domain || threat.ip_address || '—'}
                    </span>
                  </Td>
                  <Td>
                    <Badge variant="info">{threat.threat_type}</Badge>
                  </Td>
                  <Td>
                    <span className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{threat.brand_name}</span>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs text-[rgba(255,255,255,0.30)]">{relativeTime(threat.first_seen)}</span>
                  </Td>
                  <Td>
                    <Badge variant={statusVariant(threat.status)}>{threat.status}</Badge>
                  </Td>
                </tr>
              ))}
              {threats.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-2">
                    <EmptyState
                      icon={<Globe />}
                      title="No threats found"
                      subtitle="No threats have been linked to this provider yet"
                      variant="clean"
                      compact
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </Table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="font-mono text-xs text-[rgba(255,255,255,0.30)] hover:text-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                &larr; Previous
              </button>
              <span className="font-mono text-xs text-white/55">
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="font-mono text-xs text-[rgba(255,255,255,0.30)] hover:text-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next &rarr;
              </button>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {provider.brand_breakdown && provider.brand_breakdown.length > 0 && (
            <Card hover={false}>
              <SectionLabel className="mb-3">Brands Targeted</SectionLabel>
              <div className="space-y-2">
                {provider.brand_breakdown.map(b => {
                  const maxCount = provider.brand_breakdown[0]?.count || 1;
                  const pct = (b.count / maxCount) * 100;
                  return (
                    <div key={b.brand_id ?? b.brand_name} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-[rgba(255,255,255,0.74)] truncate">{b.brand_name ?? 'Unknown'}</span>
                        <span className="font-mono text-xs text-[rgba(255,255,255,0.30)]">{b.count}</span>
                      </div>
                      <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {provider.type_breakdown && provider.type_breakdown.length > 0 && (
            <Card hover={false}>
              <SectionLabel className="mb-3">Threat Types</SectionLabel>
              <div className="space-y-2">
                {provider.type_breakdown.map(t => {
                  const maxCount = provider.type_breakdown[0]?.count || 1;
                  const pct = (t.count / maxCount) * 100;
                  return (
                    <div key={t.threat_type} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-[rgba(255,255,255,0.74)] truncate">{t.threat_type.replace(/_/g, ' ')}</span>
                        <span className="font-mono text-xs text-[rgba(255,255,255,0.30)]">{t.count}</span>
                      </div>
                      <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
