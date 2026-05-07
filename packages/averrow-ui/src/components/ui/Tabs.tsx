// Averrow Design System — Tabs v2.0
// Drop-in replacement. Same import path, backward-compatible API.
// Three visual variants: pills (default), underline, bar.

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface Tab {
  id:      string;
  label:   string;
  count?:  number;
  badge?:  string;     // short text badge e.g. "NEW", "3"
}

export interface TabsProps {
  tabs:      Tab[];
  activeTab: string;
  onChange:  (id: string) => void;
  variant?:  'pills' | 'underline' | 'bar';
  sticky?:   boolean;  // position sticky with blur backdrop
  className?: string;
}

export function Tabs({
  tabs,
  activeTab,
  onChange,
  variant   = 'pills',
  sticky    = false,
  className = '',
}: TabsProps) {

  if (variant === 'underline') {
    return <UnderlineTabs tabs={tabs} activeTab={activeTab} onChange={onChange} sticky={sticky} className={className} />;
  }

  if (variant === 'bar') {
    return (
      <div
        className={cn(className)}
        style={{
          display:      'flex',
          gap:          3,
          padding:      4,
          borderRadius: 12,
          background:   'var(--card-bg)',
          backdropFilter: 'blur(20px)',
          border:       '1px solid var(--border-base)',
          boxShadow:    'var(--card-shadow), var(--card-rim)',
        }}
      >
        {tabs.map(tab => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              style={{
                flex:          1,
                padding:       '7px 0',
                borderRadius:  9,
                fontSize:      10,
                fontWeight:    700,
                fontFamily:    'var(--font-mono)',
                letterSpacing: '0.08em',
                cursor:        'pointer',
                outline:       'none',
                border:        `1px solid ${active ? 'var(--amber-border)' : 'transparent'}`,
                background:    active
                  ? 'linear-gradient(135deg, var(--amber-glow), rgba(229,168,50,0.08))'
                  : 'transparent',
                color:         active ? 'var(--amber)' : 'var(--text-tertiary)',
                boxShadow:     active
                  ? 'inset 0 1px 0 rgba(229,168,50,0.25), 0 0 12px var(--amber-glow)'
                  : 'none',
                transition:    'var(--transition-fast)',
                whiteSpace:    'nowrap',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    );
  }

  // Default: pills variant — fall through
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {tabs.map(tab => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            style={{
              fontSize:      10,
              fontWeight:    700,
              fontFamily:    'var(--font-mono)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding:       '5px 14px',
              borderRadius:  99,
              cursor:        'pointer',
              outline:       'none',
              border:        `1px solid ${active ? 'var(--amber-border)' : 'var(--border-base)'}`,
              background:    active
                ? 'linear-gradient(135deg, rgba(229,168,50,0.15), rgba(229,168,50,0.06))'
                : 'transparent',
              color:         active ? 'var(--amber)' : 'var(--text-tertiary)',
              boxShadow:     active ? 'inset 0 1px 0 rgba(229,168,50,0.20)' : 'none',
              transition:    'var(--transition-fast)',
              whiteSpace:    'nowrap',
              display:       'inline-flex',
              alignItems:    'center',
              gap:           6,
            }}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span style={{
                fontSize:  9,
                color:     active ? 'rgba(229,168,50,0.70)' : 'var(--text-muted)',
              }}>
                {tab.count}
              </span>
            )}
            {tab.badge && (
              <span style={{
                fontSize:     8,
                fontWeight:   900,
                padding:      '1px 5px',
                borderRadius: 99,
                background:   active ? 'var(--amber)' : 'var(--border-strong)',
                color:        active ? '#000' : 'var(--text-tertiary)',
              }}>
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Underline variant with scroll-affordance fades ──────────────────────────
// On narrow viewports the underline tab strip overflows horizontally; without
// a fade users can't tell there's more. We track scroll position and fade in
// a soft gradient on whichever edge has more content past it. Pure CSS
// alternative (mask-image) would also fade the active underline, so we use
// an absolute overlay that sits above the scroll container instead.
function UnderlineTabs({
  tabs,
  activeTab,
  onChange,
  sticky,
  className,
}: Omit<TabsProps, 'variant'>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function update() {
      if (!el) return;
      const max = el.scrollWidth - el.clientWidth;
      setEdges({
        left:  el.scrollLeft > 1,
        right: max > 1 && el.scrollLeft < max - 1,
      });
    }
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [tabs.length]);

  return (
    <div
      className={cn('relative', className)}
      style={sticky ? {
        position:             'sticky',
        top:                  0,
        zIndex:               10,
        background:           'linear-gradient(180deg, var(--bg-page) 0%, rgba(6,10,20,0.90) 100%)',
        backdropFilter:       'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom:         '1px solid var(--border-base)',
      } : undefined}
    >
      <div
        ref={scrollRef}
        style={{
          display:      'flex',
          gap:          4,
          overflowX:    'auto',
          scrollbarWidth: 'none',
        }}
      >
        {tabs.map(tab => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              style={{
                flexShrink:    0,
                padding:       '12px 16px',
                fontSize:      11,
                fontWeight:    700,
                fontFamily:    'system-ui, -apple-system, sans-serif',
                background:    'none',
                border:        'none',
                borderBottom:  `2px solid ${active ? 'var(--amber)' : 'transparent'}`,
                color:         active ? 'var(--amber)' : 'var(--text-tertiary)',
                cursor:        'pointer',
                outline:       'none',
                transition:    'var(--transition-fast)',
                textShadow:    active ? '0 0 10px var(--amber-glow)' : 'none',
                whiteSpace:    'nowrap',
              }}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span style={{
                  marginLeft:  6,
                  fontSize:    10,
                  color:       active ? 'rgba(229,168,50,0.70)' : 'var(--text-muted)',
                }}>
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* Edge fades — pointer-events:none so they don't block scroll */}
      {edges.left && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: 24,
            pointerEvents: 'none',
            background: 'linear-gradient(90deg, var(--bg-page) 0%, rgba(6,10,20,0) 100%)',
          }}
        />
      )}
      {edges.right && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            right: 0,
            width: 24,
            pointerEvents: 'none',
            background: 'linear-gradient(270deg, var(--bg-page) 0%, rgba(6,10,20,0) 100%)',
          }}
        />
      )}
    </div>
  );
}
