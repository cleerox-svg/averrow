// Averrow Design System — FilterBar v1.0
// Shared search + filter pill bar used on every list page.
// Replaces all inline filter/search implementations.

import React from 'react';
import { Card } from './Card';

export interface FilterOption {
  value:   string;
  label:   string;
  count?:  number;
}

export interface FilterBarProps {
  // Filter pills
  filters?:  FilterOption[];
  active?:   string;
  onChange?: (value: string) => void;

  // Search input
  search?: {
    value:        string;
    onChange:     (v: string) => void;
    placeholder?: string;
  };

  // Right-side slot for action buttons
  actions?: React.ReactNode;

  // Extra filter rows (e.g. secondary filter group)
  children?: React.ReactNode;

  className?: string;
}

export function FilterBar({
  filters,
  active,
  onChange,
  search,
  actions,
  children,
  className,
}: FilterBarProps) {
  return (
    <Card
      variant="base"
      className={className}
      style={{ padding: '10px 16px', marginBottom: 12 }}
    >
      <div style={{
        display:     'flex',
        alignItems:  'center',
        gap:         8,
        flexWrap:    'wrap',
      }}>
        {/* Search input */}
        {search && (
          <input
            type="text"
            value={search.value}
            onChange={e => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? 'Search...'}
            style={{
              flex:              '1 1 180px',
              minWidth:          120,
              maxWidth:          320,
              height:            34,
              padding:           '0 12px',
              borderRadius:      8,
              fontSize:          12,
              fontFamily:        'var(--font-sans)',
              background:        'var(--bg-input)',
              border:            '1px solid var(--border-base)',
              color:             'var(--text-primary)',
              outline:           'none',
              transition:        'var(--transition-fast)',
            }}
            onFocus={e => {
              e.currentTarget.style.borderColor = 'var(--amber-border)';
              e.currentTarget.style.boxShadow   = '0 0 0 2px var(--amber-glow)';
            }}
            onBlur={e => {
              e.currentTarget.style.borderColor = 'var(--border-base)';
              e.currentTarget.style.boxShadow   = 'none';
            }}
          />
        )}

        {/* Vertical divider between search and pills */}
        {search && filters && filters.length > 0 && (
          <div style={{
            width:      1,
            height:     20,
            background: 'var(--border-base)',
            flexShrink: 0,
          }} />
        )}

        {/* Filter pills */}
        {filters && filters.map(f => {
          const isActive = f.value === active;
          return (
            <button
              key={f.value}
              onClick={() => onChange?.(f.value)}
              style={{
                flexShrink:    0,
                padding:       '5px 14px',
                borderRadius:  99,
                fontSize:      10,
                fontFamily:    'var(--font-mono)',
                fontWeight:    700,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                cursor:        'pointer',
                outline:       'none',
                border:        `1px solid ${isActive ? 'var(--amber-border)' : 'var(--border-base)'}`,
                background:    isActive
                  ? 'linear-gradient(135deg, rgba(229,168,50,0.15), rgba(229,168,50,0.06))'
                  : 'transparent',
                color:         isActive ? 'var(--amber)' : 'var(--text-tertiary)',
                boxShadow:     isActive ? 'inset 0 1px 0 rgba(229,168,50,0.20)' : 'none',
                transition:    'var(--transition-fast)',
                display:       'inline-flex',
                alignItems:    'center',
                gap:           5,
              }}
            >
              {f.label}
              {f.count !== undefined && (
                <span style={{
                  fontSize:  9,
                  color:     isActive ? 'rgba(229,168,50,0.70)' : 'var(--text-muted)',
                }}>
                  {f.count}
                </span>
              )}
            </button>
          );
        })}

        {/* Spacer pushes actions to the right */}
        {actions && <div style={{ flex: 1 }} />}

        {/* Right-side action buttons */}
        {actions && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {actions}
          </div>
        )}
      </div>

      {/* Optional secondary filter row */}
      {children && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-base)' }}>
          {children}
        </div>
      )}
    </Card>
  );
}
