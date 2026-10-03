// Intelligence body of the briefing shell (Home).
//
// Shows the latest Observer insight (`/api/trends/intelligence`) with its
// title and body. There are no per-sentence citations in this data, only the
// entity links Observer writes (`related_brand_ids`, `related_campaign_id`,
// `related_provider_ids`), so those render as small "source" chips that link
// to the entity instead.

import { Link } from 'react-router-dom';
import { useIntelligenceBriefings } from '@/hooks/useTrends';
import type { IntelligenceBriefing } from '@/hooks/useTrends';
import { Badge } from '@/design-system/components';
import { relativeTime } from '@/lib/time';
import { parseIdList, splitBriefing, truncateText } from '@/lib/briefing-text';
import { tabUrl } from '@/lib/workspaceRoutes';
import { BriefingShell } from './BriefingShell';

const BODY_PREVIEW = 420;
const MAX_CHIPS_PER_KIND = 3;

type ChipSeverity = 'critical' | 'high' | 'medium' | 'low';

function severityOf(raw: string | null | undefined): ChipSeverity | null {
  const s = (raw ?? '').toLowerCase();
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low' ? s : null;
}

export interface SourceChip {
  key: string;
  label: string;
  to: string;
}

/** Entity links for a briefing, as chips. Exported for tests. */
export function sourceChips(b: Pick<IntelligenceBriefing, 'related_brand_ids' | 'related_campaign_id' | 'related_provider_ids'>): {
  chips: SourceChip[];
  more: number;
} {
  const brands = parseIdList(b.related_brand_ids);
  const providers = parseIdList(b.related_provider_ids);
  const chips: SourceChip[] = [];
  let more = 0;

  const add = (kind: string, ids: string[], to: (id: string) => string) => {
    ids.slice(0, MAX_CHIPS_PER_KIND).forEach((id, i) => {
      chips.push({
        key: `${kind}:${id}`,
        label: ids.length === 1 ? kind : `${kind} ${i + 1}`,
        to: to(id),
      });
    });
    more += Math.max(0, ids.length - MAX_CHIPS_PER_KIND);
  };

  add('Brand', brands, (id) => `/brands/${encodeURIComponent(id)}`);
  add('Provider', providers, (id) => tabUrl('providers', { focus: id }));
  if (b.related_campaign_id) {
    chips.push({
      key: `campaign:${b.related_campaign_id}`,
      label: 'Campaign',
      to: `/campaigns/${encodeURIComponent(b.related_campaign_id)}`,
    });
  }
  return { chips, more };
}

function SourceChips({ briefing }: { briefing: IntelligenceBriefing }) {
  const { chips, more } = sourceChips(briefing);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Sources">
      <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
        Sources
      </span>
      {chips.map((c) => (
        <Link
          key={c.key}
          to={c.to}
          className="rounded px-2 py-1 font-mono text-[10px] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--amber-text)]"
          style={{ background: 'var(--border-base)', color: 'var(--text-primary)' }}
        >
          {c.label}
        </Link>
      ))}
      {more > 0 && (
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>+{more} more</span>
      )}
    </div>
  );
}

export function IntelligenceBriefingBody() {
  const { data, isLoading, isError, refetch } = useIntelligenceBriefings(1);
  const latest = Array.isArray(data) ? data[0] : undefined;

  // A failed fetch with nothing on screen is an error, never "no briefing".
  const status = isError && !latest ? 'error' : isLoading && !latest ? 'loading' : latest ? 'ready' : 'empty';

  const { title, body } = splitBriefing(latest?.summary);
  const sev = severityOf(latest?.severity);

  return (
    <BriefingShell
      source="intelligence"
      title="Daily briefing"
      eyebrow={<Badge status="active" label="Observer" size="xs" />}
      generatedAt={latest?.created_at}
      status={status}
      onRetry={() => { void refetch(); }}
      errorTitle="Couldn't load the daily briefing"
      emptyTitle="No briefing generated yet"
      emptyDescription="Observer publishes a briefing as threat data accumulates."
      loadingTitle="Loading the daily briefing…"
    >
      {latest && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {sev && <Badge severity={sev} size="xs" />}
            <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
              {relativeTime(latest.created_at)}
            </span>
          </div>
          <h3 className="font-display text-base font-bold leading-snug" style={{ color: 'var(--text-primary)', margin: 0 }}>
            {title}
          </h3>
          {body && (
            <>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)', margin: 0 }}>
                {truncateText(body, BODY_PREVIEW)}
              </p>
              {body.length > BODY_PREVIEW && (
                <details className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--amber-text)]" style={{ color: 'var(--amber-text)' }}>
                    Read full briefing
                  </summary>
                  <div className="mt-2 whitespace-pre-wrap leading-relaxed">{body}</div>
                </details>
              )}
            </>
          )}
          <SourceChips briefing={latest} />
          <Link
            to={tabUrl('trends')}
            className="font-mono text-[10px] uppercase tracking-widest hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--amber-text)]"
            style={{ color: 'var(--amber-text)' }}
          >
            View all briefings →
          </Link>
        </div>
      )}
    </BriefingShell>
  );
}
