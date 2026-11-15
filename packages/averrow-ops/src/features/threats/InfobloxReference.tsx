import { useQuery } from '@tanstack/react-query';
import { Card } from '@/design-system/components';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/time';

const LABEL_CLS = 'font-mono text-[11px] font-bold uppercase tracking-[0.18em]';
const MUTED = { color: 'var(--text-secondary)' } as const;
const LINK_CLS =
  'rounded underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]';

export interface InfobloxMatch {
  indicator: string;
  indicator_type: string;
  match: 'exact' | 'parent_domain';
  infoblox_label: string;
  label_kind: 'actor' | 'campaign';
  classification: string | null;
  detected_date: string | null;
  source_file: string;
  publication_url: string | null;
  updated_at: string;
}

export interface InfobloxReferenceData {
  label_note: string;
  credit: string;
  licence_url: string;
  matches: InfobloxMatch[];
}

interface ThreatDetail {
  infoblox_reference?: InfobloxReferenceData | null;
}

/** Only http(s) publication links are rendered as links. */
function safeHref(u: string | null): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null;
  } catch {
    return null;
  }
}

function MatchRow({ m }: { m: InfobloxMatch }) {
  const href = safeHref(m.publication_url);
  const how = m.match === 'exact' ? 'exact match' : 'parent domain';
  return (
    <li className="py-2" style={{ borderTop: '1px solid var(--border-base)' }}>
      {/* Third-party strings: React text nodes only, never HTML. */}
      <p className="m-0 text-[13px]" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
        <span className="font-semibold">{m.infoblox_label}</span>
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}> · {m.label_kind}</span>
      </p>
      <p className="m-0 mt-0.5 text-[12px]" style={{ ...MUTED, overflowWrap: 'anywhere' }}>
        <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{m.indicator}</span>
        {' '}({how})
        {m.detected_date && <> · detected {formatDate(m.detected_date)}</>}
      </p>
      {href && (
        <p className="m-0 mt-0.5 text-[12px]">
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={`${LINK_CLS} inline-flex min-h-[24px] items-center max-sm:min-h-11`}
            style={{ color: 'var(--primary-text)' }}
          >
            Infoblox publication<span className="sr-only"> for {m.infoblox_label} (opens in a new tab)</span>
          </a>
        </p>
      )}
    </li>
  );
}

/** Presentational block: renders nothing when there is no match. */
export function InfobloxReferenceBlock({ reference }: { reference: InfobloxReferenceData | null | undefined }) {
  if (!reference || reference.matches.length === 0) return null;
  const licence = safeHref(reference.licence_url);
  return (
    <section
      aria-label="Infoblox reference"
      data-infoblox-reference
      className="mt-3"
      // The table detail row spans the full (horizontally scrolling) table; keep this block
      // pinned to the visible width on phones so its text wraps instead of being clipped.
      style={{ position: 'sticky', left: 0, width: 'min(100%, calc(100vw - 6.5rem))' }}
    >
      <Card padding="md">
        <h3 className={`${LABEL_CLS} m-0 mb-1`} style={MUTED}>Infoblox reference</h3>
        <p data-label-note className="m-0 text-[12px]" style={MUTED}>{reference.label_note}</p>
        <ul className="m-0 mt-2 list-none p-0">
          {reference.matches.map((m, i) => <MatchRow key={`${i}-${m.source_file}-${m.indicator}`} m={m} />)}
        </ul>
        <p data-credit className="m-0 mt-2 text-[12px]" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          {reference.credit}
          {licence && (
            <>
              {' '}
              <a href={licence} target="_blank" rel="noopener noreferrer" className={LINK_CLS} style={{ color: 'var(--primary-text)' }}>
                Licence<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          )}
        </p>
      </Card>
    </section>
  );
}

/** Fetches the staff threat detail only while the row is open. */
export function ThreatInfobloxReference({ threatId, open }: { threatId: string; open: boolean }) {
  const { data } = useQuery({
    queryKey: ['threat-detail', threatId],
    enabled: open,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await api.get<ThreatDetail>(`/api/threats/${encodeURIComponent(threatId)}`);
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed');
      return res.data;
    },
  });
  return <InfobloxReferenceBlock reference={data?.infoblox_reference} />;
}
