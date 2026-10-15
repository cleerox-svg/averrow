/**
 * The right-hand panel's tab strip: Intel (the lens-aware intelligence panel) | Events (the event rail).
 * Rendered at the top of each, and in the phone sheet's header.
 */

export type PanelTab = 'intel' | 'events';

export interface PanelTabsProps {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  /** Events in the last hour (the "All N" number); omitted until known. */
  eventCount?: number;
  touch?: boolean;
}

export function PanelTabs({ tab, onTab, eventCount, touch = false }: PanelTabsProps) {
  const item = (id: PanelTab, label: string, count?: number) => {
    const on = tab === id;
    return (
      <button
        key={id}
        type="button"
        role="tab"
        id={`obs-panel-tab-${id}`}
        aria-selected={on}
        tabIndex={on ? 0 : -1}
        onClick={() => onTab(id)}
        onKeyDown={e => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); onTab(id === 'intel' ? 'events' : 'intel'); }
        }}
        className={`ds-focusable flex flex-1 items-center justify-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${touch ? 'min-h-[44px]' : 'min-h-[34px]'}`}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: on ? 'var(--amber-text)' : 'var(--text-tertiary)',
          borderBottom: `2px solid ${on ? 'var(--amber)' : 'transparent'}`,
        }}
      >
        {label}
        {typeof count === 'number' && count > 0 && (
          <span className="rounded-full px-1.5 text-[10px] tabular-nums" style={{ background: 'var(--amber-glow)', color: 'var(--amber-text)' }}>{count}</span>
        )}
      </button>
    );
  };
  return (
    <div role="tablist" aria-label="Panel" className="sticky top-0 z-[1] flex shrink-0" style={{ background: 'var(--bg-card-deep)', borderBottom: '1px solid var(--border-base)' }}>
      {item('intel', 'Intel')}
      {item('events', 'Events', eventCount)}
    </div>
  );
}
