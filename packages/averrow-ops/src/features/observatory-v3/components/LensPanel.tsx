/**
 * Intelligence panel content for every lens except Threats (which keeps the global
 * overview in SidePanel): a ranked list of what that lens is about, from the lens
 * data the page already holds. Rows re-target the map + drawer.
 *
 * Same slot as the drill drawer: docked on the right at desktop widths, floating
 * over the map under the toolbar on tablets, a peek sheet on phones.
 */

import type { ReactNode } from 'react';
import type { DrillTarget } from '../lib/drill';
import { LENS_DEFS, type LensId } from '../lib/lenses';
import { Badge } from '@/design-system/components';
import type { PanelSection } from '../lib/panel-rows';

export interface LensPanelProps {
  lens: LensId;
  section: PanelSection;
  /** The lens's query is loading / failed. */
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onSelect: (target: DrillTarget) => void;
  /** `dock` / `overlay`: in-flow content inside the PanelDock. `sheet`: content inside a PeekSheet, as a named group. */
  placement: 'dock' | 'overlay' | 'sheet';
  /** Replaces the lens's own question under its name (a measure of the lens can ask a different one). */
  question?: string;
  /** A one-line status under the question (e.g. a link to a view this role cannot see was set aside). */
  note?: string;
  /** A row's target is under the pointer / focused (null when it leaves): the map previews it. */
  onPreview?: (target: DrillTarget | null) => void;
  /** Extra content after the list (e.g. the Operations lens's shared-infrastructure toggle). */
  aside?: ReactNode;
}

/** Two joined dots: this row's links are drawn on the map. */
function LinkedGlyph() {
  return (
    <span className="inline-flex shrink-0" title="Links drawn on the map">
      <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true" focusable="false">
        <line x1="3" y1="5" x2="13" y2="5" stroke="var(--cyan-text, #7aeaff)" strokeWidth="1.5" strokeDasharray="2.5 1.5" />
        <circle cx="2.5" cy="5" r="2" fill="var(--cyan-text, #7aeaff)" />
        <circle cx="13.5" cy="5" r="2" fill="var(--cyan-text, #7aeaff)" />
      </svg>
      <span className="sr-only">links drawn on the map</span>
    </span>
  );
}

const TONE: Record<NonNullable<PanelSection['rows'][number]['tone']>, string> = {
  rising: 'var(--sev-critical-text)', falling: 'var(--sev-info-text)', neutral: 'var(--text-primary)',
};

export function LensPanel({ lens, section, loading, error, onRetry, onSelect, placement, question, note, onPreview, aside }: LensPanelProps) {
  const def = LENS_DEFS[lens];
  const body = (
    <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--text-tertiary)' }}>{def.label}</div>
        <p className="m-0 mt-1 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{question ?? def.question}</p>
        {note && <p role="status" className="m-0 mt-1.5 font-mono text-[11px]" style={{ color: 'var(--amber-text)' }}>{note}</p>}
      </div>
      <section aria-label={section.title} className="flex flex-col">
        <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] m-0 mb-2" style={{ color: 'var(--text-tertiary)' }}>
          {section.title}{section.rows.length > 0 ? ` · ${section.rows.length}` : ''}
        </h2>
        {error && section.rows.length === 0 ? (
          <div role="alert" className="flex items-center justify-between gap-2 px-2 py-1.5 rounded" style={{ background: 'var(--sev-critical-bg)', border: '1px solid var(--sev-critical-border)' }}>
            <span className="font-mono text-[11px]" style={{ color: 'var(--sev-critical-text)' }}>Failed to load</span>
            <button type="button" onClick={onRetry} className="ds-focusable font-mono text-[11px] font-bold uppercase" style={{ background: 'none', border: 'none', color: 'var(--sev-critical-text)', cursor: 'pointer', padding: 0 }}>Retry</button>
          </div>
        ) : loading && section.rows.length === 0 ? (
          <div role="status" className="font-mono text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>Loading…</div>
        ) : section.rows.length === 0 ? (
          <div className="font-mono text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>{section.empty}</div>
        ) : (
          <ul className="list-none p-0 m-0 flex flex-col">
            {section.rows.map(row => {
              const inner = (
                <>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="flex items-center gap-1.5 min-w-0">
                      {row.linked && <LinkedGlyph />}
                      <span className="block text-xs font-medium truncate min-w-0" style={{ color: 'var(--text-primary)' }}>{row.primary}</span>
                      {/* The tier badge never truncates: the NAME gives way, so the evidence stays readable. */}
                      {row.badge && <span className="shrink-0"><Badge context="nexus" size="xs" label={row.badge} /></span>}
                    </span>
                    {row.secondary && <span className="block font-mono text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{row.secondary}</span>}
                  </span>
                  {row.trailing && (
                    <span className="font-mono text-xs font-bold tabular-nums shrink-0" style={{ color: TONE[row.tone ?? 'neutral'] }}>{row.trailing}</span>
                  )}
                </>
              );
              return (
                <li key={row.key}>
                  {row.target ? (
                    <button
                      type="button"
                      onClick={() => onSelect(row.target!)}
                      onMouseEnter={onPreview ? () => onPreview(row.target!) : undefined}
                      onMouseLeave={onPreview ? () => onPreview(null) : undefined}
                      onFocus={onPreview ? () => onPreview(row.target!) : undefined}
                      onBlur={onPreview ? () => onPreview(null) : undefined}
                      className="ds-focusable w-full flex items-center gap-3 rounded-md px-1.5 py-1.5 min-h-[44px] sm:min-h-[40px] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] transition-colors motion-reduce:transition-none"
                      style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className="w-full flex items-center gap-3 px-1.5 py-1.5 min-h-[40px]">{inner}</div>
                  )}
                </li>
              );
            })}
            {section.more !== undefined && section.more > 0 && (
              <li className="font-mono text-[11px] px-1.5 py-1.5" style={{ color: 'var(--text-muted)' }}>
                {`+${section.more.toLocaleString()} more — search or filter`}
              </li>
            )}
          </ul>
        )}
      </section>
      {aside}
    </div>
  );

  // Docked / floating, the PanelDock owns the aside, the tab strip and the scroll; inside a PeekSheet it is a named group.
  return placement === 'sheet' ? <div aria-label={`${def.label} panel`} role="group">{body}</div> : body;
}
