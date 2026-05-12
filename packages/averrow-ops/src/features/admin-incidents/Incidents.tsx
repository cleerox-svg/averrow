// Admin incidents list — internal triage surface. Lists every
// incident, severity-sorted with open incidents on top. Click-through
// to /admin/incidents/:id for the detail / timeline / actions view.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, PageHeader, Badge, FilterBar } from '@/components/ui';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { CheckCircle } from 'lucide-react';
import { relativeTime } from '@/lib/time';
import { useIncidents, type Incident, type IncidentStatus, type IncidentSeverity } from './useIncidents';

type Filter = 'all' | 'open';

const STATUS_PILL_BG: Record<IncidentStatus, string> = {
  investigating:  'rgba(248,113,113,0.10)',
  identified:     'rgba(251,146,60,0.10)',
  monitoring:     'rgba(251,191,36,0.10)',
  resolved:       'rgba(34,197,94,0.10)',
  postmortem:     'var(--border-base)',
  false_positive: 'var(--border-base)',
};

const STATUS_PILL_TEXT: Record<IncidentStatus, string> = {
  investigating:  '#f87171',
  identified:     '#fb923c',
  monitoring:     '#fbbf24',
  resolved:       '#22c55e',
  postmortem:     'var(--text-secondary)',
  false_positive: 'var(--text-tertiary)',
};

const SEVERITY_TO_BADGE: Record<IncidentSeverity, IncidentSeverity> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info',
};

export function AdminIncidents() {
  const [filter, setFilter] = useState<Filter>('open');
  const { data, isLoading } = useIncidents({ onlyOpen: filter === 'open' });

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <PageHeader
        title="Incidents"
        subtitle={data ? `${data.length} ${filter === 'open' ? 'open' : 'total'}` : undefined}
      />

      <FilterBar
        filters={[
          { value: 'open', label: 'Open' },
          { value: 'all',  label: 'All'  },
        ]}
        active={filter}
        onChange={(v) => setFilter(v as Filter)}
      />

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      ) : (data ?? []).length === 0 ? (
        <EmptyState
          icon={<CheckCircle />}
          title={filter === 'open' ? 'No open incidents' : 'No incidents recorded'}
          subtitle={filter === 'open'
            ? 'The platform is quiet right now. Critical platform_* notifications will auto-create rows here.'
            : 'Critical platform_* notifications auto-create rows here. Manual incidents land here too.'}
          variant="clean"
          compact
        />
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {(data ?? []).map((inc: Incident) => (
            <Link
              key={inc.id}
              to={`/admin/incidents/${inc.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '14px 18px',
                borderBottom: '1px solid var(--border-base, var(--border-base))',
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <Badge severity={SEVERITY_TO_BADGE[inc.severity]} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 14, fontWeight: 600,
                  color: 'var(--text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {inc.title}
                </div>
                <div style={{
                  fontFamily: 'var(--font-mono)', fontSize: 11,
                  color: 'var(--text-tertiary)', marginTop: 2,
                  display: 'flex', gap: 10, flexWrap: 'wrap',
                }}>
                  <span>{relativeTime(inc.created_at)}</span>
                  {inc.affected_components.length > 0 && (
                    <span>{inc.affected_components.slice(0, 2).join(' · ')}{inc.affected_components.length > 2 ? ` +${inc.affected_components.length - 2}` : ''}</span>
                  )}
                  {inc.visibility === 'public' && <span style={{ color: 'var(--amber)' }}>PUBLIC</span>}
                  {inc.source !== 'manual' && <span>auto</span>}
                </div>
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10,
                  fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  padding: '4px 10px', borderRadius: 100,
                  background: STATUS_PILL_BG[inc.status],
                  color: STATUS_PILL_TEXT[inc.status],
                  flexShrink: 0,
                }}
              >
                {inc.status}
              </span>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
