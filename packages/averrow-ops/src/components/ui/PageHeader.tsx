// Averrow Design System — PageHeader v1.0
// Consistent page title treatment across all pages.
// Replaces all inline page title/subtitle/back-link implementations.

import React from 'react';
import { useNavigate } from 'react-router-dom';

export interface PageHeaderProps {
  title:      string;
  subtitle?:  string;
  // Back navigation
  back?: {
    label:    string;
    to?:      string;    // navigate path
    onClick?: () => void; // or custom handler
  };
  // Right-side action buttons
  actions?:   React.ReactNode;
  // Optional badge next to title (e.g. INACTIVE, BETA)
  badge?:     React.ReactNode;
  // Optional status line below title
  meta?:      React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  back,
  actions,
  badge,
  meta,
  className = '',
}: PageHeaderProps) {
  const navigate = useNavigate();

  const handleBack = () => {
    if (back?.onClick) {
      back.onClick();
    } else if (back?.to) {
      navigate(back.to);
    }
  };

  return (
    <div className={className} style={{ marginBottom: 20 }}>
      {/* Back link */}
      {back && (
        <button
          onClick={handleBack}
          style={{
            display:       'inline-flex',
            alignItems:    'center',
            gap:           6,
            fontSize:      12,
            fontFamily:    'var(--font-mono)',
            color:         'var(--text-tertiary)',
            background:    'none',
            border:        'none',
            cursor:        'pointer',
            padding:       0,
            marginBottom:  12,
            outline:       'none',
            transition:    'var(--transition-fast)',
            letterSpacing: '0.06em',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--amber)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
        >
          ← {back.label}
        </button>
      )}

      {/* Title row */}
      <div style={{
        display:        'flex',
        alignItems:     'flex-start',
        justifyContent: 'space-between',
        gap:            16,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Title + badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{
              fontSize:      24,
              fontWeight:    900,
              color:         'var(--text-primary)',
              letterSpacing: -0.5,
              lineHeight:    1.1,
              margin:        0,
            }}>
              {title}
            </h1>
            {badge && (
              <div style={{ flexShrink: 0 }}>
                {badge}
              </div>
            )}
          </div>

          {/* Subtitle */}
          {subtitle && (
            <p style={{
              fontSize:   13,
              color:      'var(--text-secondary)',
              marginTop:  6,
              lineHeight: 1.5,
            }}>
              {subtitle}
            </p>
          )}

          {/* Meta line (domain, timestamps, status etc.) */}
          {meta && (
            <div style={{
              display:    'flex',
              alignItems: 'center',
              gap:        8,
              marginTop:  6,
              fontSize:   12,
              color:      'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
            }}>
              {meta}
            </div>
          )}
        </div>

        {/* Right-side actions */}
        {actions && (
          <div style={{
            display:    'flex',
            alignItems: 'center',
            gap:        8,
            flexShrink: 0,
            paddingTop: 2,
          }}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
