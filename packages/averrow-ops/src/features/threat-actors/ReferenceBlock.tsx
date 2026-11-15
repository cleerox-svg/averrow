import { useId, useState } from 'react';
import { Card } from '@/design-system/components';
import type { ActorReference } from '@/hooks/useThreatActors';

const LABEL_CLS = 'font-mono text-[11px] font-bold uppercase tracking-[0.18em]';
const MUTED = { color: 'var(--text-secondary)' } as const;

export const REFERENCE_VISIBLE_ALIASES = 8;
/** Descriptions longer than this are clamped behind "Show more". */
export const REFERENCE_DESCRIPTION_CLAMP_CHARS = 280;

const TOGGLE_CLS =
  'min-h-[24px] cursor-pointer rounded border-0 bg-transparent px-1.5 font-mono text-[11px] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ' +
  '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11';

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function Chip({ children }: { children: string }) {
  return (
    <span
      className="inline-block max-w-full rounded px-1.5 py-0.5 font-mono text-[11px]"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-base)', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}
    >
      {children}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="m-0 text-[13px]" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{value}</dd>
    </div>
  );
}

/**
 * Public reference entry (MISP Galaxy) for a threat actor. Context only: a third
 * party's naming and suspicion, not Averrow's attribution, so no severity styling
 * and no "attributed"/"confirmed" wording. Every third-party string is a React
 * text node (never HTML or markdown).
 */
export function ReferenceBlock({ reference }: { reference: ActorReference | null | undefined }) {
  const [allAliases, setAllAliases] = useState(false);
  const [fullText, setFullText] = useState(false);
  const aliasId = useId();
  const descId = useId();

  if (!reference) {
    return (
      <p data-actor-reference="none" className="m-0 text-[12px]" style={MUTED}>
        No public reference entry matched.
      </p>
    );
  }

  const aliases = reference.aliases;
  const shownAliases = allAliases ? aliases : aliases.slice(0, REFERENCE_VISIBLE_ALIASES);
  const hidden = aliases.length - shownAliases.length;
  const desc = reference.description?.trim() ?? '';
  const longDesc = desc.length > REFERENCE_DESCRIPTION_CLAMP_CHARS;
  const matchedDiffers = !!reference.matched_on && !sameName(reference.matched_on, reference.name);

  return (
    <section aria-label="Public reference" data-actor-reference="matched">
      <Card padding="md">
        <h2 className={`${LABEL_CLS} m-0 mb-1`} style={MUTED}>Public reference</h2>
        <p className="m-0 text-[12px]" style={MUTED}>
          Naming context from a public dataset. Not Averrow&apos;s attribution.
        </p>

        <p className="m-0 mt-2 text-[14px] font-semibold" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
          {reference.name}
        </p>
        {matchedDiffers && (
          <p data-matched-on className="m-0 text-[12px]" style={MUTED}>
            Matched on <span className="font-mono" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{reference.matched_on}</span>
          </p>
        )}

        {aliases.length > 0 && (
          <div id={aliasId} className="mt-2 flex flex-wrap items-center gap-1" data-aliases>
            {shownAliases.map((a, i) => (
              <Chip key={`${i}-${a}`}>{a}</Chip>
            ))}
            {aliases.length > REFERENCE_VISIBLE_ALIASES && (
              <button
                type="button"
                onClick={() => setAllAliases((v) => !v)}
                aria-expanded={allAliases}
                aria-controls={aliasId}
                aria-label={allAliases ? 'Show fewer aliases' : `Show ${hidden} more aliases`}
                className={TOGGLE_CLS}
                style={{ color: 'var(--primary-text)' }}
              >
                {allAliases ? 'Less' : `+${hidden}`}
              </button>
            )}
          </div>
        )}

        {(reference.country_code || reference.state_sponsor) && (
          <dl className="m-0 mt-3 flex flex-wrap gap-x-6 gap-y-2">
            {reference.country_code && <Fact label="Country (per MISP Galaxy)" value={reference.country_code} />}
            {reference.state_sponsor && <Fact label="Suspected sponsor (per MISP Galaxy)" value={reference.state_sponsor} />}
          </dl>
        )}

        {desc && (
          <div className="mt-3">
            <p
              id={descId}
              data-description
              className={`m-0 text-[13px] leading-relaxed ${longDesc && !fullText ? 'line-clamp-4' : ''}`}
              style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}
            >
              {desc}
            </p>
            {longDesc && (
              <button
                type="button"
                onClick={() => setFullText((v) => !v)}
                aria-expanded={fullText}
                aria-controls={descId}
                className={`${TOGGLE_CLS} -ml-1.5 mt-0.5`}
                style={{ color: 'var(--primary-text)' }}
              >
                {fullText ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}

        <p data-credit className="m-0 mt-3 text-[12px]" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          {reference.credit}
        </p>
      </Card>
    </section>
  );
}
