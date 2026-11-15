import { useId, useState } from 'react';
import { Button } from '@/design-system/components';
import { formatDate } from '@/lib/time';
import type { KitMatch, KitMatching } from './types';

const LABEL_CLS = 'font-mono text-[11px] font-bold uppercase tracking-[0.18em]';
const MUTED = { color: 'var(--text-secondary)' } as const;

export const KIT_VISIBLE_MATCHES = 5;
export const KIT_VISIBLE_TAGS = 3;
export const KIT_DEFAULT_ATTRIBUTION = 'Rules: IOK by phish.report (ODbL)';

/** True when the capture was evaluated against the kit rules (status and commit both set). */
export function wasKitChecked(k: KitMatching | null | undefined): k is KitMatching {
  return !!k && k.status !== null && k.ruleset_commit !== null;
}

function Tag({ children }: { children: string }) {
  return (
    <span
      className="inline-block max-w-full rounded px-1.5 py-0.5 font-mono text-[11px]"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-base)', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}
    >
      {children}
    </span>
  );
}

function MatchRow({ m }: { m: KitMatch }) {
  const [allTags, setAllTags] = useState(false);
  const tags = allTags ? m.tags : m.tags.slice(0, KIT_VISIBLE_TAGS);
  const hidden = m.tags.length - tags.length;
  // Two different caveats: an APPROXIMATE field (older capture's html / requests) can over-match;
  // a SUBSET field (title, js, css, cookies, cut headers) is incomplete, so the match is real
  // but other rules may have been missed.
  const subset = m.subset_fields ?? [];
  const approxFields = m.approximate_fields.filter((f) => !subset.includes(f));
  const approx = approxFields.length > 0;
  const incomplete = subset.length > 0;
  return (
    <li className="py-2" style={{ borderTop: '1px solid var(--border-base)' }}>
      {/* Third-party string: a React text node only, never HTML or markdown. */}
      <p className="m-0 text-[13px] font-semibold" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{m.title}</p>
      {tags.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {tags.map((t, i) => <Tag key={`${i}-${t}`}>{t}</Tag>)}
          {m.tags.length > KIT_VISIBLE_TAGS && (
            <button
              type="button"
              onClick={() => setAllTags((v) => !v)}
              aria-expanded={allTags}
              aria-label={allTags ? 'Show fewer tags' : `Show ${hidden} more tags`}
              className="min-h-[24px] cursor-pointer rounded border-0 bg-transparent px-1.5 font-mono text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
              style={{ color: 'var(--primary-text)' }}
            >
              {allTags ? 'Less' : `+${hidden}`}
            </button>
          )}
        </div>
      )}
      {approx && (
        <p data-approximate className="m-0 mt-1 text-[12px]" style={MUTED}>
          <strong style={{ color: 'var(--text-primary)' }}>Approximate match.</strong>{' '}
          Matched on the rendered page ({approxFields.join(', ')}); may over-match.
        </p>
      )}
      {incomplete && (
        <p data-subset className="m-0 mt-1 text-[12px]" style={MUTED}>
          <strong style={{ color: 'var(--text-primary)' }}>Partial evidence.</strong>{' '}
          Only part of the capture's {subset.join(', ')} data was available, so this match stands but other rules may have been missed.
        </p>
      )}
    </li>
  );
}

/**
 * Phishing-kit rule matches for one capture. Context for an analyst only:
 * no alert, no severity, never "confirmed" or "attributed".
 */
export function KitMatchBlock({ kit }: { kit: KitMatching | null | undefined }) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();

  let body;
  if (!wasKitChecked(kit)) {
    body = <p className="m-0 text-[13px]" style={MUTED}>Not checked against kit rules.</p>;
  } else {
    const matches = kit.matches;
    const shown = showAll ? matches : matches.slice(0, KIT_VISIBLE_MATCHES);
    const caveat = kit.status === 'partial'
      ? 'Only some of the rules were checked.'
      : kit.status === 'truncated' ? 'Only part of the page was checked.' : null;
    body = (
      <>
        {matches.length === 0 ? (
          <p className="m-0 text-[13px]" style={{ color: 'var(--text-primary)' }}>No kit rule matched.</p>
        ) : (
          <>
            <p className="m-0 mb-1 text-[13px]" style={MUTED}>
              {matches.length === 1 ? '1 kit rule matched.' : `${matches.length} kit rules matched.`} Context for an analyst, not a verdict.
            </p>
            <ul id={listId} className="m-0 list-none p-0">
              {shown.map((m) => <MatchRow key={m.rule_id} m={m} />)}
            </ul>
            {matches.length > KIT_VISIBLE_MATCHES && (
              <div className="mt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={showAll}
                aria-controls={listId}
                onClick={() => setShowAll((s) => !s)}
              >
                {showAll ? 'Show fewer' : `Show all ${matches.length}`}
              </Button>
              </div>
            )}
          </>
        )}
        {caveat && (
          <p data-kit-caveat className="m-0 mt-1 text-[12px]" style={MUTED}>
            {caveat}{matches.length === 0 ? ' A missing match is not conclusive.' : ''}
          </p>
        )}
        <p className="m-0 mt-2 text-[12px]" style={MUTED}>
          {kit.attribution || KIT_DEFAULT_ATTRIBUTION}
          <span className="mt-0.5 block font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
            commit {kit.ruleset_commit?.slice(0, 7)}
            {kit.evaluated_at ? ` · checked ${formatDate(kit.evaluated_at)}` : ''}
          </span>
        </p>
      </>
    );
  }

  return (
    <section className="mb-3 mt-3" aria-label="Kit match" data-kit-match>
      <h5 className={`${LABEL_CLS} m-0 mb-1`} style={MUTED}>Kit match</h5>
      {body}
    </section>
  );
}
