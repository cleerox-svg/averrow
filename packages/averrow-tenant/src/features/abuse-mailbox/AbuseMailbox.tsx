// Abuse Mailbox — primary tenant surface.
//
// Shows the org's verify alias (so employees know where to forward
// suspicious emails), per-brand classification rollup, and a unified
// inbox of recent messages. Drill-down by brand via ?brandId.
//
// Phase B sprint 6.

import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, ShieldCheck, Mail, Inbox, Copy, Check, ChevronDown, ExternalLink, type LucideIcon } from 'lucide-react';
import {
  useAbuseMailboxSummary,
  useAbuseInboxMessages,
  useAbuseInboxMessageDetail,
  type AbuseMailboxBrandSummary,
  type AbuseMailboxTotals,
  type AbuseAlias,
  type AbuseInboxMessageRow,
  type AbuseInboxMessageDetail,
  type ExtractedUrl,
  type ExtractedAttachment,
} from '@/lib/abuseMailboxModule';

export function AbuseMailbox() {
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  // PR-AO: per-message drill-down state. Parity with the ops surface.
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
                  {messagesQ.data.messages.map((m) => (
                    <Fragment key={m.id}>
                      <MessageRow
                        message={m}
                        expanded={selectedId === m.id}
                        onToggle={() => setSelectedId(prev => prev === m.id ? null : m.id)}
                      />
                      {selectedId === m.id && <TenantMessageDetail message={m} />}
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

function MessageRow({ message: m, expanded, onToggle }: {
  message: AbuseInboxMessageRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tone =
    m.classification === 'phishing' || m.classification === 'malware' ? 'border-sev-critical/[0.30]' :
    m.classification === 'ambiguous' || m.classification === 'spam'   ? 'border-amber/[0.30]'        :
                                                                        'border-white/[0.06]';
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full text-left rounded-xl border bg-bg-card p-4 transition-all hover:bg-white/[0.02] ${tone} ${expanded ? 'ring-1 ring-amber/40' : ''}`}
    >
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <SeverityPill level={m.severity} />
        <ClassificationPill classification={m.classification} />
        <StatusPill status={m.status} />
        {m.throttled === 1 && (
          <span
            className="text-[10px] uppercase tracking-widest font-mono text-amber bg-amber/[0.10] border border-amber/[0.30] rounded px-1.5 py-0.5"
            title={tenantThrottleReasonLabel(m.throttle_reason)}
          >
            rate-limited
          </span>
        )}
        {m.url_count > 0 && (
          <span className="text-[10px] uppercase tracking-widest font-mono text-white/70">
            {m.url_count} URL{m.url_count === 1 ? '' : 's'}
          </span>
        )}
        {m.attachment_count > 0 && (
          <span className="text-[10px] uppercase tracking-widest font-mono text-white/70">
            {m.attachment_count} attachment{m.attachment_count === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* PR-AO: text contrast bumped (90→95, 55→75). Sender fallback to
          forwarded_by_email when original_from is null so direct
          submissions (no forwarded chunk) show a sender anyway. */}
      <div className="text-sm font-semibold text-white/95 truncate">
        {m.original_subject ?? <span className="italic text-white/55">(no subject)</span>}
      </div>
      <div className="text-[12px] text-white/75 mt-0.5">
        from <span className="font-mono text-[var(--amber)]">{m.original_from ?? m.forwarded_by_email ?? 'unknown'}</span>
        {m.original_from && m.forwarded_by_email && m.original_from !== m.forwarded_by_email && (
          <>
            {' '}· forwarded by <span className="font-mono text-white/90">{m.forwarded_by_email}</span>
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
          <ChevronDown
            size={12}
            className="text-white/45"
            style={{ transition: 'transform 0.18s ease', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
          />
        </span>
      </div>
    </button>
  );
}

// PR-AO drill-down + PR-AS raw capture. Tenant version of
// MessageDetail — structurally uniform with the ops surface
// (AdminAbuseMailbox.tsx). Raw fields (full body, headers, URL list,
// attachments) are lazy-loaded on expand via the detail endpoint.
function TenantMessageDetail({ message: m }: { message: AbuseInboxMessageRow }) {
  const detailQ = useAbuseInboxMessageDetail(m.id);
  const detail = detailQ.data;
  return (
    <article className="rounded-xl border bg-bg-card p-5 -mt-1 border-amber/30">
      <div className="mb-4">
        <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Subject</div>
        <div className="text-[14px] text-white font-medium">
          {m.original_subject ?? <span className="italic text-white/45">(no subject)</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 mb-4">
        <TenantDetailField label="From"              value={m.original_from} mono accent />
        <TenantDetailField label="Forwarded by"      value={m.forwarded_by_email} mono />
        <TenantDetailField label="Inbound alias"     value={m.inbound_alias} mono />
        <TenantDetailField label="Received"          value={m.received_at} />
        <TenantDetailField label="Classification"    value={m.classification} mono uppercase />
        <TenantDetailField label="Severity"          value={(m.severity ?? '').toUpperCase()} mono />
        <TenantDetailField label="Status"            value={m.status} mono uppercase />
        <TenantDetailField label="AI action"         value={m.ai_action} mono uppercase />
        <TenantDetailField label="Classified by"     value={m.classified_by} mono />
        <TenantDetailField label="Confidence"        value={m.classification_confidence != null ? `${m.classification_confidence}%` : null} />
        <TenantDetailField label="URLs in body"      value={String(m.url_count)} />
        <TenantDetailField label="Attachments"       value={String(m.attachment_count)} />
        <TenantDetailField label="Ack sent"          value={m.ack_sent_at} />
        <TenantDetailField label="Determination sent" value={m.determination_sent_at} />
        {m.throttled === 1 && (
          <TenantDetailField label="Rate-limited" value={tenantThrottleReasonLabel(m.throttle_reason)} accent />
        )}
        {detail?.raw_size_bytes != null && (
          <TenantDetailField label="Raw size" value={formatBytes(detail.raw_size_bytes)} mono />
        )}
      </div>

      {(m.classification_reason || m.ai_assessment) && (
        <div className="mb-4">
          <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">AI analyst notes</div>
          <p className="text-[12px] text-white/90 leading-relaxed">
            {m.classification_reason || m.ai_assessment}
          </p>
          {m.classification_reason && m.ai_assessment && m.ai_assessment !== m.classification_reason && (
            <p className="text-[11px] text-white/65 mt-1 leading-relaxed italic">
              {m.ai_assessment}
            </p>
          )}
        </div>
      )}

      <TenantPlatformIntelSection detail={detail} loading={detailQ.isLoading} />

      <TenantRawCaptureSections detailQ={detailQ} detail={detail} snippet={m.original_body_snippet} />

      <div className="mt-4 pt-3 border-t border-white/[0.06]">
        <div className="flex items-center gap-2 text-[10px] font-mono text-white/55">
          <span>ref:</span>
          <code className="text-white/85">{m.id}</code>
        </div>
      </div>
    </article>
  );
}

// ─── PR-AX platform-intelligence section (tenant parity) ────────

function TenantPlatformIntelSection({
  detail, loading,
}: {
  detail: AbuseInboxMessageDetail | null | undefined;
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
      <div className="rounded-lg p-3 grid grid-cols-1 md:grid-cols-2 gap-3 bg-black/20 border border-white/[0.05]">
        {auth && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Email auth</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <TenantAuthPill label="SPF"   verdict={auth.spf} />
              <TenantAuthPill label="DKIM"  verdict={auth.dkim} />
              <TenantAuthPill label="DMARC" verdict={auth.dmarc} />
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
              <span className="text-amber font-semibold">{correlatedCount}</span> URL/domain
              {correlatedCount === 1 ? '' : 's'} already in threat intel
            </div>
          </div>
        )}
        {promotedCount > 0 && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-1">Promoted to platform</div>
            <div className="text-[12px] text-white/90">
              <span className="text-green font-semibold">{promotedCount}</span> threat
              {promotedCount === 1 ? '' : 's'} written
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TenantAuthPill({ label, verdict }: { label: string; verdict: string | null }) {
  if (!verdict) {
    return (
      <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border border-white/[0.08] text-white/40">
        {label}: —
      </span>
    );
  }
  const isPass = verdict === 'pass';
  const isFail = verdict === 'fail' || verdict === 'permerror';
  const tone = isPass
    ? 'text-green bg-green/[0.10] border-green/[0.30]'
    : isFail
      ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.30]'
      : 'text-amber bg-amber/[0.10] border-amber/[0.30]';
  return (
    <span className={`text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border ${tone}`}>
      {label}: {verdict}
    </span>
  );
}

// ─── PR-AS raw-capture sections (tenant parity with ops) ────────

type TenantRawTab = 'body' | 'urls' | 'headers' | 'attachments';

function TenantRawCaptureSections({
  detailQ, detail, snippet,
}: {
  detailQ: ReturnType<typeof useAbuseInboxMessageDetail>;
  detail:  AbuseInboxMessageDetail | null | undefined;
  snippet: string | null;
}) {
  const [tab, setTab] = useState<TenantRawTab>('body');
  const urls = detail?.extracted_urls ?? [];
  const attachments = detail?.attachment_names ?? [];
  const headerEntries: Array<[string, string]> = detail?.raw_headers
    ? Object.entries(detail.raw_headers)
    : [];
  const counts = {
    body:        detail?.raw_body ? formatBytes(detail.raw_body.length) : (snippet ? '500' : '—'),
    urls:        String(urls.length),
    headers:     String(headerEntries.length),
    attachments: String(attachments.length),
  };
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1 mb-3 border-b border-white/[0.06] pb-2">
        <TenantRawTabButton label="Body"        count={counts.body}        active={tab === 'body'}        onClick={() => setTab('body')} />
        <TenantRawTabButton label="URLs"        count={counts.urls}        active={tab === 'urls'}        onClick={() => setTab('urls')} />
        <TenantRawTabButton label="Headers"     count={counts.headers}     active={tab === 'headers'}     onClick={() => setTab('headers')} />
        <TenantRawTabButton label="Attachments" count={counts.attachments} active={tab === 'attachments'} onClick={() => setTab('attachments')} />
        {detailQ.isLoading && (
          <span className="ml-auto text-[10px] font-mono text-white/45">loading…</span>
        )}
      </div>

      {tab === 'body' && <TenantBodyPanel rawBody={detail?.raw_body ?? null} snippet={snippet} />}
      {tab === 'urls' && <TenantUrlsPanel urls={urls} loading={detailQ.isLoading} />}
      {tab === 'headers' && <TenantHeadersPanel entries={headerEntries} loading={detailQ.isLoading} />}
      {tab === 'attachments' && <TenantAttachmentsPanel attachments={attachments} loading={detailQ.isLoading} />}
    </div>
  );
}

function TenantRawTabButton({
  label, count, active, onClick,
}: { label: string; count: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-[11px] font-mono transition-colors border ${
        active
          ? 'bg-amber/[0.10] text-amber border-amber/[0.30]'
          : 'bg-transparent text-white/65 border-transparent hover:text-white/85'
      }`}
    >
      <span className="uppercase tracking-wider">{label}</span>
      <span className="ml-1.5 text-white/45">{count}</span>
    </button>
  );
}

function TenantBodyPanel({ rawBody, snippet }: { rawBody: string | null; snippet: string | null }) {
  const content = rawBody ?? snippet;
  if (!content) return <TenantEmptyPanel text="No body captured" />;
  return (
    <div>
      {!rawBody && snippet && (
        <p className="text-[10px] text-white/45 mb-2 font-mono">
          Raw body not captured for this message. Showing the 500-char snippet.
        </p>
      )}
      <pre
        className="text-[11px] text-white/85 leading-relaxed whitespace-pre-wrap break-words rounded-lg p-3 font-mono bg-black/30 border border-white/[0.05]"
        style={{ maxHeight: 360, overflow: 'auto' }}
      >
        {content}
      </pre>
    </div>
  );
}

function TenantUrlsPanel({ urls, loading }: { urls: ExtractedUrl[]; loading: boolean }) {
  if (loading) return <TenantLoadingPanel />;
  if (urls.length === 0) return <TenantEmptyPanel text="No URLs found in the body" />;
  return (
    <div className="rounded-lg overflow-hidden bg-black/30 border border-white/[0.05]">
      <div className="max-h-72 overflow-auto divide-y divide-white/[0.04]">
        {urls.map((u, i) => (
          <div key={`${u.url}-${i}`} className="px-3 py-2 flex items-center gap-2">
            {u.domain && (
              <span className="text-[10px] font-mono uppercase tracking-wider text-amber min-w-0 shrink-0">
                {u.domain}
              </span>
            )}
            {u.count > 1 && (
              <span className="text-[9px] font-mono text-white/45 shrink-0">×{u.count}</span>
            )}
            <code className="text-[11px] text-white/85 font-mono break-all flex-1 min-w-0">{u.url}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function TenantHeadersPanel({ entries, loading }: { entries: Array<[string, string]>; loading: boolean }) {
  if (loading) return <TenantLoadingPanel />;
  if (entries.length === 0) return <TenantEmptyPanel text="No headers captured" />;
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
    <div className="rounded-lg overflow-hidden bg-black/30 border border-white/[0.05]">
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-[11px] font-mono">
          <tbody className="divide-y divide-white/[0.04]">
            {sorted.map(([k, v]) => (
              <tr key={k}>
                <td className="align-top px-3 py-1.5 text-amber whitespace-nowrap">{k}</td>
                <td className="align-top px-3 py-1.5 text-white/85 break-all">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TenantAttachmentsPanel({ attachments, loading }: { attachments: ExtractedAttachment[]; loading: boolean }) {
  if (loading) return <TenantLoadingPanel />;
  if (attachments.length === 0) return <TenantEmptyPanel text="No attachments" />;
  return (
    <div className="rounded-lg overflow-hidden bg-black/30 border border-white/[0.05]">
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

function TenantEmptyPanel({ text }: { text: string }) {
  return (
    <div className="rounded-lg px-4 py-6 text-center text-[12px] text-white/45 font-mono bg-black/20 border border-white/[0.04]">
      {text}
    </div>
  );
}

function TenantLoadingPanel() {
  return (
    <div className="rounded-lg px-4 py-6 text-center text-[12px] text-white/50 font-mono bg-black/20 border border-white/[0.04]">
      Loading…
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function tenantThrottleReasonLabel(reason: string | null | undefined): string {
  if (reason === 'sender_rate_limit') return 'Sender exceeded 20 messages in the last 60 minutes';
  if (reason === 'domain_rate_limit') return 'Sending domain exceeded 50 messages in the last 60 minutes';
  return 'Rate-limited at capture';
}

function TenantDetailField({ label, value, mono, accent, uppercase }: {
  label:     string;
  value:     string | null | undefined;
  mono?:     boolean;
  accent?:   boolean;
  uppercase?: boolean;
}) {
  return (
    <div>
      <div className="text-[9px] font-mono uppercase tracking-widest text-white/55 mb-0.5">{label}</div>
      <div
        className={`text-[12px] break-all ${mono ? 'font-mono' : ''} ${uppercase ? 'uppercase' : ''} ${accent ? 'text-amber' : 'text-white/92'}`}
      >
        {value ?? <span className="text-white/35">—</span>}
      </div>
    </div>
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
