// PR-AA — Averrow self abuse-mailbox admin surface.
//
// Drinks-our-own-coolaid version of the tenant AbuseMailbox page,
// scoped to the synthetic `_averrow_platform` org seeded by migration
// 0180. Shows the public-facing aliases (abuse@/phishing@/report@/
// security@) advertised on the marketing report-abuse page, plus the
// classified inbox of submissions.
//
// Treated as a covert spam trap: every submission is a captured
// threat signal regardless of whether it's a legitimate report or an
// attacker probing the mailbox. The classifier handles both paths
// the same way — the operator sees everything.
//
// Auth: super_admin only. /admin/abuse-mailbox route.
// Design tokens per CLAUDE.md §5 + AVERROW_UI_STANDARD.md.

import { Fragment, useEffect, useState } from 'react';
import { Mail, MailCheck, MailX, Inbox, AlertTriangle, ShieldCheck, Copy, Check, ChevronDown } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Navigate, useLocation } from 'react-router-dom';
import { PageLoader } from '@/components/ui/PageLoader';
import {
  useAdminAbuseMailboxSummary,
  useAdminAbuseMailboxMessages,
  useAdminAbuseMailboxMessageDetail,
  useUnthrottleAbuseMessage,
  useUpdateAbuseMessageStatus,
  useBulkUpdateAbuseMessageStatus,
  useAdminAbuseMailboxIntel,
  type AdminAbuseAlias,
  type AdminAbuseMailboxTotals,
  type AdminAbuseInboxMessage,
  type AdminAbuseInboxMessageDetail,
  type AbuseMailboxIntel,
  type AbuseMessageStatus,
  type ExtractedUrl,
  type ExtractedAttachment,
} from '@/hooks/useAdminAbuseMailbox';
import { relativeTime } from '@/lib/time';

export function AdminAbuseMailbox() {
  const { isSuperAdmin, loading: authLoading } = useAuth();
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  // PR-AO: selected message id for inline drill-down. Toggling shows
  // the full detail panel below the matching row.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // PR-BD: client-side filtering state for the recent-messages list.
  // Backend returns up to 100 rows; the tabs/filters/search slice
  // that down to what the operator is currently looking at.
  const [statusTab, setStatusTab] = useState<'all' | AbuseMessageStatus>('all');
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  // Bulk triage — checkbox selection over the filtered list. Cleared
  // whenever the filters change so a hidden row can't be bulk-mutated.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const bulkUpdate = useBulkUpdateAbuseMessageStatus();
  useEffect(() => { setCheckedIds(new Set()); }, [statusTab, classFilter, searchText, activeBrand]);
  const summaryQ  = useAdminAbuseMailboxSummary();
  const messagesQ = useAdminAbuseMailboxMessages(activeBrand);
  const intelQ    = useAdminAbuseMailboxIntel();

  // Deep-link support — notification dispatcher sends users here
  // with `#msg-<id>` in the URL (abuse_mailbox_verdict notification,
  // see lib/abuse-mailbox-classifier.ts). Open the matching row on
  // mount + on hash change so subsequent in-app clicks also work.
  const location = useLocation();
  useEffect(() => {
    const hash = location.hash || (typeof window !== 'undefined' ? window.location.hash : '');
    const match = hash.match(/^#msg-(.+)$/);
    if (match) {
      setSelectedId(decodeURIComponent(match[1]!));
    }
  }, [location.hash]);

  // Scroll the opened row into view once the messages list resolves
  // — otherwise on a fresh load the user lands at the top and has
  // to hunt for the highlighted row.
  useEffect(() => {
    if (!selectedId || messagesQ.isLoading) return;
    const el = document.getElementById(`msg-${selectedId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedId, messagesQ.isLoading]);

  if (authLoading) return <PageLoader />;
  if (!isSuperAdmin) return <Navigate to="/" replace />;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Abuse Mailbox</h1>
          <p className="text-white/50 text-sm font-mono mt-1">
            AVERROW SELF · MARKETING-FACING ABUSE INTAKE · COVERT SPAM TRAP
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="dot-pulse dot-pulse-green" />
          <span className="text-xs font-mono text-white/50">LISTENING</span>
        </div>
      </div>

      {/* Description card — explains the "drink-our-own-coolaid" stance */}
      <div
        className="rounded-xl p-4"
        style={{
          background: 'var(--bg-card)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--border-base)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)',
        }}
      >
        <p className="text-sm text-white/85 leading-relaxed">
          The marketing site at <a className="text-[var(--amber)] hover:underline font-medium" href="https://averrow.com/report-abuse" target="_blank" rel="noreferrer">averrow.com/report-abuse</a> advertises public mailboxes for the same service we sell to customers. Every submission — phishing reports, impersonation tips, vulnerability disclosures, attacker probes — lands here, gets classified by Haiku, and feeds platform threat intelligence. We dogfood the abuse-mailbox module on ourselves.
        </p>
      </div>

      {/* Loading / error states */}
      {summaryQ.isLoading && (
        <div className="text-white/40 text-sm font-mono py-12 text-center">Loading mailbox…</div>
      )}
      {summaryQ.error && (
        <div
          className="rounded-xl p-4"
          style={{
            background: 'rgba(248,113,113,0.06)',
            border: '1px solid rgba(248,113,113,0.30)',
          }}
        >
          <h3 className="text-sm font-semibold text-white/90">Couldn't load abuse mailbox</h3>
          <p className="text-[12px] text-white/55 mt-1">
            {summaryQ.error.message ?? 'Unknown error'}
          </p>
          <p className="text-[11px] text-white/45 font-mono mt-2">
            If the response code is SELF_ORG_NOT_PROVISIONED, run migration 0180.
          </p>
        </div>
      )}

      {summaryQ.data && (
        <>
          {/* Alias card — all advertised mailboxes (one alias row but list all known) */}
          <AliasCard alias={summaryQ.data.alias} />

          {/* Stats strip */}
          <HeadlineMetrics totals={summaryQ.data.totals} unboundTotal={summaryQ.data.unbound.total} />

          {/* PR-BD — Intel highlights from deep_analysis aggregates */}
          {intelQ.data && <IntelHighlights intel={intelQ.data} />}

          {/* PR-BD — Inbox with tabs/filters/search */}
          <section className="space-y-3">
            <InboxToolbar
              messages={messagesQ.data?.messages ?? []}
              activeBrand={activeBrand}
              onClearBrand={() => setActiveBrand(null)}
              statusTab={statusTab}
              onStatusTabChange={setStatusTab}
              classFilter={classFilter}
              onClassFilterChange={setClassFilter}
              searchText={searchText}
              onSearchChange={setSearchText}
            />

            {messagesQ.isLoading && (
              <div className="text-white/40 text-sm font-mono py-8 text-center">Loading messages…</div>
            )}
            {messagesQ.data && (() => {
              const filtered = filterMessages(messagesQ.data.messages, statusTab, classFilter, searchText);
              if (messagesQ.data.messages.length === 0) return <EmptyMessages />;
              if (filtered.length === 0) {
                return (
                  <div className="text-white/45 text-[12px] font-mono py-12 text-center">
                    No messages match the current filters.
                  </div>
                );
              }
              const allChecked = filtered.length > 0 && filtered.every(m => checkedIds.has(m.id));
              const toggleAll = () => {
                setCheckedIds(allChecked ? new Set() : new Set(filtered.map(m => m.id)));
              };
              const toggleOne = (id: string) => {
                setCheckedIds(prev => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return next;
                });
              };
              const runBulk = (status: AbuseMessageStatus, label: string) => {
                const ids = [...checkedIds];
                if (ids.length === 0 || bulkUpdate.isPending) return;
                if (!window.confirm(`${label} ${ids.length} message${ids.length === 1 ? '' : 's'}?`)) return;
                bulkUpdate.mutate({ ids, status }, {
                  onSuccess: () => setCheckedIds(new Set()),
                });
              };
              return (
                <div className="space-y-2">
                  {/* Bulk-triage bar */}
                  <div className="flex items-center gap-3 flex-wrap px-1 py-1.5">
                    <label className="flex items-center gap-2 text-[11px] font-mono cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                      {checkedIds.size > 0 ? `${checkedIds.size} selected` : 'Select all'}
                    </label>
                    {checkedIds.size > 0 && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <BulkBtn label="Investigate" color="var(--sev-medium)"      disabled={bulkUpdate.isPending} onClick={() => runBulk('investigating', 'Move to investigating:')} />
                        <BulkBtn label="Resolve"     color="var(--green)"           disabled={bulkUpdate.isPending} onClick={() => runBulk('resolved', 'Resolve')} />
                        <BulkBtn label="Dismiss"     color="var(--text-secondary)"  disabled={bulkUpdate.isPending} onClick={() => runBulk('dismissed', 'Dismiss')} />
                        <button
                          type="button"
                          className="text-[10px] font-mono uppercase tracking-wider px-2 py-1.5 text-white/50 hover:text-white/80"
                          onClick={() => setCheckedIds(new Set())}
                        >
                          Clear
                        </button>
                        {bulkUpdate.isPending && (
                          <span className="text-[10px] font-mono text-white/50">Updating…</span>
                        )}
                        {bulkUpdate.isError && (
                          <span className="text-[10px] font-mono" style={{ color: 'var(--sev-critical)' }}>
                            {(bulkUpdate.error as Error).message}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {filtered.map((m) => (
                    <Fragment key={m.id}>
                      {/* id is the deep-link anchor target — notifications
                          send users here with `#msg-<id>` in the URL. The
                          checkbox sits OUTSIDE MessageRow (its root is a
                          <button>, which can't contain another control). */}
                      <div id={`msg-${m.id}`} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-4 shrink-0"
                          checked={checkedIds.has(m.id)}
                          onChange={() => toggleOne(m.id)}
                          aria-label={`Select message ${m.id.slice(0, 8)}`}
                        />
                        <div className="flex-1 min-w-0">
                          <MessageRow
                            message={m}
                            expanded={selectedId === m.id}
                            onToggle={() => setSelectedId(prev => prev === m.id ? null : m.id)}
                          />
                        </div>
                      </div>
                      {selectedId === m.id && <MessageDetail message={m} />}
                    </Fragment>
                  ))}
                </div>
              );
            })()}
          </section>
        </>
      )}
    </div>
  );
}

function AliasCard({ alias }: { alias: AdminAbuseAlias | null }) {
  const [copied, setCopied] = useState<string | null>(null);

  // Migration 0180 seeds rows for abuse@/phishing@/report@/security@
  // across four domains; the summary endpoint returns just one (any
  // row matching the org_id). Hardcode the public-facing list here
  // so the operator sees the full advertised surface, not just the
  // one the lookup happens to return.
  const publicMailboxes = [
    // PR-AG (post-merge follow-up): public mailboxes live on averrow.ca,
    // not averrow.com — averrow.com stays on Google Workspace so
    // CF Email Routing can't bind there. See docs/EMAIL_ROUTING_RUNBOOK.md.
    { label: 'Phishing reports',           addr: 'phishing@averrow.ca' },
    { label: 'Brand impersonation',        addr: 'abuse@averrow.ca' },
    { label: 'General report',             addr: 'report@averrow.ca' },
    { label: 'Security disclosures',       addr: 'security@averrow.ca' },
  ];

  const copy = async (addr: string) => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(addr);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div
      className="rounded-xl p-5"
      style={{
        background: 'var(--bg-card)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid var(--border-base)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)',
      }}
    >
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/65 mb-3">
        <Mail size={11} /> Public-facing aliases
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {publicMailboxes.map((m) => (
          <div
            key={m.addr}
            className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
            style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <div className="min-w-0">
              <div className="text-[10px] font-mono text-white/65 uppercase tracking-wider">
                {m.label}
              </div>
              <code className="text-[12px] font-mono text-[var(--amber)]">{m.addr}</code>
            </div>
            <button
              type="button"
              onClick={() => copy(m.addr)}
              className="shrink-0 inline-flex items-center gap-1 text-[10px] font-mono text-white/60 hover:text-white/90 px-1.5 py-1 rounded"
              style={{ border: '1px solid rgba(255,255,255,0.08)' }}
            >
              {copied === m.addr ? <Check size={11} /> : <Copy size={11} />}
              {copied === m.addr ? 'copied' : 'copy'}
            </button>
          </div>
        ))}
      </div>
      {alias?.forwarding_instructions && (
        <p className="text-[11px] text-white/70 mt-3 leading-relaxed">
          {alias.forwarding_instructions}
        </p>
      )}
    </div>
  );
}

function HeadlineMetrics({
  totals, unboundTotal,
}: {
  totals: AdminAbuseMailboxTotals;
  unboundTotal: number;
}) {
  const tiles: Array<{ label: string; value: number; accent: string }> = [
    { label: 'TOTAL CAPTURES',  value: totals.messages_total,         accent: '#E5A832' },
    { label: 'PHISHING',        value: totals.messages_phishing,      accent: '#fb923c' },
    { label: 'MALWARE',         value: totals.messages_malware,       accent: '#f87171' },
    { label: 'HIGH / CRITICAL', value: totals.messages_high_critical, accent: '#f87171' },
    { label: 'PENDING',         value: totals.messages_pending,       accent: 'var(--text-tertiary)' },
    { label: 'UNBOUND',         value: unboundTotal,                  accent: 'var(--text-tertiary)' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="rounded-xl p-3"
          style={{
            background: 'var(--bg-card)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid var(--border-base)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)',
          }}
        >
          <div className="text-[9px] font-mono uppercase tracking-widest text-white/65">
            {t.label}
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums" style={{ color: t.accent }}>
            {t.value}
          </div>
        </div>
      ))}
    </div>
  );
}

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: '#f87171',
  HIGH:     '#fb923c',
  MEDIUM:   '#fbbf24',
  LOW:      '#78A0C8',
};

const CLASSIFICATION_COLORS: Record<string, string> = {
  phishing:  '#f87171',
  malware:   '#f87171',
  spam:      '#fbbf24',
  benign:    '#4ADE80',
  ambiguous: '#A78BFA',
  pending:   'var(--text-muted)',
  follow_up: '#60a5fa',
};

function MessageRow({ message, expanded, onToggle }: {
  message: AdminAbuseInboxMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const sev = (message.severity ?? 'LOW').toUpperCase();
  const sevColor = SEVERITY_COLORS[sev] ?? '#78A0C8';
  const cls = (message.classification ?? 'pending').toLowerCase();
  const clsColor = CLASSIFICATION_COLORS[cls] ?? 'var(--text-muted)';

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full text-left rounded-xl px-4 py-3 transition-all hover:bg-white/[0.04] ${expanded ? 'ring-1 ring-[var(--amber)]/30' : ''}`}
      style={{
        background: expanded ? 'rgba(229,168,50,0.04)' : 'var(--bg-card)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid var(--border-base)',
        ...(sev === 'CRITICAL' || sev === 'HIGH'
          ? { borderTop: `1px solid ${sevColor}` }
          : {}),
      }}
    >
      {/* PR-AO: bumped text contrast across the row.
          - Headline text white/80 → white/95
          - Meta row white/45 → white/70
          - Tags white/55 → white/75
          - Mono code text colour added for from/via (less grey, more readable)
          - Falls back original_from → forwarded_by_email when null so
            direct submissions (no forward) actually show a sender. */}
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: sevColor, boxShadow: `0 0 6px ${sevColor}` }} />
          <span className="text-[10px] font-mono font-semibold uppercase" style={{ color: clsColor }}>
            {cls}
          </span>
          <span className="text-white/40 text-[10px]">·</span>
          <span className="text-[10px] font-mono uppercase font-semibold" style={{ color: sevColor }}>
            {sev}
          </span>
          {message.ai_action && (
            <>
              <span className="text-white/40 text-[10px]">·</span>
              <span className="text-[10px] font-mono uppercase text-white/75">
                action: <span className="text-white/95">{message.ai_action}</span>
              </span>
            </>
          )}
          {message.throttled === 1 && (
            <span
              className="text-[9px] font-mono font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ml-1"
              style={{
                color: '#fbbf24',
                background: 'rgba(229,168,50,0.10)',
                border: '1px solid rgba(229,168,50,0.30)',
              }}
              title={throttleReasonLabel(message.throttle_reason)}
            >
              rate-limited
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DeliveryTracker message={message} />
          <span className="text-[10px] font-mono text-white/60">
            {relativeTime(message.received_at)}
          </span>
        </div>
      </div>
      <div className="text-[13px] text-white/95 truncate font-medium">
        {message.original_subject || <span className="italic text-white/45">(no subject)</span>}
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-white/70 flex-wrap">
        <span>
          from <span className="text-[var(--amber)]">{message.original_from ?? message.forwarded_by_email ?? '—'}</span>
        </span>
        {message.original_from && message.forwarded_by_email && message.original_from !== message.forwarded_by_email && (
          <>
            <span className="text-white/35">·</span>
            <span>fwd by <span className="text-white/85">{message.forwarded_by_email}</span></span>
          </>
        )}
        <span className="text-white/35">·</span>
        <span>via <span className="text-white/85">{message.inbound_alias ?? '—'}</span></span>
        {message.url_count > 0 && (
          <>
            <span className="text-white/35">·</span>
            <span>{message.url_count} URL{message.url_count === 1 ? '' : 's'}</span>
          </>
        )}
        {message.attachment_count > 0 && (
          <>
            <span className="text-white/35">·</span>
            <span>{message.attachment_count} attachment{message.attachment_count === 1 ? '' : 's'}</span>
          </>
        )}
      </div>
      {message.ai_assessment && (
        <p className="text-[11px] text-white/75 mt-2 leading-snug">{message.ai_assessment}</p>
      )}
      <div className="mt-1.5 flex items-center justify-end">
        <ChevronDown
          size={12}
          className="text-white/45"
          style={{ transition: 'transform 0.18s ease', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </div>
    </button>
  );
}

// ─── MessageDetail (PR-AO drill-down + PR-AS raw capture) ────────
// Inline-expanding panel that surfaces every field on the row.
// Heavy fields (full body, all headers, URL list, attachment list)
// are lazy-loaded via the detail endpoint when the row expands —
// the list payload stays compact even with 100 rows in the table.
function MessageDetail({ message }: { message: AdminAbuseInboxMessage }) {
  const sev = (message.severity ?? 'LOW').toUpperCase();
  const sevColor = SEVERITY_COLORS[sev] ?? '#78A0C8';
  const detailQ = useAdminAbuseMailboxMessageDetail(message.id);
  const detail = detailQ.data;
  return (
    <div
      className="rounded-xl px-5 py-4 -mt-1 animate-fade-in"
      style={{
        background: 'var(--bg-card)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid var(--border-base)',
        borderTop: `1px solid ${sevColor}40`,
      }}
    >
      {/* Subject */}
      <div className="mb-4">
        <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Subject</div>
        <div className="text-[14px] text-[var(--text-primary)] font-medium">
          {message.original_subject || <span className="italic text-white/45">(no subject)</span>}
        </div>
      </div>

      {/* Two-column metadata grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 mb-4">
        <DetailField label="From"             value={message.original_from} mono accent />
        <DetailField label="Forwarded by"     value={message.forwarded_by_email} mono />
        <DetailField label="Inbound alias"    value={message.inbound_alias} mono />
        <DetailField label="Received"         value={message.received_at} />
        <DetailField label="Classification"   value={message.classification} mono uppercase color={CLASSIFICATION_COLORS[(message.classification ?? '').toLowerCase()] ?? 'var(--text-secondary)'} />
        <DetailField label="Severity"         value={sev} mono color={sevColor} />
        <DetailField label="Status"           value={message.status} mono uppercase />
        <DetailField label="AI action"        value={message.ai_action} mono uppercase />
        <DetailField label="Classified by"    value={message.classified_by} mono />
        <DetailField label="Confidence"       value={message.classification_confidence != null ? `${message.classification_confidence}%` : null} />
        <DetailField label="URLs in body"     value={String(message.url_count)} />
        <DetailField label="Attachments"      value={String(message.attachment_count)} />
        <DetailField label="Ack sent"         value={message.ack_sent_at} />
        <DetailField label="Determination sent" value={message.determination_sent_at} />
        {message.throttled === 1 && (
          <DetailField label="Rate-limited" value={throttleReasonLabel(message.throttle_reason)} color="#fbbf24" />
        )}
        {detail?.raw_size_bytes != null && (
          <DetailField label="Raw size" value={formatBytes(detail.raw_size_bytes)} mono />
        )}
      </div>

      {/* AI reasoning */}
      {(message.classification_reason || message.ai_assessment) && (
        <div className="mb-4">
          <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">AI analyst notes</div>
          <p className="text-[12px] text-white/90 leading-relaxed">
            {message.classification_reason || message.ai_assessment}
          </p>
          {message.classification_reason && message.ai_assessment && message.ai_assessment !== message.classification_reason && (
            <p className="text-[11px] text-white/65 mt-1 leading-relaxed italic">
              {message.ai_assessment}
            </p>
          )}
        </div>
      )}

      {/* PR-BC — Deeper AI investigator (internal narrative + attribution + action) */}
      <DeepAnalysisSection detail={detail} loading={detailQ.isLoading} />

      {/* PR-AX — Platform intelligence (auth + sender IP + correlations + promotions) */}
      <PlatformIntelSection detail={detail} loading={detailQ.isLoading} />

      {/* PR-AS — Raw capture sections (Body / URLs / Headers / Attachments) */}
      <RawCaptureSections detailQ={detailQ} detail={detail} snippet={message.original_body_snippet} />

      {/* PR-BD — Status transitions */}
      <div className="mt-4 pt-3 border-t border-white/[0.06]">
        <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-2">Status</div>
        <StatusActions message={message} />
      </div>

      {/* Reference id + admin actions */}
      <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-[10px] font-mono text-white/55">
          <span>ref:</span>
          <code className="text-white/85">{message.id}</code>
        </div>
        {message.throttled === 1 && <UnthrottleButton messageId={message.id} />}
      </div>
    </div>
  );
}

function UnthrottleButton({ messageId }: { messageId: string }) {
  const mutate = useUnthrottleAbuseMessage();
  return (
    <button
      type="button"
      onClick={() => mutate.mutate(messageId)}
      disabled={mutate.isPending}
      className="text-[10px] font-mono uppercase tracking-wider px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
      style={{
        color: '#fbbf24',
        background: 'rgba(229,168,50,0.10)',
        border: '1px solid rgba(229,168,50,0.30)',
      }}
      title="Clear the rate-limit flag and queue this row for the next classifier pass"
    >
      {mutate.isPending ? 'unthrottling…' : 'unthrottle + reprocess'}
    </button>
  );
}

// ─── PR-BC investigator (deeper AI) section ─────────────────────
//
// Surfaces the Sonnet deep-analysis output on confirmed HIGH/CRITICAL
// rows: full internal narrative (with IPs / URLs / sender addresses
// — operators get everything), structured attribution chips, and the
// recommended action with its target. Internal-only — the external
// narrative + sanitization happens in the determination email.
function DeepAnalysisSection({
  detail, loading,
}: {
  detail: AdminAbuseInboxMessageDetail | null | undefined;
  loading: boolean;
}) {
  if (loading || !detail?.deep_analysis) return null;
  const d = detail.deep_analysis;
  const ACTION_COLORS: Record<string, string> = {
    takedown:     '#f87171',
    abuse_report: '#fb923c',
    block:        '#fbbf24',
    monitor:      '#60a5fa',
    none:         'rgba(255,255,255,0.45)',
  };
  const actionColor = ACTION_COLORS[d.recommended_action.category] ?? 'rgba(255,255,255,0.65)';
  return (
    <div className="mb-4">
      <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-2">
        Investigator findings
        <span className="ml-2 text-white/35">{d.model}</span>
      </div>
      <div
        className="rounded-lg p-4"
        style={{ background: 'var(--bg-card)', border: '1px solid rgba(248,113,113,0.20)' }}
      >
        <p className="text-[13px] text-white/92 leading-relaxed">{d.internal_narrative}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 mt-4">
          {d.attribution.hosting_provider && (
            <DetailField label="Hosting provider" value={d.attribution.hosting_provider} />
          )}
          {d.attribution.hosting_country && (
            <DetailField label="Country" value={d.attribution.hosting_country} />
          )}
          {d.attribution.sender_asn && (
            <DetailField label="Sender ASN" value={d.attribution.sender_asn} mono />
          )}
          {d.attribution.correlated_campaigns.length > 0 && (
            <DetailField
              label="Campaigns matched"
              value={d.attribution.correlated_campaigns
                .map((c) => c.name ?? c.id)
                .join(', ')}
            />
          )}
        </div>

        <div
          className="mt-4 pt-3 border-t border-white/[0.06]"
        >
          <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Recommended action</div>
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border"
              style={{
                color: actionColor,
                background: 'rgba(0,0,0,0.30)',
                borderColor: `${actionColor}55`,
              }}
            >
              {d.recommended_action.category}
            </span>
            {d.recommended_action.target && (
              <code className="text-[11px] font-mono text-white/85 break-all">
                → {d.recommended_action.target}
              </code>
            )}
          </div>
          <p className="text-[12px] text-white/80 mt-2 leading-relaxed">
            {d.recommended_action.details}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── PR-AX platform-intelligence section ─────────────────────────
//
// Surfaces the IOC bridge added in PR-AX: email auth (SPF/DKIM/DMARC),
// most-external sender IP from the Received chain, count of URLs that
// correlate to existing platform threats, and any threats we PROMOTED
// from this submission on confirmed phishing/malware verdicts.
function PlatformIntelSection({
  detail, loading,
}: {
  detail: AdminAbuseInboxMessageDetail | null | undefined;
  loading: boolean;
}) {
  if (loading || !detail) return null;
  const auth = detail.auth_results;
  const senderIp = detail.sender_ip;
  const correlatedCount = detail.correlated_threat_ids?.length ?? 0;
  const promotedCount   = detail.promoted_threat_ids?.length ?? 0;
  const hasAnything = auth || senderIp || correlatedCount > 0 || promotedCount > 0;
  if (!hasAnything) return null;

  return (
    <div className="mb-4">
      <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-2">Platform intelligence</div>
      <div
        className="rounded-lg p-3 grid grid-cols-1 md:grid-cols-2 gap-3 bg-black/20"
        style={{ border: '1px solid rgba(255,255,255,0.05)' }}
      >
        {auth && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Email auth</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <AuthPill label="SPF"   verdict={auth.spf} />
              <AuthPill label="DKIM"  verdict={auth.dkim} />
              <AuthPill label="DMARC" verdict={auth.dmarc} />
            </div>
          </div>
        )}
        {senderIp && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Sender IP</div>
            <code className="text-[12px] font-mono text-white/90 break-all">{senderIp}</code>
          </div>
        )}
        {correlatedCount > 0 && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Platform correlation</div>
            <div className="text-[12px] text-white/90">
              <span style={{ color: '#fbbf24', fontWeight: 600 }}>{correlatedCount}</span> URL/domain
              {correlatedCount === 1 ? '' : 's'} already in threat intel
            </div>
          </div>
        )}
        {promotedCount > 0 && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Promoted to platform</div>
            <div className="text-[12px] text-white/90">
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>{promotedCount}</span> threat
              {promotedCount === 1 ? '' : 's'} written
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AuthPill({ label, verdict }: { label: string; verdict: string | null }) {
  if (!verdict) {
    return (
      <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border border-white/[0.08] text-white/40">
        {label}: —
      </span>
    );
  }
  const isPass = verdict === 'pass';
  const isFail = verdict === 'fail' || verdict === 'permerror';
  const color  = isPass ? 'var(--green)' : isFail ? '#f87171' : '#fbbf24';
  const bg     = isPass ? 'rgba(60,184,120,0.10)' : isFail ? 'rgba(239,68,68,0.10)' : 'rgba(229,168,50,0.10)';
  const border = isPass ? 'rgba(60,184,120,0.30)' : isFail ? 'rgba(239,68,68,0.30)' : 'rgba(229,168,50,0.30)';
  return (
    <span
      className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border"
      style={{ color, background: bg, borderColor: border }}
    >
      {label}: {verdict}
    </span>
  );
}

// ─── PR-AS raw-capture sections (admin parity) ──────────────────
//
// Shown below the metadata grid. Tabs through Body / URLs / Headers /
// Attachments. Falls back to the snippet column when raw_body is null
// (pre-PR-AS rows, or detail endpoint pending).

type RawTab = 'body' | 'urls' | 'headers' | 'attachments';

function RawCaptureSections({
  detailQ, detail, snippet,
}: {
  detailQ: ReturnType<typeof useAdminAbuseMailboxMessageDetail>;
  detail:  AdminAbuseInboxMessageDetail | null | undefined;
  snippet: string | null;
}) {
  const [tab, setTab] = useState<RawTab>('body');
  const urls = detail?.extracted_urls ?? [];
  const attachments = detail?.attachment_names ?? [];
  const headerEntries: Array<[string, string]> = detail?.raw_headers
    ? Object.entries(detail.raw_headers)
    : [];
  const counts = {
    body:        detail?.raw_body ? `${formatBytes(detail.raw_body.length)}` : (snippet ? '500' : '—'),
    urls:        String(urls.length),
    headers:     String(headerEntries.length),
    attachments: String(attachments.length),
  };
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1 mb-3 border-b border-white/[0.06] pb-2">
        <RawTabButton label="Body"        count={counts.body}        active={tab === 'body'}        onClick={() => setTab('body')} />
        <RawTabButton label="URLs"        count={counts.urls}        active={tab === 'urls'}        onClick={() => setTab('urls')} />
        <RawTabButton label="Headers"     count={counts.headers}     active={tab === 'headers'}     onClick={() => setTab('headers')} />
        <RawTabButton label="Attachments" count={counts.attachments} active={tab === 'attachments'} onClick={() => setTab('attachments')} />
        {detailQ.isLoading && (
          <span className="ml-auto text-[10px] font-mono text-white/45">loading…</span>
        )}
      </div>

      {tab === 'body' && <BodyPanel rawBody={detail?.raw_body ?? null} snippet={snippet} />}
      {tab === 'urls' && <UrlsPanel urls={urls} loading={detailQ.isLoading} />}
      {tab === 'headers' && <HeadersPanel entries={headerEntries} loading={detailQ.isLoading} />}
      {tab === 'attachments' && <AttachmentsPanel attachments={attachments} loading={detailQ.isLoading} />}
    </div>
  );
}

function RawTabButton({
  label, count, active, onClick,
}: { label: string; count: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1.5 rounded-md text-[11px] font-mono transition-colors"
      style={{
        background:    active ? 'rgba(229,168,50,0.10)' : 'transparent',
        color:         active ? 'var(--amber)' : 'var(--text-secondary)',
        border:        active ? '1px solid rgba(229,168,50,0.30)' : '1px solid transparent',
      }}
    >
      <span className="uppercase tracking-wider">{label}</span>
      <span className="ml-1.5 text-white/45">{count}</span>
    </button>
  );
}

function BodyPanel({ rawBody, snippet }: { rawBody: string | null; snippet: string | null }) {
  const content = rawBody ?? snippet;
  if (!content) {
    return <EmptyPanel text="No body captured" />;
  }
  return (
    <div>
      {!rawBody && snippet && (
        <p className="text-[10px] text-white/45 mb-2 font-mono">
          Raw body not captured for this message (pre-PR-AS). Showing the 500-char snippet.
        </p>
      )}
      <pre
        className="text-[11px] text-white/85 leading-relaxed whitespace-pre-wrap break-words rounded-lg p-3 font-mono bg-black/30"
        style={{
          border: '1px solid rgba(255,255,255,0.05)',
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        {content}
      </pre>
    </div>
  );
}

function UrlsPanel({ urls, loading }: { urls: ExtractedUrl[]; loading: boolean }) {
  if (loading) return <LoadingPanel />;
  if (urls.length === 0) return <EmptyPanel text="No URLs found in the body" />;
  return (
    <div
      className="rounded-lg overflow-hidden bg-black/30"
      style={{ border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="max-h-72 overflow-auto divide-y divide-white/[0.04]">
        {urls.map((u, i) => (
          <div key={`${u.url}-${i}`} className="px-3 py-2 flex items-center gap-2">
            {u.domain && (
              <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--amber)] min-w-0 shrink-0">
                {u.domain}
              </span>
            )}
            {u.count > 1 && (
              <span className="text-[9px] font-mono text-white/45 shrink-0">×{u.count}</span>
            )}
            <code className="text-[11px] text-white/85 font-mono break-all flex-1 min-w-0">
              {u.url}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeadersPanel({ entries, loading }: { entries: Array<[string, string]>; loading: boolean }) {
  if (loading) return <LoadingPanel />;
  if (entries.length === 0) return <EmptyPanel text="No headers captured" />;
  // Sort: surface the key ones first.
  const PRIORITY = ['from', 'to', 'subject', 'date', 'reply-to', 'return-path',
    'received', 'authentication-results', 'dkim-signature', 'message-id'];
  const priorityIdx = (k: string) => {
    const i = PRIORITY.indexOf(k.toLowerCase());
    return i === -1 ? 999 : i;
  };
  const sorted = [...entries].sort((a, b) => {
    const da = priorityIdx(a[0]); const db = priorityIdx(b[0]);
    if (da !== db) return da - db;
    return a[0].localeCompare(b[0]);
  });
  return (
    <div
      className="rounded-lg overflow-hidden bg-black/30"
      style={{ border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-[11px] font-mono">
          <tbody className="divide-y divide-white/[0.04]">
            {sorted.map(([k, v]) => (
              <tr key={k}>
                <td className="align-top px-3 py-1.5 text-[var(--amber)] whitespace-nowrap">{k}</td>
                <td className="align-top px-3 py-1.5 text-white/85 break-all">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AttachmentsPanel({ attachments, loading }: { attachments: ExtractedAttachment[]; loading: boolean }) {
  if (loading) return <LoadingPanel />;
  if (attachments.length === 0) return <EmptyPanel text="No attachments" />;
  return (
    <div
      className="rounded-lg overflow-hidden bg-black/30"
      style={{ border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="max-h-72 overflow-auto divide-y divide-white/[0.04]">
        {attachments.map((a, i) => (
          <div key={`${a.filename}-${i}`} className="px-3 py-2 flex items-center gap-3">
            <code className="text-[11px] text-white/90 font-mono break-all flex-1 min-w-0">{a.filename}</code>
            {a.mime_type && (
              <span className="text-[10px] font-mono text-white/55 shrink-0">{a.mime_type}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div
      className="rounded-lg px-4 py-6 text-center text-[12px] text-white/45 font-mono bg-black/20"
      style={{ border: '1px solid rgba(255,255,255,0.04)' }}
    >
      {text}
    </div>
  );
}

function LoadingPanel() {
  return (
    <div
      className="rounded-lg px-4 py-6 text-center text-[12px] text-white/50 font-mono bg-black/20"
      style={{ border: '1px solid rgba(255,255,255,0.04)' }}
    >
      Loading…
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ─── PR-AZ: per-row delivery status tracker ──────────────────────
//
// Two envelope icons at the top-right of each row card showing the
// state of the two automated emails that fire per submission:
//   1. Ack-on-receipt (PR-AD) — confirms we got the report
//   2. Determination/verdict (PR-AD + PR-AY) — the AI verdict reply
//
// States per icon:
//   filled-green       sent OK (timestamp visible on hover)
//   outline-gray       pending — classifier hasn't run / Resend in flight
//   amber-X            intentionally skipped due to rate-limit (PR-AT)
//
// Designed to be readable at a glance from a list of 100 rows without
// adding more text columns to the row card.
function DeliveryTracker({ message }: { message: AdminAbuseInboxMessage }) {
  const ack = !!message.ack_sent_at;
  const verdict = !!message.determination_sent_at;
  const throttled = message.throttled === 1;
  const tooltip = throttled
    ? `Rate-limited: ack + verdict emails intentionally skipped (${message.throttle_reason ?? "throttled"})`
    : [
        `Ack: ${ack ? `sent ${formatShortTs(message.ack_sent_at)}` : "pending"}`,
        `Verdict: ${verdict ? `sent ${formatShortTs(message.determination_sent_at)}` : "pending"}`,
      ].join(" · ");
  return (
    <div className="flex items-center gap-0.5" title={tooltip}>
      <StatusIcon kind="ack"     sent={ack}     throttled={throttled} />
      <StatusIcon kind="verdict" sent={verdict} throttled={throttled} />
    </div>
  );
}

function StatusIcon({
  kind, sent, throttled,
}: { kind: "ack" | "verdict"; sent: boolean; throttled: boolean }) {
  if (throttled) {
    return (
      <MailX
        size={13}
        style={{ color: '#fbbf24', opacity: 0.65 }}
        aria-label={`${kind} skipped — rate-limited`}
      />
    );
  }
  if (sent) {
    return (
      <MailCheck
        size={13}
        style={{ color: 'var(--green)' }}
        aria-label={`${kind} sent`}
      />
    );
  }
  return (
    <Mail
      size={13}
      style={{ color: 'rgba(255,255,255,0.35)' }}
      aria-label={`${kind} pending`}
    />
  );
}

function formatShortTs(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function throttleReasonLabel(reason: string | null | undefined): string {
  if (reason === 'sender_rate_limit') return 'Sender exceeded 20 messages in the last 60 minutes';
  if (reason === 'domain_rate_limit') return 'Sending domain exceeded 50 messages in the last 60 minutes';
  return 'Rate-limited at capture';
}

function DetailField({
  label, value, mono, accent, uppercase, color,
}: {
  label:     string;
  value:     string | null | undefined;
  mono?:     boolean;
  accent?:   boolean;
  uppercase?: boolean;
  color?:    string;
}) {
  return (
    <div>
      <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-0.5">{label}</div>
      <div
        className={`text-[12px] ${mono ? 'font-mono' : ''} ${uppercase ? 'uppercase' : ''} break-all`}
        style={{ color: color ?? (accent ? 'var(--amber)' : 'rgba(255,255,255,0.92)') }}
      >
        {value ?? <span className="text-white/35">—</span>}
      </div>
    </div>
  );
}

// ─── PR-BD: client-side message filter ──────────────────────────
//
// Backend returns the top 100 rows sorted by severity → classification
// → recency. The toolbar slices that further by status tab,
// classification chip, and search text. All filtering is in-memory —
// no extra D1 reads, no pagination state to manage.

function filterMessages(
  messages: AdminAbuseInboxMessage[],
  statusTab: 'all' | AbuseMessageStatus,
  classFilter: string | null,
  searchText: string,
): AdminAbuseInboxMessage[] {
  const q = searchText.trim().toLowerCase();
  return messages.filter((m) => {
    if (statusTab !== 'all' && m.status !== statusTab) return false;
    if (classFilter && m.classification !== classFilter) return false;
    if (q) {
      const hay = [
        m.original_subject ?? '',
        m.original_from ?? '',
        m.forwarded_by_email ?? '',
        m.inbound_alias ?? '',
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ─── PR-BD: Intel highlights from deep_analysis aggregates ──────

function IntelHighlights({ intel }: { intel: AbuseMailboxIntel }) {
  const hasAnything =
    intel.campaigns.length > 0 ||
    intel.recent_takedowns.length > 0 ||
    intel.hosting_providers.length > 0;
  if (!hasAnything) return null;
  return (
    <section
      className="rounded-xl p-4 space-y-3"
      style={{
        background: 'var(--bg-card)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid var(--border-base)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)',
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/65">
          Intel highlights
        </h2>
        <span className="text-[10px] font-mono text-white/45">
          {intel.analyzed_count_7d} analyzed / 7d · {intel.analyzed_count_30d} / 30d
        </span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {intel.recent_takedowns.length > 0 && (
          <IntelCard title="Recent takedown recs" accent="var(--sev-critical)">
            {intel.recent_takedowns.map((t) => (
              <div key={t.message_id} className="text-[11px] py-1 border-b border-white/[0.04] last:border-b-0">
                <div className="text-white/85 truncate">
                  {t.original_subject ?? <span className="italic text-white/45">(no subject)</span>}
                </div>
                <div className="text-white/55 font-mono mt-0.5 truncate">
                  → {t.target ?? t.hosting_provider ?? 'unknown target'}
                  {t.hosting_country && ` · ${t.hosting_country}`}
                </div>
              </div>
            ))}
          </IntelCard>
        )}
        {intel.campaigns.length > 0 && (
          <IntelCard title="Active campaigns" accent="var(--sev-high)">
            {intel.campaigns.map((c) => (
              <div key={c.campaign_id} className="text-[11px] py-1 border-b border-white/[0.04] last:border-b-0">
                <div className="text-white/85 truncate">{c.campaign_name ?? c.campaign_id}</div>
                <div className="text-white/55 font-mono mt-0.5">
                  ×{c.count} match{c.count === 1 ? '' : 'es'} · first seen {new Date(c.first_seen).toLocaleDateString()}
                </div>
              </div>
            ))}
          </IntelCard>
        )}
        {intel.hosting_providers.length > 0 && (
          <IntelCard title="Top hosting providers" accent="var(--blue)">
            {intel.hosting_providers.map((p) => (
              <div key={p.hosting_provider} className="text-[11px] py-1 border-b border-white/[0.04] last:border-b-0">
                <div className="text-white/85 truncate">{p.hosting_provider}</div>
                <div className="text-white/55 font-mono mt-0.5">
                  ×{p.count}{p.hosting_country && ` · ${p.hosting_country}`}
                </div>
              </div>
            ))}
          </IntelCard>
        )}
      </div>
    </section>
  );
}

function IntelCard({
  title, accent, children,
}: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg p-3 bg-black/20"
      style={{
        border: '1px solid rgba(255,255,255,0.05)',
        borderLeft: `2px solid ${accent}`,
      }}
    >
      <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-2">{title}</div>
      <div>{children}</div>
    </div>
  );
}

// ─── PR-BD: Inbox toolbar (tabs + classification chips + search) ─

const STATUS_TABS: Array<{ key: 'all' | AbuseMessageStatus; label: string }> = [
  { key: 'all',           label: 'All' },
  { key: 'new',           label: 'New' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'resolved',      label: 'Resolved' },
  { key: 'dismissed',     label: 'Dismissed' },
];

const CLASSIFICATION_CHIPS: Array<{ key: string; label: string }> = [
  { key: 'phishing',  label: 'Phishing' },
  { key: 'malware',   label: 'Malware' },
  { key: 'spam',      label: 'Spam' },
  { key: 'benign',    label: 'Benign' },
  { key: 'pending',   label: 'Pending' },
  { key: 'ambiguous', label: 'Ambiguous' },
  // PR-BD: submitter replies to ack/determination emails get tagged
  // here so admin can review them by hand. Auto-skipped by the
  // classifier (handler sets classification=follow_up on intake).
  { key: 'follow_up', label: 'Follow-up' },
];

function InboxToolbar({
  messages, activeBrand, onClearBrand,
  statusTab, onStatusTabChange,
  classFilter, onClassFilterChange,
  searchText, onSearchChange,
}: {
  messages: AdminAbuseInboxMessage[];
  activeBrand: string | null;
  onClearBrand: () => void;
  statusTab: 'all' | AbuseMessageStatus;
  onStatusTabChange: (s: 'all' | AbuseMessageStatus) => void;
  classFilter: string | null;
  onClassFilterChange: (c: string | null) => void;
  searchText: string;
  onSearchChange: (s: string) => void;
}) {
  // Compute counts per tab + chip from the loaded messages so the
  // operator sees how many they'll get if they click each filter.
  const statusCounts: Record<string, number> = { all: messages.length };
  for (const m of messages) statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
  const classCounts: Record<string, number> = {};
  for (const m of messages) classCounts[m.classification] = (classCounts[m.classification] ?? 0) + 1;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/65">
          Inbox <span className="text-white/40 ml-1">({messages.length})</span>
        </h2>
        {activeBrand && (
          <button
            type="button"
            onClick={onClearBrand}
            className="text-[11px] font-mono text-white/55 hover:text-white/85"
          >
            clear brand filter
          </button>
        )}
      </div>

      {/* Status tabs */}
      <div className="flex items-center gap-1 flex-wrap border-b border-white/[0.06] pb-2">
        {STATUS_TABS.map((t) => {
          const count = statusCounts[t.key] ?? 0;
          const active = statusTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onStatusTabChange(t.key)}
              className="px-3 py-1.5 rounded-md text-[11px] font-mono transition-colors"
              style={{
                background: active ? 'rgba(229,168,50,0.10)' : 'transparent',
                color:      active ? 'var(--amber)' : 'var(--text-secondary)',
                border:     active ? '1px solid rgba(229,168,50,0.30)' : '1px solid transparent',
              }}
            >
              <span className="uppercase tracking-wider">{t.label}</span>
              <span className="ml-1.5 text-white/45">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Classification chips + search */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => onClassFilterChange(null)}
          className={`text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded border ${
            classFilter === null
              ? 'border-[var(--amber-border)] text-[var(--amber-text)] bg-[var(--amber-glow)]'
              : 'border-white/[0.08] text-white/55 hover:text-white/85'
          }`}
        >
          all
        </button>
        {CLASSIFICATION_CHIPS.map((c) => {
          const count = classCounts[c.key] ?? 0;
          if (count === 0) return null;
          const active = classFilter === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => onClassFilterChange(active ? null : c.key)}
              className={`text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded border ${
                active
                  ? 'border-[var(--amber-border)] text-[var(--amber-text)] bg-[var(--amber-glow)]'
                  : 'border-white/[0.08] text-white/55 hover:text-white/85'
              }`}
            >
              {c.label} <span className="ml-1 text-white/45">{count}</span>
            </button>
          );
        })}
        <input
          type="search"
          placeholder="Search subject / sender / alias…"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          className="ml-auto text-[11px] font-mono bg-black/30 border border-white/[0.08] rounded px-3 py-1.5 text-white/85 placeholder-white/35 focus:outline-none focus:border-[var(--amber-border)] min-w-[200px]"
        />
      </div>
    </div>
  );
}

// ─── PR-BD: Per-row status mutation menu (lives inside MessageDetail) ─

function StatusActions({ message }: { message: AdminAbuseInboxMessage }) {
  const mutate = useUpdateAbuseMessageStatus();
  const cur = (message.status ?? 'new') as AbuseMessageStatus;
  const next = (s: AbuseMessageStatus) => {
    if (cur === s || mutate.isPending) return;
    mutate.mutate({ messageId: message.id, status: s });
  };
  // Show all 4 — the user can move forward or backward through the lifecycle.
  const BTN = (label: string, target: AbuseMessageStatus, color: string) => (
    <button
      key={target}
      type="button"
      onClick={() => next(target)}
      disabled={cur === target || mutate.isPending}
      className={`text-[10px] font-mono uppercase tracking-wider px-3 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-default ${cur === target ? '' : 'bg-black/30'}`}
      style={{
        color,
        background:  cur === target ? `${color}22` : undefined,
        border: `1px solid ${color}55`,
      }}
    >
      {cur === target ? `✓ ${label}` : label}
    </button>
  );
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {BTN('Investigate', 'investigating', 'var(--sev-medium)')}
      {BTN('Resolve',     'resolved',      'var(--green)')}
      {BTN('Dismiss',     'dismissed',     'var(--text-secondary)')}
      {cur !== 'new' && BTN('Reopen',      'new',           'var(--amber)')}
    </div>
  );
}

function BulkBtn({ label, color, disabled, onClick }: {
  label: string; color: string; disabled: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[10px] font-mono uppercase tracking-wider px-3 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-default bg-black/30"
      style={{ color, border: `1px solid ${color}55` }}
    >
      {label}
    </button>
  );
}

function EmptyMessages() {
  return (
    <div
      className="rounded-xl px-6 py-12 text-center"
      style={{
        background: 'var(--bg-card)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid var(--border-base)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)',
      }}
    >
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-full mb-3"
           style={{ background: 'rgba(229,168,50,0.10)' }}>
        <Inbox size={18} style={{ color: 'var(--amber)' }} />
      </div>
      <div className="text-sm text-white/85 font-mono">No captures yet</div>
      <p className="text-[11px] text-white/65 mt-1 max-w-md mx-auto">
        Mailboxes are listening. Submissions arrive when someone forwards to abuse@ / phishing@ / report@ / security@averrow.ca, or when an attacker probes those endpoints.
      </p>
    </div>
  );
}
