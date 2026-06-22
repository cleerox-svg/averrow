// Cinematic v4 incidents view — used inside the SOC Console's Incidents tab.
// Same data (useIncidents) as the classic /admin/incidents page, re-skinned
// onto @averrow/shared/ui with severity accents + glow so the interior is
// visibly v4 (the classic page is left untouched for its standalone route).

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@averrow/shared/ui';
import { relativeTime } from '@/lib/time';
import {
  useIncidents, type Incident, type IncidentSeverity, type IncidentStatus,
} from '@/features/admin-incidents/useIncidents';
import '../console.css';

const SEV_TO_BADGE: Record<IncidentSeverity, 'critical' | 'high' | 'medium' | 'low' | 'neutral'> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'neutral',
};
const SEV_ACCENT: Record<IncidentSeverity, string> = {
  critical: 'var(--sev-critical)', high: 'var(--sev-high)', medium: 'var(--sev-medium)',
  low: 'var(--sev-low)', info: 'var(--text-tertiary)',
};
const STATUS_COLOR: Record<IncidentStatus, string> = {
  investigating: '#f87171', identified: '#fb923c', monitoring: '#fbbf24',
  resolved: '#22c55e', postmortem: 'var(--text-secondary)', false_positive: 'var(--text-tertiary)',
};

export function ConsoleIncidents() {
  const [openOnly, setOpenOnly] = useState(true);
  const { data, isLoading } = useIncidents({ onlyOpen: openOnly });
  const incidents = data ?? [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Incidents</h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
          {isLoading ? '…' : `${incidents.length} ${openOnly ? 'open' : 'total'}`}
        </span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          {(['open', 'all'] as const).map(f => {
            const active = (f === 'open') === openOnly;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setOpenOnly(f === 'open')}
                className="ci-filter"
                style={{
                  fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.06em',
                  textTransform: 'uppercase', padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
                  color: active ? '#0A0F1E' : 'var(--text-secondary)',
                  background: active ? 'linear-gradient(135deg,var(--amber),var(--amber-dim))' : 'transparent',
                  border: active ? '1px solid transparent' : '1px solid var(--border-base)',
                }}
              >
                {f}
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <div style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 13, padding: 24 }}>Loading…</div>
      ) : incidents.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', padding: 32, textAlign: 'center' }}>
          {openOnly ? 'No open incidents — the platform is quiet.' : 'No incidents recorded.'}
        </div>
      ) : (
        incidents.map((inc: Incident) => (
          <Link key={inc.id} to={`/admin/incidents/${inc.id}`} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
            <div
              className="ci-row"
              style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px 13px 18px',
                borderRadius: 12, marginBottom: 8, position: 'relative', overflow: 'hidden',
                background: 'linear-gradient(160deg,var(--bg-card),var(--bg-card-deep,var(--bg-card)))',
                border: '1px solid var(--border-base)',
                boxShadow: inc.severity === 'critical' ? '0 0 22px rgba(200,60,60,0.12)' : 'none',
              }}
            >
              <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: SEV_ACCENT[inc.severity], boxShadow: `0 0 10px ${SEV_ACCENT[inc.severity]}` }} />
              <Badge severity={SEV_TO_BADGE[inc.severity]} dot size="sm">{inc.severity}</Badge>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {inc.title}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span>{relativeTime(inc.created_at)}</span>
                  {inc.affected_components.length > 0 && (
                    <span>{inc.affected_components.slice(0, 2).join(' · ')}{inc.affected_components.length > 2 ? ` +${inc.affected_components.length - 2}` : ''}</span>
                  )}
                  {inc.source !== 'manual' && <span>auto</span>}
                </div>
              </div>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
                textTransform: 'uppercase', padding: '4px 10px', borderRadius: 100, flexShrink: 0,
                color: STATUS_COLOR[inc.status], background: 'rgba(255,255,255,0.04)',
                border: `1px solid ${STATUS_COLOR[inc.status]}33`,
              }}>
                {inc.status}
              </span>
            </div>
          </Link>
        ))
      )}
    </div>
  );
}
