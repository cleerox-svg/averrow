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

import { Fragment, useState } from 'react';
import { Mail, Inbox, AlertTriangle, ShieldCheck, Copy, Check, ChevronDown } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Navigate } from 'react-router-dom';
import { PageLoader } from '@/components/ui/PageLoader';
import {
  useAdminAbuseMailboxSummary,
  useAdminAbuseMailboxMessages,
  useAdminAbuseMailboxMessageDetail,
  useUnthrottleAbuseMessage,
  type AdminAbuseAlias,
  type AdminAbuseMailboxTotals,
  type AdminAbuseInboxMessage,
  type AdminAbuseInboxMessageDetail,
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
  const summaryQ = useAdminAbuseMailboxSummary();
  const messagesQ = useAdminAbuseMailboxMessages(activeBrand);

  if (authLoading) return <PageLoader />;
  if (!isSuperAdmin) return <Navigate to="/" replace />;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Abuse Mailbox</h1>
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
          background: 'rgba(15,23,42,0.50)',
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

          {/* Recent inbox */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/65">
                Recent messages
                <span className="text-white/40 ml-2">
                  ({messagesQ.data?.messages.length ?? 0})
                </span>
              </h2>
              {activeBrand && (
                <button
                  type="button"
                  onClick={() => setActiveBrand(null)}
                  className="text-[11px] font-mono text-white/55 hover:text-white/85"
                >
                  clear filter
                </button>
              )}
            </div>

            {messagesQ.isLoading && (
              <div className="text-white/40 text-sm font-mono py-8 text-center">Loading messages…</div>
            )}
            {messagesQ.data && (
              messagesQ.data.messages.length === 0
                ? <EmptyMessages />
                : (
                  <div className="space-y-2">
                    {messagesQ.data.messages.map((m) => (
                      <Fragment key={m.id}>
                        <MessageRow
                          message={m}
                          expanded={selectedId === m.id}
                          onToggle={() => setSelectedId(prev => prev === m.id ? null : m.id)}
                        />
                        {selectedId === m.id && <MessageDetail message={m} />}
                      </Fragment>
                    ))}
                  </div>
                )
            )}
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
        background: 'rgba(15,23,42,0.50)',
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
            background: 'rgba(15,23,42,0.50)',
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
        background: expanded ? 'rgba(229,168,50,0.04)' : 'rgba(15,23,42,0.50)',
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
        <span className="text-[10px] font-mono text-white/60 shrink-0">
          {relativeTime(message.received_at)}
        </span>
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
        background: 'rgba(15,23,42,0.65)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid var(--border-base)',
        borderTop: `1px solid ${sevColor}40`,
      }}
    >
      {/* Subject */}
      <div className="mb-4">
        <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Subject</div>
        <div className="text-[14px] text-white font-medium">
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

      {/* PR-AS — Raw capture sections (Body / URLs / Headers / Attachments) */}
      <RawCaptureSections detailQ={detailQ} detail={detail} snippet={message.original_body_snippet} />

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
        color:         active ? 'var(--amber)' : 'rgba(255,255,255,0.65)',
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
        className="text-[11px] text-white/85 leading-relaxed whitespace-pre-wrap break-words rounded-lg p-3 font-mono"
        style={{
          background: 'rgba(0,0,0,0.30)',
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
      className="rounded-lg overflow-hidden"
      style={{ background: 'rgba(0,0,0,0.30)', border: '1px solid rgba(255,255,255,0.05)' }}
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
      className="rounded-lg overflow-hidden"
      style={{ background: 'rgba(0,0,0,0.30)', border: '1px solid rgba(255,255,255,0.05)' }}
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
      className="rounded-lg overflow-hidden"
      style={{ background: 'rgba(0,0,0,0.30)', border: '1px solid rgba(255,255,255,0.05)' }}
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
      className="rounded-lg px-4 py-6 text-center text-[12px] text-white/45 font-mono"
      style={{ background: 'rgba(0,0,0,0.20)', border: '1px solid rgba(255,255,255,0.04)' }}
    >
      {text}
    </div>
  );
}

function LoadingPanel() {
  return (
    <div
      className="rounded-lg px-4 py-6 text-center text-[12px] text-white/50 font-mono"
      style={{ background: 'rgba(0,0,0,0.20)', border: '1px solid rgba(255,255,255,0.04)' }}
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

function EmptyMessages() {
  return (
    <div
      className="rounded-xl px-6 py-12 text-center"
      style={{
        background: 'rgba(15,23,42,0.50)',
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
