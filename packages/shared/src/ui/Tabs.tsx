import * as React from 'react';
import { cn } from './cn';

export interface Tab {
  id: string;
  label: string;
  count?: number;
  /** Short text badge, e.g. "NEW". */
  badge?: string;
}

export interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (id: string) => void;
  variant?: 'pills' | 'underline' | 'bar';
  /**
   * `sm` (default) is the compact dashboard size. `md` is the legible size for
   * settings surfaces: 13px labels and a >=44px touch height.
   */
  size?: 'sm' | 'md';
  /** Sticky with blur backdrop. */
  sticky?: boolean;
  className?: string;
  /** Emit `id="tab-<id>"` + `aria-controls="tabpanel-<id>"`. Only pass when the
   *  consumer renders matching `role="tabpanel" id="tabpanel-<id>"` elements. */
  linkedPanels?: boolean;
  /** Accessible name for the tablist. */
  'aria-label'?: string;
  /** `auto`: arrow-key focus also selects. `manual` (default): Enter/Space selects. */
  activation?: 'manual' | 'auto';
}

// Outline-based (not ring/box-shadow): the active styles set an inline
// boxShadow that would override a Tailwind ring. The underline variant sits
// inside an overflow-x-auto scroller, so it uses a negative offset to keep
// the outline from being clipped.
const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber-text)]';
const FOCUS_RING_INSET =
  'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--amber-text)]';

export function Tabs({
  tabs, activeTab, onChange, variant = 'pills', size = 'sm', sticky = false, className,
  linkedPanels = false, activation = 'manual', 'aria-label': ariaLabel,
}: TabsProps) {
  const refs = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  // Roving tabindex: the active tab is the tab stop; arrow keys move focus
  // (and `rovingId`) without selecting in manual mode.
  const [rovingId, setRovingId] = React.useState<string | null>(null);
  // Exactly one tab is the tab stop: the roving one, else the active one,
  // else the first (activeTab may not exist in `tabs`).
  const tabStop =
    rovingId && tabs.some((t) => t.id === rovingId) ? rovingId
    : tabs.some((t) => t.id === activeTab) ? activeTab
    : tabs[0]?.id;

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || variant !== 'underline') return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEdges({ left: el.scrollLeft > 1, right: max > 1 && el.scrollLeft < max - 1 });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
  }, [tabs.length, variant]);

  const focusTab = (id: string) => {
    setRovingId(id);
    refs.current.get(id)?.focus();
    if (activation === 'auto') onChange(id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onChange(tabs[index]!.id);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    focusTab(tabs[next]!.id);
  };

  const listProps = {
    role: 'tablist' as const,
    'aria-label': ariaLabel,
    'aria-orientation': 'horizontal' as const,
    onBlur: (e: React.FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRovingId(null);
    },
  };

  const renderTab = (tab: Tab, index: number) => {
    const active = tab.id === activeTab;
    const common = {
      ref: (el: HTMLButtonElement | null) => {
        if (el) refs.current.set(tab.id, el); else refs.current.delete(tab.id);
      },
      id: linkedPanels ? `tab-${tab.id}` : undefined,
      role: 'tab' as const,
      type: 'button' as const,
      'aria-selected': active,
      'aria-controls': linkedPanels ? `tabpanel-${tab.id}` : undefined,
      tabIndex: tab.id === tabStop ? 0 : -1,
      onClick: () => onChange(tab.id),
      onFocus: () => setRovingId(tab.id),
      onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => onKeyDown(e, index),
    };
    const md = size === 'md';
    const count = tab.count !== undefined && (
      <span
        className="font-mono"
        style={{ fontSize: md ? 12 : variant === 'underline' ? 10 : 9, color: active ? 'var(--amber-text)' : 'var(--text-secondary)', opacity: active ? 0.8 : 1 }}
      >
        {tab.count}
      </span>
    );
    const badge = tab.badge && (
      <span
        className="rounded-full px-[5px] py-px text-[9px] font-black"
        style={{ background: active ? 'var(--amber)' : 'var(--border-strong)', color: active ? 'var(--bg-page)' : 'var(--text-secondary)' }}
      >
        {tab.badge}
      </span>
    );

    if (variant === 'underline') {
      return (
        <button
          key={tab.id}
          {...common}
          className={cn('shrink-0 inline-flex items-center gap-1.5 whitespace-nowrap px-4 py-3 text-[11px] font-bold border-b-2 bg-transparent cursor-pointer', md && 'min-h-[44px] text-[13px] max-[479px]:px-3', FOCUS_RING_INSET)}
          style={{
            borderBottomColor: active ? 'var(--amber)' : 'transparent',
            color: active ? 'var(--amber-text)' : 'var(--text-secondary)',
            transition: 'var(--transition-fast)',
          }}
        >
          {tab.label}{count}{badge}
        </button>
      );
    }
    if (variant === 'bar') {
      return (
        <button
          key={tab.id}
          {...common}
          className={cn('flex-1 inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-2 py-[7px] font-mono text-[10px] font-bold tracking-[0.08em] cursor-pointer', md && 'min-h-[44px] text-[13px]', FOCUS_RING)}
          style={{
            border: `1px solid ${active ? 'var(--pill-active-border)' : 'transparent'}`,
            background: active ? 'linear-gradient(135deg, var(--amber-glow), var(--pill-active-fill-2-strong))' : 'transparent',
            color: active ? 'var(--amber-text)' : 'var(--text-secondary)',
            boxShadow: active ? 'inset 0 1px 0 var(--pill-active-rim-strong), 0 0 12px var(--amber-glow)' : 'none',
            transition: 'var(--transition-fast)',
          }}
        >
          {tab.label}{count}{badge}
        </button>
      );
    }
    return (
      <button
        key={tab.id}
        {...common}
        className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-[14px] py-[5px] font-mono text-[10px] font-bold uppercase tracking-[0.08em] cursor-pointer', md && 'min-h-[44px] text-[13px]', FOCUS_RING)}
        style={{
          border: `1px solid ${active ? 'var(--pill-active-border)' : 'var(--border-base)'}`,
          background: active ? 'linear-gradient(135deg, var(--pill-active-fill-1), var(--pill-active-fill-2))' : 'transparent',
          color: active ? 'var(--amber-text)' : 'var(--text-secondary)',
          boxShadow: active ? 'inset 0 1px 0 var(--pill-active-rim)' : 'none',
          transition: 'var(--transition-fast)',
        }}
      >
        {tab.label}{count}{badge}
      </button>
    );
  };

  if (variant === 'bar') {
    return (
      <div
        {...listProps}
        className={cn('flex gap-[3px] rounded-xl p-1 border border-[var(--border-base)]', className)}
        style={{ background: 'var(--card-bg)', backdropFilter: 'blur(20px)', boxShadow: 'var(--card-shadow), var(--card-rim)' }}
      >
        {tabs.map(renderTab)}
      </div>
    );
  }

  if (variant === 'underline') {
    return (
      <div
        className={cn('relative', sticky && 'sticky top-0 z-10 border-b border-[var(--border-base)]', className)}
        style={sticky ? {
          background: 'linear-gradient(180deg, var(--bg-page) 0%, var(--bg-sticky-deep) 100%)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        } : undefined}
      >
        <div ref={scrollRef} {...listProps} className="flex gap-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {tabs.map(renderTab)}
        </div>
        {edges.left && (
          <div aria-hidden className={cn('pointer-events-none absolute inset-y-0 left-0', size === 'md' ? 'w-12' : 'w-6')}
            style={{ background: 'linear-gradient(90deg, var(--bg-page) 20%, transparent 100%)' }} />
        )}
        {edges.right && (
          <div aria-hidden className={cn('pointer-events-none absolute inset-y-0 right-0', size === 'md' ? 'w-12' : 'w-6')}
            style={{ background: 'linear-gradient(270deg, var(--bg-page) 20%, transparent 100%)' }} />
        )}
      </div>
    );
  }

  return (
    <div {...listProps} className={cn('flex flex-wrap gap-2', className)}>
      {tabs.map(renderTab)}
    </div>
  );
}
