// Admin incident detail — timeline, write-update form, status
// transition controls, and the public-promote drawer.
//
// The timeline blends operator + system updates. System rows render
// with a different glyph + dimmer styling so the editorial layer
// stands out. This is the "Option C" view from the planning thread.

import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Card, PageHeader, Badge, Button } from '@/components/ui';
import { Skeleton } from '@/components/ui/Skeleton';
import { StateMachineButtons } from '@/design-system/components';
import {
  useIncident, useAppendIncidentUpdate, useTransitionIncident, usePromoteIncident,
  useEditUpdatePublicCopy,
  type IncidentStatus, type IncidentSeverity,
} from './useIncidents';

const SEVERITY_TO_BADGE: Record<IncidentSeverity, IncidentSeverity> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info',
};

// `postmortem` is reserved and not yet exposed in the dropdown.
// `false_positive` IS exposed — operators close noisy/flapping incidents
// this way so they don't end up on the public status site alongside
// genuine outages (see lib/incidents.toPublicShape).
const STATUSES: IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved', 'false_positive'];

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

export function AdminIncidentDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useIncident(id);

  const append = useAppendIncidentUpdate(id ?? '');
  const transition = useTransitionIncident(id ?? '');
  const promote = usePromoteIncident(id ?? '');
  const editPublicCopy = useEditUpdatePublicCopy(id ?? '');

  const [updateMessage, setUpdateMessage] = useState('');
  const [updatePublicMessage, setUpdatePublicMessage] = useState('');
  const [updateStatus, setUpdateStatus] = useState<IncidentStatus | ''>('');
  const [updatePublic, setUpdatePublic] = useState(false);

  const [publicTitle, setPublicTitle] = useState('');
  const [publicDetails, setPublicDetails] = useState('');

  // Inline per-update public-copy editor state. Tracks the currently
  // open update id and the draft text. Only one row can be edited at
  // a time to keep the layout simple.
  const [editingUpdateId, setEditingUpdateId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');

  if (isLoading || !data) {
    return (
      <div className="p-6 space-y-4 max-w-3xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const { incident, updates } = data;

  // Pre-populate the public draft fields with internal values when the
  // incident hasn't been promoted yet, so the operator edits forward
  // rather than starting from blank.
  const draftPublicTitle = publicTitle || incident.public_title || '';
  const draftPublicDetails = publicDetails || incident.public_details || '';

  const handleAppend = () => {
    if (!updateMessage.trim()) return;
    // Backend enforces this too — surface a friendly hint inline so
    // the operator doesn't round-trip a 400.
    if (updatePublic && !updatePublicMessage.trim()) {
      // eslint-disable-next-line no-alert
      alert('Public message required when this update is marked public.');
      return;
    }
    append.mutate(
      {
        message: updateMessage.trim(),
        public_message: updatePublic ? updatePublicMessage.trim() : undefined,
        status: updateStatus || undefined,
        visibility: updatePublic ? 'public' : 'internal',
      },
      {
        onSuccess: () => {
          setUpdateMessage('');
          setUpdatePublicMessage('');
          setUpdateStatus('');
          setUpdatePublic(false);
        },
      },
    );
  };

  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <Link to="/admin/incidents" style={{
        fontFamily: 'var(--font-mono)', fontSize: 11,
        color: 'var(--text-tertiary)', textDecoration: 'none',
      }}>
        ← All incidents
      </Link>

      <PageHeader
        title={incident.title}
        subtitle={`Created ${new Date(incident.created_at).toLocaleString()} · Source: ${incident.source}`}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge severity={SEVERITY_TO_BADGE[incident.severity]} />
        <span
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            padding: '4px 10px', borderRadius: 100,
            background: STATUS_PILL_BG[incident.status],
            color: STATUS_PILL_TEXT[incident.status],
          }}
        >
          {incident.status}
        </span>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: incident.visibility === 'public' ? 'var(--amber)' : 'var(--text-tertiary)',
        }}>
          {incident.visibility}
        </span>
        {incident.affected_components.length > 0 && (
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 11,
            color: 'var(--text-tertiary)',
          }}>
            {incident.affected_components.join(' · ')}
          </span>
        )}
      </div>

      {/* Status transition row — quick one-click moves.
          R8 migration: replaced an inline map of buttons (with per-
          status color highlighting on the current state) with the
          shared StateMachineButtons primitive (Bundle C session 1).
          The visual trade-off: current state now always renders in
          amber rather than using the per-status color (red for
          investigating, orange for identified, etc.). The current-
          state severity is still conveyed elsewhere on the page via
          the Severity Badge in the header, so we don't lose
          information — we gain platform-wide consistency. */}
      <Card style={{ padding: 14 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 8, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Quick transition
        </div>
        <StateMachineButtons<IncidentStatus>
          states={STATUSES.map((s) => ({ value: s, label: s }))}
          current={incident.status}
          onTransition={(next) => transition.mutate(next)}
          busy={transition.isPending}
          size="sm"
        />
      </Card>

      {/* Append-update form */}
      <Card style={{ padding: 14 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 8, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Add update
        </div>
        <textarea
          value={updateMessage}
          onChange={(e) => setUpdateMessage(e.target.value)}
          placeholder="What happened, what's next?"
          rows={3}
          style={{
            width: '100%',
            fontFamily: 'var(--font-mono)', fontSize: 13,
            background: 'rgba(0,0,0,0.20)',
            border: '1px solid var(--border-base)',
            borderRadius: 6, padding: 10,
            color: 'var(--text-primary)', resize: 'vertical',
          }}
        />
        {/* Customer-safe public copy. Only shown / required when the
            operator marked the row public — internal updates skip
            this. Backend rejects visibility=public without a
            non-empty public_message. */}
        {updatePublic && (
          <textarea
            value={updatePublicMessage}
            onChange={(e) => setUpdatePublicMessage(e.target.value)}
            placeholder="Customer-safe public version (no feed names, internal terminology, or commit hashes; ≤1000 chars)"
            maxLength={1000}
            rows={2}
            style={{
              width: '100%',
              fontFamily: 'var(--font-mono)', fontSize: 13,
              background: 'rgba(229,168,50,0.06)',
              border: '1px solid rgba(229,168,50,0.30)',
              borderRadius: 6, padding: 10, marginTop: 8,
              color: 'var(--text-primary)', resize: 'vertical',
            }}
          />
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <select
            value={updateStatus}
            onChange={(e) => setUpdateStatus(e.target.value as IncidentStatus | '')}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 11,
              background: 'rgba(0,0,0,0.20)',
              border: '1px solid var(--border-base)',
              borderRadius: 6, padding: '6px 10px',
              color: 'var(--text-primary)',
            }}
          >
            <option value="">Don't change status</option>
            {STATUSES.map((s) => <option key={s} value={s}>Transition: {s}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={updatePublic} onChange={(e) => setUpdatePublic(e.target.checked)} />
            Mark this update public
          </label>
          <Button
            onClick={handleAppend}
            disabled={
              !updateMessage.trim() ||
              append.isPending ||
              (updatePublic && !updatePublicMessage.trim())
            }
          >
            Post update
          </Button>
        </div>
      </Card>

      {/* Public promotion drawer */}
      <Card style={{ padding: 14 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 8, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Public visibility
        </div>
        <input
          type="text"
          value={draftPublicTitle}
          onChange={(e) => setPublicTitle(e.target.value)}
          placeholder="Customer-safe title (≤200 chars)"
          maxLength={200}
          style={{
            width: '100%',
            fontFamily: 'var(--font-mono)', fontSize: 13,
            background: 'rgba(0,0,0,0.20)',
            border: '1px solid var(--border-base)',
            borderRadius: 6, padding: 10,
            color: 'var(--text-primary)', marginBottom: 8,
          }}
        />
        <textarea
          value={draftPublicDetails}
          onChange={(e) => setPublicDetails(e.target.value)}
          placeholder="Customer-safe details — sanitized, no internal jargon (≤2000 chars)"
          maxLength={2000}
          rows={3}
          style={{
            width: '100%',
            fontFamily: 'var(--font-mono)', fontSize: 13,
            background: 'rgba(0,0,0,0.20)',
            border: '1px solid var(--border-base)',
            borderRadius: 6, padding: 10,
            color: 'var(--text-primary)', resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {incident.visibility === 'internal' ? (
            <Button
              variant="primary"
              onClick={() => promote.mutate({
                visibility: 'public',
                public_title: draftPublicTitle || null,
                public_details: draftPublicDetails || null,
              })}
              disabled={!draftPublicTitle.trim() || promote.isPending}
            >
              Promote to public
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => promote.mutate({
                  public_title: draftPublicTitle || null,
                  public_details: draftPublicDetails || null,
                })}
                disabled={promote.isPending}
              >
                Save public copy
              </Button>
              <Button
                variant="danger"
                onClick={() => promote.mutate({ visibility: 'internal' })}
                disabled={promote.isPending}
              >
                Demote to internal
              </Button>
            </>
          )}
        </div>
      </Card>

      {/* Timeline */}
      <Card style={{ padding: 14 }}>
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 10,
          color: 'var(--text-tertiary)', marginBottom: 12,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>Timeline ({updates.length})</span>
          {(data.telemetry_count ?? 0) > 0 && (
            <span style={{ color: 'var(--text-tertiary)', textTransform: 'none', letterSpacing: '0.02em', fontSize: 10 }}>
              {data.telemetry_count} live telemetry events
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {updates.length === 0 ? (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
              No updates yet.
            </div>
          ) : updates.map((u) => {
            // Three glyph buckets:
            //   ↯  synthetic telemetry (read-time merge of raw events)
            //   ·  stored system update (auto-create, status transition,
            //      auto-resolve sweep)
            //   ✎  operator-written
            const glyph = u.synthetic ? '↯' : u.kind === 'system' ? '·' : '✎';
            const glyphColor = u.synthetic
              ? 'var(--blue, #0A8AB5)'
              : u.kind === 'system' ? 'var(--text-tertiary)' : 'var(--amber)';
            return (
            <div
              key={u.id}
              style={{
                display: 'flex',
                gap: 10,
                padding: '8px 0',
                borderBottom: '1px dashed var(--border-base)',
                opacity: u.synthetic ? 0.85 : 1,
              }}
            >
              <span style={{
                width: 16, flexShrink: 0,
                fontFamily: 'var(--font-mono)', fontSize: 12,
                color: glyphColor,
                textAlign: 'center',
              }}>
                {glyph}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10,
                  color: 'var(--text-tertiary)',
                  marginBottom: 2,
                  letterSpacing: '0.04em',
                  display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline',
                }}>
                  <span>{new Date(u.created_at).toLocaleString()}</span>
                  {u.status && (
                    <span style={{
                      color: STATUS_PILL_TEXT[u.status], fontWeight: 700,
                      textTransform: 'uppercase', fontSize: 9,
                    }}>
                      → {u.status}
                    </span>
                  )}
                  {u.visibility === 'public' && (
                    <span style={{ color: 'var(--amber)', fontWeight: 700, fontSize: 9, letterSpacing: '0.08em' }}>
                      PUBLIC
                    </span>
                  )}
                </div>
                <div style={{
                  fontSize: 13, color: u.kind === 'system' ? 'var(--text-secondary)' : 'var(--text-primary)',
                  lineHeight: 1.5,
                }}>
                  {u.message}
                </div>
                {/* Show what we're actually rendering on /status, so
                    the operator can spot leaks before customers do. */}
                {u.public_message && editingUpdateId !== u.id && (
                  <div style={{
                    marginTop: 6,
                    padding: '6px 10px',
                    background: 'rgba(229,168,50,0.06)',
                    border: '1px solid rgba(229,168,50,0.20)',
                    borderRadius: 4,
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    <span style={{ color: 'var(--amber)', fontWeight: 700, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', marginRight: 6 }}>Public</span>
                    {u.public_message}
                  </div>
                )}
                {/* Inline public-copy editor — works for operator AND
                    system rows. Synthetic telemetry rows skip this
                    (their id is "telemetry:..." which isn't in the
                    incident_updates table). */}
                {editingUpdateId === u.id ? (
                  <div style={{ marginTop: 8 }}>
                    <textarea
                      value={editingDraft}
                      onChange={(e) => setEditingDraft(e.target.value)}
                      placeholder="Customer-safe public version (no feed names, internal terminology, or commit hashes; ≤1000 chars)"
                      maxLength={1000}
                      rows={2}
                      style={{
                        width: '100%',
                        fontFamily: 'var(--font-mono)', fontSize: 12,
                        background: 'rgba(229,168,50,0.06)',
                        border: '1px solid rgba(229,168,50,0.30)',
                        borderRadius: 4, padding: 8,
                        color: 'var(--text-primary)', resize: 'vertical',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <Button
                        onClick={() => {
                          editPublicCopy.mutate(
                            {
                              updateId: u.id,
                              public_message: editingDraft.trim() || null,
                              visibility: editingDraft.trim() ? 'public' : 'internal',
                            },
                            { onSuccess: () => { setEditingUpdateId(null); setEditingDraft(''); } },
                          );
                        }}
                        disabled={editPublicCopy.isPending}
                      >
                        Save
                      </Button>
                      {u.public_message && (
                        <Button
                          variant="danger"
                          onClick={() => {
                            editPublicCopy.mutate(
                              { updateId: u.id, public_message: null, visibility: 'internal' },
                              { onSuccess: () => { setEditingUpdateId(null); setEditingDraft(''); } },
                            );
                          }}
                          disabled={editPublicCopy.isPending}
                        >
                          Clear public
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        onClick={() => { setEditingUpdateId(null); setEditingDraft(''); }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  // Show the edit affordance for stored rows only.
                  // Telemetry-synthetic rows have ids like "telemetry:..."
                  // which we can't PATCH against incident_updates.
                  !u.synthetic && (
                    <div style={{ marginTop: 4 }}>
                      <button
                        onClick={() => {
                          setEditingUpdateId(u.id);
                          setEditingDraft(u.public_message ?? '');
                        }}
                        style={{
                          fontFamily: 'var(--font-mono)', fontSize: 10,
                          color: 'var(--text-tertiary)',
                          background: 'transparent', border: 'none',
                          cursor: 'pointer', padding: 0,
                          letterSpacing: '0.04em',
                        }}
                      >
                        {u.public_message ? 'Edit public copy' : 'Add public copy'}
                      </button>
                    </div>
                  )
                )}
              </div>
            </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
