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

import { useState } from 'react';
import { Mail, Inbox, AlertTriangle, ShieldCheck, Copy, Check } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Navigate } from 'react-router-dom';
import { PageLoader } from '@/components/ui/PageLoader';
import {
  useAdminAbuseMailboxSummary,
  useAdminAbuseMailboxMessages,
  type AdminAbuseAlias,
  type AdminAbuseMailboxTotals,
  type AdminAbuseInboxMessage,
} from '@/hooks/useAdminAbuseMailbox';
import { relativeTime } from '@/lib/time';

export function AdminAbuseMailbox() {
  const { isSuperAdmin, loading: authLoading } = useAuth();
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
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
        <p className="text-sm text-white/70 leading-relaxed">
          The marketing site at <a className="text-[var(--amber)] hover:underline" href="https://averrow.com/report-abuse" target="_blank" rel="noreferrer">averrow.com/report-abuse</a> advertises public mailboxes for the same service we sell to customers. Every submission — phishing reports, impersonation tips, vulnerability disclosures, attacker probes — lands here, gets classified by Haiku, and feeds platform threat intelligence. We dogfood the abuse-mailbox module on ourselves.
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
              <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
                Recent messages
                <span className="text-white/30 ml-2">
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
                    {messagesQ.data.messages.map((m) => <MessageRow key={m.id} message={m} />)}
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
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/45 mb-3">
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
              <div className="text-[10px] font-mono text-white/40 uppercase tracking-wider">
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
        <p className="text-[11px] text-white/45 mt-3 leading-relaxed">
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
          <div className="text-[9px] font-mono uppercase tracking-widest text-white/40">
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

function MessageRow({ message }: { message: AdminAbuseInboxMessage }) {
  const sev = (message.severity ?? 'LOW').toUpperCase();
  const sevColor = SEVERITY_COLORS[sev] ?? '#78A0C8';
  const cls = (message.classification ?? 'pending').toLowerCase();
  const clsColor = CLASSIFICATION_COLORS[cls] ?? 'var(--text-muted)';

  return (
    <div
      className="rounded-xl px-4 py-3 transition-colors hover:bg-white/[0.02]"
      style={{
        background: 'rgba(15,23,42,0.50)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid var(--border-base)',
        ...(sev === 'CRITICAL' || sev === 'HIGH'
          ? { borderTop: `1px solid ${sevColor}` }
          : {}),
      }}
    >
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2">
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: sevColor, boxShadow: `0 0 6px ${sevColor}` }} />
          <span className="text-[10px] font-mono font-semibold uppercase" style={{ color: clsColor }}>
            {cls}
          </span>
          <span className="text-white/30 text-[10px]">·</span>
          <span className="text-[10px] font-mono uppercase" style={{ color: sevColor }}>
            {sev}
          </span>
          {message.ai_action && (
            <>
              <span className="text-white/30 text-[10px]">·</span>
              <span className="text-[10px] font-mono uppercase text-white/55">
                action: {message.ai_action}
              </span>
            </>
          )}
        </div>
        <span className="text-[10px] font-mono text-white/40">
          {relativeTime(message.received_at)}
        </span>
      </div>
      <div className="text-[12px] text-white/80 truncate">
        {message.original_subject || <span className="italic text-white/40">(no subject)</span>}
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-white/45">
        <span>from {message.original_from ?? '—'}</span>
        <span>·</span>
        <span>via {message.inbound_alias ?? '—'}</span>
        {message.url_count > 0 && (
          <>
            <span>·</span>
            <span>{message.url_count} URL{message.url_count === 1 ? '' : 's'}</span>
          </>
        )}
        {message.attachment_count > 0 && (
          <>
            <span>·</span>
            <span>{message.attachment_count} attachment{message.attachment_count === 1 ? '' : 's'}</span>
          </>
        )}
      </div>
      {message.ai_assessment && (
        <p className="text-[11px] text-white/55 mt-2 leading-snug">{message.ai_assessment}</p>
      )}
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
      <div className="text-sm text-white/70 font-mono">No captures yet</div>
      <p className="text-[11px] text-white/45 mt-1 max-w-md mx-auto">
        Mailboxes are listening. Submissions arrive when someone forwards to abuse@ / phishing@ / report@ / security@averrow.ca, or when an attacker probes those endpoints.
      </p>
    </div>
  );
}
