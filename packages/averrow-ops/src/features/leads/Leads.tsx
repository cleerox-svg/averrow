import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLeads, useLeadStats, useEnrichLead, useUpdateLead, useRefreshLeadFirmographics } from '@/hooks/useLeads';
import type { SalesLead, LeadStats } from '@/hooks/useLeads';
import { ScanLeadsView } from '@/features/scan-leads/ScanLeads';
import {
  Card,
  Badge,
  Button,
  StatCard,
  StatGrid,
  SectionLabel,
  Select,
  PageHeader,
  FilterBar,
} from '@/design-system/components';
import { Table, Th, Td } from '@/components/ui/Table';
import { TableLoader } from '@/components/ui/PageLoader';
import { DrillHeader } from '@/components/mobile/DrillHeader';
import { useToast } from '@/components/ui/Toast';
import { relativeTime } from '@/lib/time';
import { Target, AlertTriangle } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { BIMIGradeBadge } from '@/components/ui/BIMIGradeBadge';
import { AgentAttribution } from '@/components/ui/AgentAttribution';
import { ScoreChip } from './components/ScoreChip';
import { FirmographicsCard } from './components/FirmographicsCard';
import { BuyingSignalsCard } from './components/BuyingSignalsCard';
import { ScoreBreakdownCard } from './components/ScoreBreakdownCard';

const PIPELINE_STATUSES = ['new', 'researched', 'drafted', 'approved', 'sent', 'responded', 'meeting', 'converted'] as const;

function columnLabel(s: string) {
  return s.replace(/_/g, ' ').toUpperCase();
}

function gradeVariant(grade: string | null): 'critical' | 'high' | 'medium' | 'low' | 'success' {
  if (!grade) return 'low';
  const g = grade.toUpperCase();
  if (g === 'F') return 'critical';
  if (g === 'D' || g === 'D+' || g === 'D-') return 'high';
  if (g === 'C' || g === 'C+' || g === 'C-') return 'medium';
  if (g === 'B' || g === 'B+' || g === 'B-') return 'low';
  return 'success'; // A, A+
}

function parseOutreach(raw: string | null): { subject: string; body: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { subject?: string; body?: string };
    if (parsed.subject && parsed.body) return { subject: parsed.subject, body: parsed.body };
  } catch {
    // Not JSON — treat as plain text
    return { subject: '', body: raw };
  }
  return null;
}

// ─── Kanban View ────────────────────────────────────────────────

function hasRecentBreach(lead: SalesLead): boolean {
  if (!lead.last_breach_disclosed_at) return false;
  const ms = Date.parse(lead.last_breach_disclosed_at);
  if (!Number.isFinite(ms)) return false;
  return (Date.now() - ms) / 86_400_000 <= 180;
}

function KanbanCard({ lead, onClick }: { lead: SalesLead; onClick: () => void }) {
  const breach = hasRecentBreach(lead);
  // Prefer the canonical revenue band from brand_firmographics; fall back to
  // Haiku's AI-derived company_size category when SEC/Wikidata data is sparse.
  const sizeChip = lead.revenue_band ?? lead.employee_band ?? lead.company_size;

  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={e => e.key === 'Enter' && onClick()} className="cursor-pointer">
      <Card className="!p-3 space-y-2" variant={breach ? 'critical' : 'base'}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-display font-semibold text-sm truncate" style={{ color: 'var(--text-primary)' }}>
              {lead.company_name ?? 'Unnamed Lead'}
            </div>
            <div className="font-mono text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>
              {lead.company_domain ?? '—'}
            </div>
          </div>
          <ScoreChip score={lead.prospect_score} size="sm" />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {sizeChip && (
            <Badge variant="info" className="!text-[9px]">{sizeChip}</Badge>
          )}
          {lead.is_public === 1 && lead.ticker && (
            <Badge variant="success" className="!text-[9px]">{lead.ticker}</Badge>
          )}
          {lead.email_security_grade && (
            <BIMIGradeBadge grade={lead.email_security_grade} size="sm" tooltip />
          )}
          {breach && (
            <Badge variant="critical" className="!text-[9px]">
              <AlertTriangle className="w-2.5 h-2.5 inline mr-0.5" />
              Breach
            </Badge>
          )}
        </div>

        <div className="flex items-center justify-between text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
          <span>{lead.threat_count_30d ?? 0} threats/30d</span>
          {lead.ai_enriched === 1 && <span className="text-positive/70">✓ Enriched</span>}
        </div>
      </Card>
    </div>
  );
}

function KanbanView({ leads, onSelect }: { leads: SalesLead[]; onSelect: (lead: SalesLead) => void }) {
  const grouped = PIPELINE_STATUSES.reduce<Record<string, SalesLead[]>>((acc, col) => {
    acc[col] = leads.filter(l => l.status === col);
    return acc;
  }, {} as Record<string, SalesLead[]>);

  // Page-level empty state when the pipeline is fully empty. Previously
  // each of the 8 columns rendered an identical EmptyState, training the
  // eye to ignore the kanban. Now we show one CTA at the top.
  if (leads.length === 0) {
    return (
      <EmptyState
        icon={<Target />}
        title="No leads yet"
        subtitle="Run Pathfinder to qualify brands from the threat data. Pathfinder scores brands on email security, active threats, social impersonation, recent breach disclosures, and SEC 10-K cybersecurity mentions."
        variant="scanning"
      />
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4 -mx-2 px-2">
      {PIPELINE_STATUSES.map(col => {
        const inColumn = grouped[col] ?? [];
        return (
          <div key={col} className="min-w-[240px] max-w-[280px] flex-shrink-0">
            <div className="flex items-center gap-2 mb-3">
              <SectionLabel>{columnLabel(col)}</SectionLabel>
              <Badge variant={inColumn.length > 0 ? 'info' : 'default'}>{inColumn.length}</Badge>
            </div>
            <div className="space-y-2">
              {inColumn.length === 0 ? (
                <div
                  className="text-center py-3 font-mono text-[10px]"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  —
                </div>
              ) : (
                inColumn.map(lead => (
                  <KanbanCard key={lead.id} lead={lead} onClick={() => onSelect(lead)} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Pipeline Table View ────────────────────────────────────────

function getPipelineCount(stats: LeadStats['pipeline'], status: string): number {
  const map: Record<string, keyof LeadStats['pipeline']> = {
    new: 'new_count',
    researched: 'researched_count',
    drafted: 'drafted_count',
    approved: 'approved_count',
    sent: 'sent_count',
    responded: 'responded_count',
    meeting: 'meeting_count',
    converted: 'converted_count',
  };
  const key = map[status];
  return key ? (stats[key] as number) ?? 0 : 0;
}

function PipelineView({ leads, stats, onSelect }: { leads: SalesLead[]; stats: LeadStats | null; onSelect: (lead: SalesLead) => void }) {
  const [statusFilter, setStatusFilter] = useState('');
  const [pitchFilter, setPitchFilter] = useState('');
  const [revenueFilter, setRevenueFilter] = useState('');
  const [publicFilter, setPublicFilter] = useState('');
  // Special filter keys (signals): 'breach' = lead has a breach disclosed
  // in the last 180 days. 'ciso' = lead has a CISO LinkedIn URL. These are
  // top-of-funnel-quality filters for picking the best outreach targets.
  const [signalFilter, setSignalFilter] = useState('');
  const [search, setSearch] = useState('');

  const filtered = leads.filter(l => {
    if (statusFilter && l.status !== statusFilter) return false;
    if (pitchFilter && l.pitch_angle !== pitchFilter) return false;
    if (revenueFilter && l.revenue_band !== revenueFilter) return false;
    if (publicFilter === 'public'  && l.is_public !== 1) return false;
    if (publicFilter === 'private' && l.is_public !== 0) return false;
    if (signalFilter === 'breach' && !hasRecentBreach(l)) return false;
    if (signalFilter === 'ciso'   && !l.target_linkedin) return false;
    if (signalFilter === '10k'    && !(l.cyber_10k_mentions && l.cyber_10k_mentions >= 5)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        l.company_name?.toLowerCase().includes(q) ||
        l.company_domain?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const pitchAngles = [...new Set(leads.map(l => l.pitch_angle).filter(Boolean))] as string[];
  const revenueBands = [...new Set(leads.map(l => l.revenue_band).filter(Boolean))] as string[];

  return (
    <div className="space-y-6">
      {stats && (
        <>
          <StatGrid cols={4}>
            {PIPELINE_STATUSES.map(s => (
              <StatCard key={s} label={s} value={getPipelineCount(stats.pipeline, s)} />
            ))}
          </StatGrid>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase" style={{ color: 'var(--text-tertiary)' }}>Response Rate</span>
                <span className="font-mono text-xs" style={{ color: 'var(--text-primary)' }}>{(stats.response_rate ?? 0).toFixed(1)}%</span>
              </div>
              <div className="w-full h-2 bg-white/5 rounded overflow-hidden">
                <div className="h-full rounded" style={{ background: 'var(--green)', width: `${stats.response_rate ?? 0}%` }} />
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase" style={{ color: 'var(--text-tertiary)' }}>Conversion Rate</span>
                <span className="font-mono text-xs" style={{ color: 'var(--text-primary)' }}>{(stats.conversion_rate ?? 0).toFixed(1)}%</span>
              </div>
              <div className="w-full h-2 bg-white/5 rounded overflow-hidden">
                <div className="h-full rounded" style={{ background: 'var(--amber)', width: `${stats.conversion_rate ?? 0}%` }} />
              </div>
            </div>
          </div>
        </>
      )}

      <FilterBar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search company or domain...',
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            options={[
              { value: '', label: 'All Statuses' },
              ...PIPELINE_STATUSES.map(s => ({ value: s, label: columnLabel(s) })),
            ]}
          />
          <Select
            value={pitchFilter}
            onChange={e => setPitchFilter(e.target.value)}
            options={[
              { value: '', label: 'All Pitch Angles' },
              ...pitchAngles.map(p => ({ value: p, label: p.replace(/_/g, ' ') })),
            ]}
          />
          <Select
            value={revenueFilter}
            onChange={e => setRevenueFilter(e.target.value)}
            options={[
              { value: '', label: 'Any Revenue' },
              ...revenueBands.map(r => ({ value: r, label: r })),
            ]}
          />
          <Select
            value={publicFilter}
            onChange={e => setPublicFilter(e.target.value)}
            options={[
              { value: '',        label: 'Public + Private' },
              { value: 'public',  label: 'Public only' },
              { value: 'private', label: 'Private only' },
            ]}
          />
          <Select
            value={signalFilter}
            onChange={e => setSignalFilter(e.target.value)}
            options={[
              { value: '',       label: 'Any Signal' },
              { value: 'breach', label: 'Recent breach (180d)' },
              { value: 'ciso',   label: 'Has CISO contact' },
              { value: '10k',    label: '10-K cyber (5+ mentions)' },
            ]}
          />
        </div>
      </FilterBar>

      <div className="overflow-x-auto">
        <Card hover={false} className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Company</Th>
                <Th>Domain</Th>
                <Th>Score</Th>
                <Th>Revenue</Th>
                <Th>Public</Th>
                <Th>Grade</Th>
                <Th>Threats</Th>
                <Th>Signals</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(lead => {
                const breach = hasRecentBreach(lead);
                return (
                  <tr
                    key={lead.id}
                    className="data-row"
                    onClick={() => onSelect(lead)}
                  >
                    <Td>
                      <span className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                        {lead.company_name ?? 'Unnamed'}
                      </span>
                    </Td>
                    <Td>
                      <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {lead.company_domain ?? '—'}
                      </span>
                    </Td>
                    <Td>
                      <ScoreChip score={lead.prospect_score} size="sm" />
                    </Td>
                    <Td>
                      {lead.revenue_band ? (
                        <Badge variant="info" className="text-[9px]">{lead.revenue_band}</Badge>
                      ) : lead.company_size ? (
                        <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          {lead.company_size}
                        </span>
                      ) : '—'}
                    </Td>
                    <Td>
                      {lead.is_public === 1 ? (
                        <Badge variant="success" className="text-[9px]">
                          {lead.ticker ?? 'Public'}
                        </Badge>
                      ) : lead.is_public === 0 ? (
                        <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>Private</span>
                      ) : '—'}
                    </Td>
                    <Td>
                      {lead.email_security_grade ? (
                        <Badge variant={gradeVariant(lead.email_security_grade)}>
                          {lead.email_security_grade}
                        </Badge>
                      ) : '—'}
                    </Td>
                    <Td>
                      <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {lead.threat_count_30d ?? '—'}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {breach && (
                          <Badge variant="critical" className="text-[9px]">
                            <AlertTriangle className="w-2.5 h-2.5 inline mr-0.5" />
                            Breach
                          </Badge>
                        )}
                        {lead.target_linkedin && (
                          <Badge variant="info" className="text-[9px]">CISO</Badge>
                        )}
                        {lead.cyber_10k_mentions != null && lead.cyber_10k_mentions >= 5 && (
                          <Badge variant="medium" className="text-[9px]">10-K</Badge>
                        )}
                        {!breach && !lead.target_linkedin && !(lead.cyber_10k_mentions && lead.cyber_10k_mentions >= 5) && (
                          <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>—</span>
                        )}
                      </div>
                    </Td>
                    <Td><Badge variant="default">{columnLabel(lead.status)}</Badge></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {filtered.length === 0 && (
            <p className="text-sm text-white/40 text-center py-8">No leads match the current filters.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── Lead Detail View ───────────────────────────────────────────

// Inline editor for one outreach variant. Subject stays read-only (rare to
// edit); body is a textarea so a rep can tweak the AI draft before send.
// `hasDraft` flips on the Save button when the body differs from what's
// persisted — keeps the visual signal clear without tracking diffs.
function OutreachEditor({
  subject, body, hasDraft, onChange, onSave, onCopy, saving,
}: {
  subject: string;
  body: string;
  hasDraft: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onCopy: () => void;
  saving: boolean;
}) {
  return (
    <div className="space-y-3">
      {subject && (
        <div>
          <span className="font-mono text-[10px] text-white/55 uppercase">Subject</span>
          <p className="text-sm font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>{subject}</p>
        </div>
      )}
      <div>
        <span className="font-mono text-[10px] text-white/55 uppercase">Body</span>
        <textarea
          value={body}
          onChange={e => onChange(e.target.value)}
          rows={Math.min(20, Math.max(8, body.split('\n').length + 1))}
          className="mt-1 w-full font-sans text-sm leading-relaxed rounded-md p-3 resize-y"
          style={{
            background: 'var(--bg-page)',
            border: '1px solid var(--border-base)',
            color: 'var(--text-primary)',
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button variant={hasDraft ? 'primary' : 'secondary'} size="sm" onClick={onSave} disabled={!hasDraft || saving}>
          {saving ? 'Saving...' : hasDraft ? 'Save Edits' : 'Saved'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCopy}>
          Copy
        </Button>
      </div>
    </div>
  );
}

function LeadDetail({ lead, onBack }: { lead: SalesLead; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<'variant1' | 'variant2'>('variant1');
  // Local edit buffers for outreach variants so a rep can tweak before copying / sending.
  // null = use the persisted value as-is; a string = unsaved local override.
  const [draft1, setDraft1] = useState<string | null>(null);
  const [draft2, setDraft2] = useState<string | null>(null);
  const updateLead = useUpdateLead();
  const refreshFirmographics = useRefreshLeadFirmographics();
  const { showToast } = useToast();

  const outreach1 = parseOutreach(lead.outreach_variant_1);
  const outreach2 = parseOutreach(lead.outreach_variant_2);

  function handleStatusChange(newStatus: string) {
    updateLead.mutate({ id: lead.id, status: newStatus }, {
      onSuccess: () => showToast(`Lead moved to ${newStatus}`, 'success'),
      onError: () => showToast('Failed to update status', 'error'),
    });
  }

  function handleRefreshFirmographics() {
    refreshFirmographics.mutate(lead.id, {
      onSuccess: () => showToast('Firmographics refreshed from SEC/Wikidata', 'success'),
      onError: () => showToast('Refresh failed', 'error'),
    });
  }

  function saveOutreach(which: 'variant1' | 'variant2', body: string) {
    const subject = which === 'variant1' ? outreach1?.subject ?? '' : outreach2?.subject ?? '';
    const payload = JSON.stringify({ subject, body });
    const field = which === 'variant1' ? 'outreach_variant_1' : 'outreach_variant_2';
    updateLead.mutate(
      { id: lead.id, [field]: payload },
      {
        onSuccess: () => {
          showToast(`Saved ${which}`, 'success');
          if (which === 'variant1') setDraft1(null);
          else setDraft2(null);
        },
        onError: () => showToast('Save failed', 'error'),
      },
    );
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Copied to clipboard', 'success'),
      () => showToast('Failed to copy', 'error'),
    );
  }

  return (
    <div className="animate-fade-in">
      <DrillHeader
        title={lead.company_name ?? 'Lead Detail'}
        badge={lead.email_security_grade ? `Grade ${lead.email_security_grade}` : undefined}
        onBack={onBack}
      />

      <div className="pt-14 space-y-6">
        {/* Subtitle */}
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
          {lead.company_domain && <span>{lead.company_domain}</span>}
          {lead.company_domain && <span>·</span>}
          <span>Score: <span className="font-bold" style={{ color: 'var(--amber)' }}>{Math.round(lead.prospect_score)}</span></span>
          {lead.email_security_grade && (
            <>
              <span>·</span>
              <span>Grade: </span>
              <Badge variant={gradeVariant(lead.email_security_grade)} className="text-[8px] py-0 px-1.5">
                {lead.email_security_grade}
              </Badge>
            </>
          )}
        </div>

        {/* Overview Stats */}
        <StatGrid cols={4}>
          <StatCard label="Prospect Score" value={Math.round(lead.prospect_score)} accentColor="#E5A832" />
          <StatCard
            label="Email Grade"
            value={lead.email_security_grade ?? '—'}
            accentColor={lead.email_security_grade === 'F' ? '#C83C3C' : lead.email_security_grade === 'C' ? '#FB923C' : '#0A8AB5'}
          />
          <StatCard label="Threats / 30d" value={lead.threat_count_30d ?? 0} accentColor="#C83C3C" />
          <StatCard label="Status" value={columnLabel(lead.status)} />
        </StatGrid>

        {/* Firmographics + Buying Signals — the two cards that answer
            "is this company worth pursuing?" for an outbound rep. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <FirmographicsCard
            lead={lead}
            onRefresh={handleRefreshFirmographics}
            refreshing={refreshFirmographics.isPending}
          />
          <BuyingSignalsCard lead={lead} />
        </div>

        {/* Score breakdown — "why is this score what it is?" */}
        <ScoreBreakdownCard breakdownJson={lead.score_breakdown_json} totalScore={lead.prospect_score} />

        {/* AI Findings */}
        <Card hover={false}>
          <SectionLabel className="mb-3">AI Findings</SectionLabel>
          <AgentAttribution agent="Pathfinder" />
          {lead.findings_summary ? (
            <p className="text-sm leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-primary)' }}>
              {lead.findings_summary}
            </p>
          ) : (
            <p className="text-sm text-white/40 italic">No AI findings yet. Enrich this lead to generate analysis.</p>
          )}
        </Card>

        {/* Outreach Emails — editable textarea so a rep can tweak the AI draft
            before sending. Subject stays as-is (rare to need editing); body is
            where the personalization happens. */}
        {lead.ai_enriched === 1 && (outreach1 || outreach2) && (
          <Card hover={false}>
            <SectionLabel className="mb-3">Outreach Emails</SectionLabel>
            <div className="flex gap-2 mb-4">
              {outreach1 && (
                <Button
                  variant={activeTab === 'variant1' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setActiveTab('variant1')}
                >
                  Variant 1
                </Button>
              )}
              {outreach2 && (
                <Button
                  variant={activeTab === 'variant2' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setActiveTab('variant2')}
                >
                  Variant 2
                </Button>
              )}
            </div>
            {activeTab === 'variant1' && outreach1 && (
              <OutreachEditor
                subject={outreach1.subject}
                body={draft1 ?? outreach1.body}
                hasDraft={draft1 !== null && draft1 !== outreach1.body}
                onChange={setDraft1}
                onSave={() => saveOutreach('variant1', draft1 ?? outreach1.body)}
                onCopy={() => copyToClipboard(`Subject: ${outreach1.subject}\n\n${draft1 ?? outreach1.body}`)}
                saving={updateLead.isPending}
              />
            )}
            {activeTab === 'variant2' && outreach2 && (
              <OutreachEditor
                subject={outreach2.subject}
                body={draft2 ?? outreach2.body}
                hasDraft={draft2 !== null && draft2 !== outreach2.body}
                onChange={setDraft2}
                onSave={() => saveOutreach('variant2', draft2 ?? outreach2.body)}
                onCopy={() => copyToClipboard(`Subject: ${outreach2.subject}\n\n${draft2 ?? outreach2.body}`)}
                saving={updateLead.isPending}
              />
            )}
          </Card>
        )}

        {/* Contact Info — primary outreach target. Buying-signals card surfaces
            the CISO LinkedIn already; this card is for manual override + email +
            additional context the AI didn't capture. */}
        <Card hover={false}>
          <SectionLabel className="mb-3">Contact</SectionLabel>
          {lead.target_name ? (
            <div className="space-y-2 text-sm">
              <div className="flex gap-2">
                <span className="font-mono text-[10px] uppercase w-16" style={{ color: 'var(--text-tertiary)' }}>Name</span>
                <span style={{ color: 'var(--text-primary)' }}>{lead.target_name}</span>
              </div>
              {lead.target_title && (
                <div className="flex gap-2">
                  <span className="font-mono text-[10px] uppercase w-16" style={{ color: 'var(--text-tertiary)' }}>Title</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{lead.target_title}</span>
                </div>
              )}
              {lead.target_email && (
                <div className="flex gap-2">
                  <span className="font-mono text-[10px] uppercase w-16" style={{ color: 'var(--text-tertiary)' }}>Email</span>
                  <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{lead.target_email}</span>
                </div>
              )}
              {lead.target_linkedin && (
                <div className="flex gap-2">
                  <span className="font-mono text-[10px] uppercase w-16" style={{ color: 'var(--text-tertiary)' }}>LinkedIn</span>
                  <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{lead.target_linkedin}</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-white/40 italic">Not yet researched</p>
          )}
        </Card>

        {/* Actions */}
        <Card hover={false}>
          <SectionLabel className="mb-3">Actions</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {lead.status === 'new' && (
              <Button variant="secondary" size="sm" onClick={() => handleStatusChange('researched')} disabled={updateLead.isPending}>
                Mark as Researched
              </Button>
            )}
            {lead.status === 'researched' && (
              <Button variant="secondary" size="sm" onClick={() => handleStatusChange('drafted')} disabled={updateLead.isPending}>
                Draft Outreach
              </Button>
            )}
            {lead.status === 'drafted' && (
              <Button variant="primary" size="sm" onClick={() => handleStatusChange('approved')} disabled={updateLead.isPending}>
                Approve
              </Button>
            )}
            {lead.status === 'approved' && (
              <Button variant="primary" size="sm" onClick={() => handleStatusChange('sent')} disabled={updateLead.isPending}>
                Mark as Sent
              </Button>
            )}
            {lead.status === 'sent' && (
              <Button variant="secondary" size="sm" onClick={() => handleStatusChange('responded')} disabled={updateLead.isPending}>
                Mark Responded
              </Button>
            )}
            {lead.status === 'responded' && (
              <Button variant="secondary" size="sm" onClick={() => handleStatusChange('meeting')} disabled={updateLead.isPending}>
                Book Meeting
              </Button>
            )}
            {lead.status === 'meeting' && (
              <Button variant="primary" size="sm" onClick={() => handleStatusChange('converted')} disabled={updateLead.isPending}>
                Convert
              </Button>
            )}
          </div>
          <div className="mt-2 font-mono text-[10px] text-white/50">
            Created {relativeTime(lead.created_at)} · Updated {relativeTime(lead.updated_at)}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── Enrich Leads Tab ───────────────────────────────────────────

function EnrichView({ leads }: { leads: SalesLead[] }) {
  const enrichLead = useEnrichLead();
  const { showToast } = useToast();

  const unenriched = leads.filter(l => l.ai_enriched !== 1);
  const enriched = leads.filter(l => l.ai_enriched === 1);

  return (
    <div className="space-y-6">
      <StatGrid cols={3}>
        <StatCard label="Total Leads" value={leads.length} accentColor="#E5A832" />
        <StatCard label="AI Enriched" value={enriched.length} accentColor="#3CB878" />
        <StatCard label="Awaiting Enrichment" value={unenriched.length} accentColor="#0A8AB5" />
      </StatGrid>

      {unenriched.length > 0 && (
        <Card hover={false}>
          <div className="flex items-center justify-between mb-4">
            <SectionLabel>Un-enriched Leads</SectionLabel>
            <Button
              variant="primary"
              size="sm"
              onClick={() => enrichLead.mutate(undefined, {
                onSuccess: () => showToast('Lead enrichment triggered', 'success'),
                onError: () => showToast('Failed to trigger enrichment', 'error'),
              })}
              disabled={enrichLead.isPending}
            >
              {enrichLead.isPending ? 'Enriching...' : 'Enrich Next Lead'}
            </Button>
          </div>
          <div className="space-y-2">
            {unenriched.map(lead => (
              <div
                key={lead.id}
                className="flex items-center justify-between py-2 px-3 rounded-lg"
                style={{ background: 'var(--bg-page)', border: '1px solid var(--border-base)' }}
              >
                <div className="flex items-center gap-3">
                  <span className="font-display font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                    {lead.company_name ?? 'Unnamed'}
                  </span>
                  <span className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {lead.company_domain ?? ''}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-bold" style={{ color: 'var(--amber)' }}>{lead.prospect_score}</span>
                  {lead.email_security_grade && (
                    <Badge variant={gradeVariant(lead.email_security_grade)} className="text-[8px] py-0 px-1.5">
                      {lead.email_security_grade}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {unenriched.length === 0 && (
        <Card hover={false}>
          <p className="text-sm text-positive/70 text-center py-6 font-mono">
            All leads have been AI enriched.
          </p>
        </Card>
      )}
    </div>
  );
}

// ─── Main Leads Page ────────────────────────────────────────────

// Views available on the Leads page. `scan` is the public-scan
// funnel (scan_leads table) — distinct from kanban/pipeline/enrich
// which all read from sales_leads (Pathfinder).
type LeadsView = 'kanban' | 'pipeline' | 'enrich' | 'scan';

const LEADS_VIEW_VALUES: readonly LeadsView[] = ['kanban', 'pipeline', 'enrich', 'scan'] as const;

function isLeadsView(v: string | null): v is LeadsView {
  return v != null && (LEADS_VIEW_VALUES as readonly string[]).includes(v);
}

export function Leads() {
  // `?view=scan` opens the Scan Leads tab directly — used by the
  // sales notification email and the legacy /admin/scan-leads
  // redirect so deep links land in the right place.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialView = isLeadsView(searchParams.get('view')) ? (searchParams.get('view') as LeadsView) : 'kanban';
  const [activeView, setActiveView] = useState<LeadsView>(initialView);
  const [selectedLead, setSelectedLead] = useState<SalesLead | null>(null);
  const { data: leadsRes, isLoading } = useLeads();
  const { data: stats } = useLeadStats();

  const leads = useMemo(() => leadsRes?.data || [], [leadsRes]);

  function selectView(view: LeadsView) {
    setActiveView(view);
    // Keep the URL in sync so reload + share-link both work.
    // `kanban` is the default — strip the param to keep URLs clean.
    const next = new URLSearchParams(searchParams);
    if (view === 'kanban') next.delete('view');
    else next.set('view', view);
    setSearchParams(next, { replace: true });
  }

  // Sales-leads loader covers kanban/pipeline/enrich. The Scan
  // Leads tab loads its own data via useScanLeads(), so we don't
  // gate that view on this loader.
  if (isLoading && activeView !== 'scan') return <TableLoader rows={8} />;

  // Detail view (sales-leads only)
  if (selectedLead) {
    // Find fresh version of lead from data (in case it was updated)
    const freshLead = leads.find(l => l.id === selectedLead.id) ?? selectedLead;
    return <LeadDetail lead={freshLead} onBack={() => setSelectedLead(null)} />;
  }

  const subtitle = activeView === 'scan'
    ? 'Public scan funnel — leads from the homepage scan widget. Generate the Brand Risk Plan, send outreach, then convert to a tenant once qualified.'
    : 'Prospect pipeline powered by Pathfinder';

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Leads"
        subtitle={subtitle}
        actions={
          <>
            <Button
              variant={activeView === 'kanban' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => selectView('kanban')}
            >
              Kanban
            </Button>
            <Button
              variant={activeView === 'pipeline' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => selectView('pipeline')}
            >
              Sales Pipeline
            </Button>
            <Button
              variant={activeView === 'enrich' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => selectView('enrich')}
            >
              Enrich Leads
            </Button>
            <Button
              variant={activeView === 'scan' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => selectView('scan')}
            >
              Scan Leads
            </Button>
          </>
        }
      />

      {activeView === 'kanban' && (
        <KanbanView leads={leads} onSelect={setSelectedLead} />
      )}
      {activeView === 'pipeline' && (
        <PipelineView leads={leads} stats={stats ?? null} onSelect={setSelectedLead} />
      )}
      {activeView === 'enrich' && (
        <EnrichView leads={leads} />
      )}
      {activeView === 'scan' && (
        <ScanLeadsView />
      )}
    </div>
  );
}
