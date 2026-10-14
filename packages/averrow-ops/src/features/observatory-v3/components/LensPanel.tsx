/**
 * Intelligence panel content for every lens except Threats (which keeps the global
 * overview in SidePanel): a ranked list of what that lens is about, from the lens
 * data the page already holds. Rows re-target the map + drawer.
 *
 * Same slot as the drill drawer: docked on the right at desktop widths, floating
 * over the map under the toolbar on tablets, a peek sheet on phones.
 */

import { cn } from '@/lib/cn';
import type { DrillTarget } from '../lib/drill';
import { LENS_DEFS, type LensId } from '../lib/lenses';
import type { PanelSection } from '../lib/panel-rows';

export interface LensPanelProps {
  lens: LensId;
  section: PanelSection;
  /** The lens's query is loading / failed. */
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onSelect: (target: DrillTarget) => void;
  /** `dock`: right column. `overlay`: tablet float. `sheet`: content only (inside a PeekSheet). */
  placement: 'dock' | 'overlay' | 'sheet';
  /** Replaces the lens's own question under its name (a measure of the lens can ask a different one). */
  question?: string;
  className?: string;
}

const TONE: Record<NonNullable<PanelSection['rows'][number]['tone']>, string> = {
  rising: 'var(--sev-critical-text)', falling: 'var(--sev-info-text)', neutral: 'var(--text-primary)',
};

export function LensPanel({ lens, section, loading, error, onRetry, onSelect, placement, question, className }: LensPanelProps) {
  const def = LENS_DEFS[lens];
  const body = (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--text-tertiary)' }}>{def.label}</div>
        <p className="m-0 mt-1 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{question ?? def.question}</p>
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
                    <span className="block text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{row.primary}</span>
                    {row.secondary && <span className="block font-mono text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{row.secondary}</span>}
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
          </ul>
        )}
      </section>
    </div>
  );

  if (placement === 'sheet') return <div aria-label={`${def.label} panel`} role="group">{body}</div>;

  const overlay = placement === 'overlay';
  return (
    <aside
      aria-label={`${def.label} panel`}
      className={cn(
        'absolute z-20 w-80 max-w-[calc(100%-24px)] flex flex-col overflow-y-auto animate-drawer-in motion-reduce:animate-none',
        overlay ? 'top-[60px] right-3 bottom-[88px] rounded-xl' : 'top-[60px] right-0 bottom-[76px]',
        className,
      )}
      style={{
        background: 'var(--bg-card-deep)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: overlay ? '1px solid var(--border-base)' : undefined,
        borderLeft: '1px solid var(--border-base)',
        boxShadow: overlay ? 'var(--card-shadow-elevated)' : 'var(--card-shadow-elevated), inset 1px 0 0 var(--border-base)',
      }}
    >
      {body}
    </aside>
  );
}
