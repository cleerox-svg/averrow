// Averrow UI Standard — SectionLabel v1.0
// Consistent section headers used everywhere.
// Supports the standard `label` API and a legacy `children`/`className` form
// (so existing pages continue to render until Phase 10b migrates them).
// See AVERROW_UI_STANDARD.md for full spec.

import React from 'react';
import { cn } from '@/lib/cn';

export interface SectionLabelProps {
  // Standard API
  label?: string;
  accent?: string;
  action?: string;
  onAction?: () => void;
  attribution?: string;
  // Legacy API (kept for back-compat)
  children?: React.ReactNode;
  className?: string;
}

export function SectionLabel({
  label,
  accent       = '#E5A832',
  action,
  onAction,
  attribution,
  children,
  className,
}: SectionLabelProps) {
  // Legacy mode: render children with original markup so existing pages keep working.
  if (label === undefined && children !== undefined) {
    return (
      <div className={cn('font-mono font-bold section-label', className)}>
        {children}
      </div>
    );
  }

  return (
    <div style={{
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'space-between',
      marginBottom:   11,
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <div style={{
          width:      2,
          height:     14,
          borderRadius: 99,
          background: `linear-gradient(180deg, ${accent}, transparent)`,
          flexShrink: 0,
        }} />
        <div>
          <span style={{
            fontSize:      9,
            fontFamily:    'monospace',
            letterSpacing: '0.20em',
            color:         'rgba(255,255,255,0.45)',
            textTransform: 'uppercase',
            fontWeight:    700,
          }}>
            {label}
          </span>
          {attribution && (
            <span style={{
              fontSize:   8,
              fontFamily: 'monospace',
              color:      'rgba(255,255,255,0.22)',
              marginLeft: 10,
            }}>
              {attribution}
            </span>
          )}
        </div>
      </div>
      {action && (
        <span
          onClick={onAction}
          style={{
            fontSize:   11,
            color:      accent,
            cursor:     'pointer',
            fontWeight: 700,
            textShadow: `0 0 10px ${accent}60`,
          }}
        >
          {action} →
        </span>
      )}
    </div>
  );
}
