// Dark Web Monitoring — per-brand drill-down.
//
// Lists dark_web_mentions rows for one brand with classification +
// severity pills, source badge, content snippet, matched terms.
//
// Phase B sprint 5.

import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  useBrandDarkWebFindings,
  useDarkWebModuleSummary,
  SOURCE_LABELS,
  MATCH_TYPE_LABELS,
  type DarkWebMentionRow,
} from '@/lib/darkWebModule';

export function BrandDarkWebFindings() {
  const { brandId } = useParams<{ brandId: string }>();
  const { data: summary } = useDarkWebModuleSummary();
  const { data, isLoading, error } = useBrandDarkWebFindings(brandId ?? null);

  const brand = summary?.brands.find((b) => b.brand_id === brandId);

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/modules/dark-web" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO DARK WEB
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Dark Web Monitoring · Brand</div>
        <h1 className="text-[28px] font-bold text-white tracking-tight">{brand?.brand_name ?? brandId}</h1>
        <p className="mt-1 text-sm text-white/55 font-mono">{brand?.canonical_domain ?? ''}</p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading mentions…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load mentions</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        data.mentions.length === 0 ? (
          <EmptyState />
        ) : (
          <MentionsSection rows={data.mentions} />
        )
      )}
    </div>
  );
}

function MentionsSection({ rows }: { rows: DarkWebMentionRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
        Mentions <span className="text-white/30">({rows.length})</span>
      </h2>
      <div className="space-y-2">
        {rows.map((m) => <MentionRow key={m.id} mention={m} />)}
      </div>
    </section>
  );
}

function MentionRow({ mention: m }: { mention: DarkWebMentionRow }) {
  const tone =
    m.classification === 'confirmed'  ? 'border-sev-critical/[0.30]' :
    m.classification === 'suspicious' ? 'border-amber/[0.30]'        :
                                        'border-white/[0.06]';
  const matchedTerms = parseMatchedTerms(m.matched_terms);
  const postedAt = m.posted_at ?? m.first_seen;

  return (
    <article className={`rounded-xl border bg-bg-card p-4 ${tone}`}>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <SourceChip source={m.source} />
        <SeverityPill level={m.severity} />
        <ClassificationPill classification={m.classification} />
        {m.match_type && <MatchTypeChip matchType={m.match_type} />}
      </div>

      {m.source_channel && (
        <div className="text-[12px] text-white/65 mb-1">
          <span className="text-white/40">in </span>
          <span className="font-mono">{m.source_channel}</span>
          {m.source_author && (
            <>
              <span className="text-white/40"> by </span>
              <span className="font-mono">{m.source_author}</span>
            </>
          )}
        </div>
      )}

      {m.content_snippet && (
        <p className="text-[13px] text-white/75 mt-2 leading-relaxed line-clamp-3 font-mono bg-black/20 border border-white/[0.04] rounded p-2">
          {m.content_snippet}
        </p>
      )}

      {m.classification_reason && (
        <p className="text-[11px] text-white/40 mt-2 italic">{m.classification_reason}</p>
      )}

      {matchedTerms.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          <span className="text-[10px] uppercase tracking-widest font-mono text-white/35">matched</span>
          {matchedTerms.map((t) => (
            <span key={t} className="text-[11px] font-mono text-amber/80 bg-amber/[0.06] border border-amber/[0.15] rounded px-1.5 py-0.5">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 mt-3 text-[11px] font-mono text-white/40">
        <span>{formatPostedAt(postedAt)}</span>
        {m.ai_action && m.ai_action !== 'safe' && (
          <span className={m.ai_action === 'escalate' ? 'text-sev-critical' : 'text-amber'}>
            ai: {m.ai_action}
          </span>
        )}
        {m.source_url && (
          <a
            href={m.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-amber hover:underline ml-auto"
          >
            <ExternalLink size={11} /> view source
          </a>
        )}
      </div>
    </article>
  );
}

function parseMatchedTerms(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function formatPostedAt(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function SourceChip({ source }: { source: string }) {
  return (
    <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

function MatchTypeChip({ matchType }: { matchType: string }) {
  return (
    <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-blue/85 bg-blue/[0.06] border border-blue/[0.15] rounded px-1.5 py-0.5">
      {MATCH_TYPE_LABELS[matchType] ?? matchType}
    </span>
  );
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
    classification === 'confirmed'      ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    classification === 'suspicious'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    classification === 'false_positive' ? 'text-white/40     bg-white/[0.04]        border-white/[0.08]'        :
    classification === 'resolved'       ? 'text-white/55     bg-white/[0.06]        border-white/[0.10]'        :
                                          'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {classification}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">No active dark web mentions for this brand.</p>
      <p className="text-white/35 text-xs mt-1">Findings appear here as paste archives, Telegram channels, and breach feeds get scanned.</p>
    </div>
  );
}
