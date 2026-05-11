// Abuse Mailbox — primary tenant surface.
//
// Shows the org's verify alias (so employees know where to forward
// suspicious emails), per-brand classification rollup, and a unified
// inbox of recent messages. Drill-down by brand via ?brandId.
//
// Phase B sprint 6.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, ShieldCheck, Mail, Inbox, Copy, Check, ExternalLink, type LucideIcon } from 'lucide-react';
import {
  useAbuseMailboxSummary,
  useAbuseInboxMessages,
  type AbuseMailboxBrandSummary,
  type AbuseMailboxTotals,
  type AbuseAlias,
  type AbuseInboxMessageRow,
} from '@/lib/abuseMailboxModule';

export function AbuseMailbox() {
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const summaryQ = useAbuseMailboxSummary();
  const messagesQ = useAbuseInboxMessages(activeBrand);

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO OVERVIEW
      </Link>

      <header>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-[28px] font-bold text-white tracking-tight">Abuse Mailbox</h1>
          <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-amber bg-amber/[0.10] border border-amber/[0.20] rounded px-2 py-1">
            Active
          </span>
        </div>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Forward suspicious emails to your verify alias. We classify, score severity, and respond with an instant ack and a determination within 24 hours.
        </p>
      </header>

      {summaryQ.isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading mailbox…</div>}
      {summaryQ.error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load Abuse Mailbox</h3>
          <p className="text-[12px] text-white/55 mt-1">{summaryQ.error.message}</p>
        </div>
      )}

      {summaryQ.data && (
        <>
          <AliasCard alias={summaryQ.data.alias} />
          <HeadlineMetrics
            totals={summaryQ.data.totals}
            brandCount={summaryQ.data.brands.length}
            unboundTotal={summaryQ.data.unbound.total}
          />

          <section>
            <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">Per brand</h2>
            {summaryQ.data.brands.length === 0 ? (
              <NoBrands />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {summaryQ.data.brands.map((b) => (
                  <BrandCard
                    key={b.brand_id}
                    brand={b}
                    selected={activeBrand === b.brand_id}
                    onSelect={() => setActiveBrand(activeBrand === b.brand_id ? null : b.brand_id)}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
                {activeBrand
                  ? `Filtered: ${summaryQ.data.brands.find((b) => b.brand_id === activeBrand)?.brand_name ?? activeBrand}`
                  : 'Recent messages'}
                <span className="text-white/30 ml-2">({messagesQ.data?.messages.length ?? 0})</span>
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

            {messagesQ.isLoading && <div className="text-white/40 text-sm font-mono py-8 text-center">Loading messages…</div>}
            {messagesQ.data && (
              messagesQ.data.messages.length === 0 ? (
                <EmptyMessages />
              ) : (
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

function AliasCard({ alias }: { alias: AbuseAlias | null }) {
  const [copied, setCopied] = useState(false);

  if (!alias) {
    return (
      <div className="rounded-xl border border-amber/[0.30] bg-amber/[0.06] p-4">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-amber mb-1">
          <Mail size={11} /> Forwarding alias not yet provisioned
        </div>
        <p className="text-[13px] text-white/75">
          Your forwarding alias is still being set up. <a className="text-amber hover:underline" href="mailto:support@averrow.com">Contact support</a> to expedite.
        </p>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(alias.alias);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable
    }
  };

  return (
    <div className="rounded-xl border border-white/[0.10] bg-bg-card p-5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/45 mb-2">
        <Mail size={11} /> Your forwarding alias
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <code className="text-base font-mono text-amber bg-amber/[0.06] border border-amber/[0.20] rounded px-3 py-1.5">
          {alias.alias}
        </code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/70 hover:text-white/95 border border-white/[0.10] rounded px-2 py-1.5"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <p className="text-[12px] text-white/55 mt-3 leading-relaxed">
        {alias.forwarding_instructions ??
          'Forward suspicious emails to this alias as an attachment (or with full headers). We acknowledge within 1 minute and reply with a determination within 24 hours.'}
      </p>
    </div>
  );
}

function HeadlineMetrics({
  totals, brandCount, unboundTotal,
}: {
  totals: AbuseMailboxTotals;
  brandCount: number;
  unboundTotal: number;
}) {
  const cards: Array<{
    label: string; value: number; sub: string;
    icon: LucideIcon; tone: 'crit' | 'warn' | 'neutral';
  }> = [
    {
      label: 'Brands monitored',
      value: brandCount,
      sub: `${totals.messages_total} messages routed`,
      icon: ShieldCheck,
      tone: 'neutral',
    },
    {
      label: 'Phishing + malware',
      value: totals.messages_phishing + totals.messages_malware,
      sub: `${totals.messages_phishing} phishing · ${totals.messages_malware} malware`,
      icon: AlertTriangle,
      tone: (totals.messages_phishing + totals.messages_malware) > 0 ? 'crit' : 'neutral',
    },
    {
      label: 'High / Critical',
      value: totals.messages_high_critical,
      sub: 'severity-flagged messages',
      icon: AlertTriangle,
      tone: totals.messages_high_critical > 0 ? 'warn' : 'neutral',
    },
    {
      label: 'Pending classification',
      value: totals.messages_pending + unboundTotal,
      sub: unboundTotal > 0 ? `${unboundTotal} not bound to a brand` : 'awaiting AI determination',
      icon: Inbox,
      tone: (totals.messages_pending + unboundTotal) > 0 ? 'warn' : 'neutral',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        const accent =
          c.tone === 'crit' ? 'text-sev-critical' :
          c.tone === 'warn' ? 'text-amber'        :
                              'text-white/85';
        return (
          <div key={c.label} className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
              <Icon size={11} /><span className="truncate">{c.label}</span>
            </div>
            <div className={`text-3xl font-bold tabular-nums ${accent}`}>{c.value}</div>
            <p className="text-[11px] text-white/40 mt-1 leading-relaxed">{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}

function BrandCard({
  brand: b, selected, onSelect,
}: {
  brand: AbuseMailboxBrandSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone =
    selected                       ? 'border-amber/[0.50]'        :
    b.messages_phishing + b.messages_malware > 0 ? 'border-sev-critical/[0.30]' :
    b.messages_spam > 0            ? 'border-amber/[0.30]'        :
                                     'border-white/[0.06]';
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`block w-full text-left rounded-xl border bg-bg-card p-4 transition-colors hover:border-white/[0.20] ${tone}`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white/90 truncate">{b.brand_name}</div>
          <div className="text-[11px] text-white/45 font-mono mt-0.5 truncate">{b.canonical_domain}</div>
        </div>
        {b.messages_total === 0 ? (
          <span className="text-[9px] uppercase tracking-widest font-mono text-white/30 flex-shrink-0">no messages</span>
        ) : (
          <span className="text-[9px] uppercase tracking-widest font-mono text-white/55 flex-shrink-0">
            {b.messages_total} message{b.messages_total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        <ClassChip label="phishing" count={b.messages_phishing} tone="crit" />
        <ClassChip label="malware"  count={b.messages_malware}  tone="crit" />
        <ClassChip label="pending"  count={b.messages_pending}  tone="warn" />
      </div>
    </button>
  );
}

function ClassChip({
  label, count, tone,
}: {
  label: string; count: number;
  tone: 'crit' | 'warn' | 'neutral';
}) {
  const accent =
    count === 0     ? 'text-white/35'     :
    tone === 'crit' ? 'text-sev-critical' :
    tone === 'warn' ? 'text-amber'        :
                      'text-white/85';
  return (
    <div>
      <div className="text-[8px] uppercase tracking-widest font-mono text-white/35 mb-0.5">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${accent}`}>{count}</div>
    </div>
  );
}

function MessageRow({ message: m }: { message: AbuseInboxMessageRow }) {
  const tone =
    m.classification === 'phishing' || m.classification === 'malware' ? 'border-sev-critical/[0.30]' :
    m.classification === 'ambiguous' || m.classification === 'spam'   ? 'border-amber/[0.30]'        :
                                                                        'border-white/[0.06]';
  return (
    <article className={`rounded-xl border bg-bg-card p-4 ${tone}`}>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <SeverityPill level={m.severity} />
        <ClassificationPill classification={m.classification} />
        <StatusPill status={m.status} />
        {m.url_count > 0 && (
          <span className="text-[10px] uppercase tracking-widest font-mono text-white/45">
            {m.url_count} URL{m.url_count === 1 ? '' : 's'}
          </span>
        )}
        {m.attachment_count > 0 && (
          <span className="text-[10px] uppercase tracking-widest font-mono text-white/45">
            {m.attachment_count} attachment{m.attachment_count === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="text-sm font-semibold text-white/90 truncate">{m.original_subject ?? '(no subject)'}</div>
      <div className="text-[12px] text-white/55 mt-0.5">
        from <span className="font-mono">{m.original_from ?? 'unknown'}</span>
        {m.forwarded_by_email && (
          <>
            {' '}· forwarded by <span className="font-mono">{m.forwarded_by_email}</span>
          </>
        )}
      </div>

      {m.original_body_snippet && (
        <p className="text-[12px] text-white/65 mt-2 leading-relaxed line-clamp-3 font-mono bg-black/20 border border-white/[0.04] rounded p-2">
          {m.original_body_snippet}
        </p>
      )}

      {m.classification_reason && (
        <p className="text-[11px] text-white/40 mt-2 italic">{m.classification_reason}</p>
      )}

      <div className="flex items-center gap-3 mt-3 text-[11px] font-mono text-white/40">
        <span>{formatTimestamp(m.received_at)}</span>
        {m.ai_action && m.ai_action !== 'safe' && (
          <span className={m.ai_action === 'escalate' ? 'text-sev-critical' : 'text-amber'}>
            ai: {m.ai_action}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-2">
          {m.ack_sent_at ? (
            <span className="text-green/85">ack sent</span>
          ) : (
            <span className="text-white/30">ack pending</span>
          )}
          {m.determination_sent_at ? (
            <span className="text-green/85">determination sent</span>
          ) : (
            <span className="text-white/30">determination pending</span>
          )}
        </span>
      </div>
    </article>
  );
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function SeverityPill({ level }: { level: string }) {
  const sev = (level ?? '').toLowerCase();
  const tone =
    sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    sev === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    sev === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                         'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {level}
    </span>
  );
}

function ClassificationPill({ classification }: { classification: string }) {
  const tone =
    classification === 'phishing'  || classification === 'malware'  ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    classification === 'ambiguous' || classification === 'spam'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    classification === 'pending'                                    ? 'text-white/70     bg-white/[0.06]        border-white/[0.10]'        :
                                                                      'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {classification}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'investigating' ? 'text-amber    bg-amber/[0.06]    border-amber/[0.15]' :
    status === 'resolved'      ? 'text-green/85 bg-green/[0.06]    border-green/[0.15]' :
    status === 'dismissed'     ? 'text-white/40 bg-white/[0.04]    border-white/[0.08]' :
                                 'text-white/65 bg-white/[0.04]    border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {status}
    </span>
  );
}

function NoBrands() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">No brands assigned to your organization yet.</p>
      <p className="text-white/35 text-xs mt-1">
        Contact <a className="text-amber hover:underline" href="mailto:support@averrow.com">support@averrow.com</a> to add a brand.
      </p>
    </div>
  );
}

function EmptyMessages() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">No forwarded messages yet.</p>
      <p className="text-white/35 text-xs mt-1">
        Forward suspicious mail to your alias above. Determinations and escalations land here.
      </p>
      <a
        href="https://docs.averrow.com/abuse-mailbox/setup"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-amber hover:underline text-xs mt-3"
      >
        <ExternalLink size={11} /> setup guide
      </a>
    </div>
  );
}
