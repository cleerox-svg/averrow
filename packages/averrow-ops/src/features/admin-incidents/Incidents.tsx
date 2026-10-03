// Admin incidents list — internal triage surface. Lists every
// incident, severity-sorted with open incidents on top. Click-through
// to /admin/incidents/:id for the detail / timeline / actions view.

import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, Badge, FilterBar } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { CheckCircle } from 'lucide-react';
import { relativeTime } from '@/lib/time';
import { useIncidents, useCreateIncident, type Incident, type IncidentStatus, type IncidentSeverity } from './useIncidents';

type Filter = 'all' | 'open';

const STATUS_PILL_BG: Record<IncidentStatus, string> = {
  investigating:  'var(--sev-critical-bg)',
  identified:     'var(--sev-high-bg)',
  monitoring:     'var(--sev-medium-bg)',
  resolved:       'var(--sev-info-bg)',
  postmortem:     'var(--border-base)',
  false_positive: 'var(--border-base)',
};

const STATUS_PILL_TEXT: Record<IncidentStatus, string> = {
  investigating:  'var(--sev-critical-text)',
  identified:     'var(--sev-high-text)',
  monitoring:     'var(--sev-medium-text)',
  resolved:       'var(--sev-info-text)',
  postmortem:     'var(--text-secondary)',
  false_positive: 'var(--text-tertiary)',
};

export function AdminIncidents() {
  const [filter, setFilter] = useState<Filter>('open');
  const [showCreate, setShowCreate] = useState(false);
  const { data, isLoading } = useIncidents({ onlyOpen: filter === 'open' });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {data ? `${data.length} ${filter === 'open' ? 'open' : 'total'}` : ''}
        </span>
        <Button onClick={() => setShowCreate(s => !s)}>
          {showCreate ? 'Close' : 'New incident'}
        </Button>
      </div>

      {showCreate && <CreateIncidentPanel onDone={() => setShowCreate(false)} />}

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
              className="hover:bg-[var(--bg-elevated)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--amber)]"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 14,
                padding: '14px 18px',
                borderBottom: '1px solid var(--border-base, var(--border-base))',
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <Badge severity={inc.severity} />
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 14, fontWeight: 600,
                  color: 'var(--text-primary)',
                  overflowWrap: 'anywhere', whiteSpace: 'normal',
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

// ─── Manual incident creation ─────────────────────────────────────
// The POST endpoint existed since migration 0132 with no UI entry —
// the empty-state copy even promised "Manual incidents land here too".
// Creates as internal visibility; promote to /status from the detail
// page's visibility controls after creation.

function CreateIncidentPanel({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const create = useCreateIncident();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<IncidentSeverity>('high');
  const [components, setComponents] = useState('');
  const uid = useId();
  const ids = { title: `${uid}-title`, desc: `${uid}-desc`, sev: `${uid}-sev`, comp: `${uid}-comp` };

  function submit() {
    if (!title.trim() || create.isPending) return;
    const affected = components
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    create.mutate(
      {
        title: title.trim(),
        description: description.trim() || undefined,
        severity,
        affected_components: affected.length > 0 ? affected : undefined,
      },
      {
        onSuccess: (incident) => {
          onDone();
          // Land on the new incident's timeline so the operator can
          // append the first real update immediately.
          navigate(`/admin/incidents/${incident.id}`);
        },
      },
    );
  }

  return (
    <Card>
      <SectionLabel className="mb-3">New incident</SectionLabel>
      <div className="space-y-3">
        <div>
          <label htmlFor={ids.title} className="block font-mono text-[11px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>
            Title
          </label>
          <Input
            id={ids.title}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Feed ingestion degraded — upstream provider outage"
            maxLength={500}
          />
        </div>
        <div>
          <label htmlFor={ids.desc} className="block font-mono text-[11px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>
            Description (optional)
          </label>
          <Input
            id={ids.desc}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's happening, impact, current hypothesis"
            maxLength={4000}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[max-content_1fr_max-content] gap-3 items-end">
          <div>
            <label htmlFor={ids.sev} className="block font-mono text-[11px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>
              Severity
            </label>
            <Select
              id={ids.sev}
              value={severity}
              onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}
              options={[
                { value: 'critical', label: 'Critical' },
                { value: 'high',     label: 'High' },
                { value: 'medium',   label: 'Medium' },
                { value: 'low',      label: 'Low' },
                { value: 'info',     label: 'Info' },
              ]}
            />
          </div>
          <div>
            <label htmlFor={ids.comp} className="block font-mono text-[11px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>
              Affected components (comma-separated, optional)
            </label>
            <Input
              id={ids.comp}
              value={components}
              onChange={(e) => setComponents(e.target.value)}
              placeholder="feeds, enrichment, api"
            />
          </div>
          <Button onClick={submit} disabled={create.isPending || !title.trim()}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
        <p className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          Created as internal (never on /status) with status "investigating". Promote visibility from the incident's detail page.
        </p>
        {create.isError && (
          <p className="text-[11px]" style={{ color: 'var(--sev-critical)' }}>
            {(create.error as Error).message}
          </p>
        )}
      </div>
    </Card>
  );
}
