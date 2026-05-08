// Averrow — ReportPanel
// Slide-in side panel that renders structured intelligence reports.
// Replaces raw markdown blobs across: AI Assessment, Intel briefings, Takedown detail.
// Parses markdown-style headings, bold text, bullet points, and callout sections.

import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export interface ReportPanelProps {
  isOpen:    boolean;
  onClose:   () => void;
  title:     string;
  subtitle?: string;
  badge?:    React.ReactNode;
  content:   string;         // raw markdown/text content
  meta?:     React.ReactNode; // optional metadata row (date, source, etc.)
  actions?:  React.ReactNode; // optional action buttons in header
}

// ── Markdown-to-styled-sections parser ────────────────────────────
// Converts ## headings, **bold**, bullet points, and callout blocks
// into styled JSX. No external markdown library needed.

interface Section {
  type:    'h1' | 'h2' | 'h3' | 'paragraph' | 'bullet-list' | 'callout';
  content: string;
  items?:  string[];  // for bullet-list
  variant?: 'warning' | 'critical' | 'info' | 'success'; // for callout
}

function parseReport(text: string): Section[] {
  const sections: Section[] = [];
  const lines = text.split('\n');
  let bulletBuffer: string[] = [];

  const flushBullets = () => {
    if (bulletBuffer.length > 0) {
      sections.push({ type: 'bullet-list', content: '', items: [...bulletBuffer] });
      bulletBuffer = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }

    // Headings
    if (trimmed.startsWith('### ')) {
      flushBullets();
      sections.push({ type: 'h3', content: trimmed.slice(4) });
      continue;
    }
    if (trimmed.startsWith('## ')) {
      flushBullets();
      sections.push({ type: 'h2', content: trimmed.slice(3) });
      continue;
    }
    if (trimmed.startsWith('# ')) {
      flushBullets();
      sections.push({ type: 'h1', content: trimmed.slice(2) });
      continue;
    }

    // Bullet points
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
      bulletBuffer.push(trimmed.slice(2));
      continue;
    }
    if (/^\d+\.\s/.test(trimmed)) {
      bulletBuffer.push(trimmed.replace(/^\d+\.\s/, ''));
      continue;
    }

    // Callout detection (lines starting with keywords)
    const upperLine = trimmed.toUpperCase();
    flushBullets();

    if (
      upperLine.startsWith('WARNING:') || upperLine.startsWith('⚠') ||
      upperLine.startsWith('CAUTION:')
    ) {
      sections.push({ type: 'callout', variant: 'warning', content: trimmed.replace(/^(WARNING:|⚠\s*|CAUTION:)/i, '').trim() });
      continue;
    }
    if (
      upperLine.startsWith('CRITICAL:') || upperLine.startsWith('URGENT:') ||
      upperLine.startsWith('IMMEDIATE:')
    ) {
      sections.push({ type: 'callout', variant: 'critical', content: trimmed.replace(/^(CRITICAL:|URGENT:|IMMEDIATE:)/i, '').trim() });
      continue;
    }
    if (
      upperLine.startsWith('NOTE:') || upperLine.startsWith('INFO:') ||
      upperLine.startsWith('CONTEXT:')
    ) {
      sections.push({ type: 'callout', variant: 'info', content: trimmed.replace(/^(NOTE:|INFO:|CONTEXT:)/i, '').trim() });
      continue;
    }

    // Regular paragraph
    sections.push({ type: 'paragraph', content: trimmed });
  }

  flushBullets();
  return sections;
}

// ── Inline bold/italic renderer ────────────────────────────────────
function renderInline(text: string): React.ReactNode {
  // Split on **bold** and *italic* patterns
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={i} style={{ color: 'var(--text-secondary)' }}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

// ── Section renderers ──────────────────────────────────────────────
function renderSection(section: Section, idx: number): React.ReactNode {
  switch (section.type) {
    case 'h1':
      return (
        <h1 key={idx} style={{
          fontSize: 18, fontWeight: 900, color: 'var(--text-primary)',
          letterSpacing: -0.3, margin: '20px 0 8px',
          borderBottom: '1px solid var(--border-base)',
          paddingBottom: 8,
        }}>
          {renderInline(section.content)}
        </h1>
      );

    case 'h2':
      return (
        <div key={idx} style={{ margin: '20px 0 6px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <div style={{
              width: 3, height: 14, borderRadius: 99,
              background: 'linear-gradient(180deg, var(--amber), var(--amber-dim))',
              flexShrink: 0,
            }} />
            <h2 style={{
              fontSize: 11, fontWeight: 800, color: 'var(--amber)',
              fontFamily: 'var(--font-mono)', letterSpacing: '0.16em',
              textTransform: 'uppercase', margin: 0,
            }}>
              {section.content}
            </h2>
          </div>
        </div>
      );

    case 'h3':
      return (
        <h3 key={idx} style={{
          fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
          margin: '14px 0 4px', letterSpacing: -0.2,
        }}>
          {renderInline(section.content)}
        </h3>
      );

    case 'paragraph':
      return (
        <p key={idx} style={{
          fontSize: 13, lineHeight: 1.65,
          color: 'var(--text-secondary)', margin: '6px 0',
        }}>
          {renderInline(section.content)}
        </p>
      );

    case 'bullet-list':
      return (
        <ul key={idx} style={{
          margin: '6px 0 10px', paddingLeft: 0, listStyle: 'none',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {(section.items ?? []).map((item, i) => (
            <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{
                color: 'var(--amber)', fontSize: 10, marginTop: 4,
                flexShrink: 0, fontFamily: 'var(--font-mono)',
              }}>›</span>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                {renderInline(item)}
              </span>
            </li>
          ))}
        </ul>
      );

    case 'callout': {
      const CALLOUT_STYLES = {
        warning:  { bg: 'var(--sev-medium-bg)',   border: 'var(--sev-medium-border)',   icon: '⚠', color: 'var(--sev-medium)' },
        critical: { bg: 'var(--sev-critical-bg)', border: 'var(--sev-critical-border)', icon: '🚨', color: 'var(--sev-critical)' },
        info:     { bg: 'var(--blue-glow)',       border: 'var(--blue-border)',         icon: 'ℹ', color: 'var(--blue)' },
        success:  { bg: 'var(--sev-info-bg)',     border: 'var(--sev-info-border)',     icon: '✓', color: 'var(--sev-info)' },
      };
      const s = CALLOUT_STYLES[section.variant ?? 'info'];
      return (
        <div key={idx} style={{
          display: 'flex', gap: 10, padding: '10px 14px',
          borderRadius: 8, margin: '8px 0',
          background: s.bg, border: `1px solid ${s.border}`,
        }}>
          <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{s.icon}</span>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: s.color, margin: 0 }}>
            {renderInline(section.content)}
          </p>
        </div>
      );
    }

    default:
      return null;
  }
}

// ── Main ReportPanel component ─────────────────────────────────────
export function ReportPanel({
  isOpen,
  onClose,
  title,
  subtitle,
  badge,
  content,
  meta,
  actions,
}: ReportPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset scroll position when panel opens
  useEffect(() => {
    if (isOpen && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [isOpen, content]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (isOpen) document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const sections = parseReport(content);
  const panelWidth = typeof window !== 'undefined'
    ? Math.min(680, window.innerWidth - 48)
    : 680;

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          onClick={onClose}
          style={{
            position:       'fixed',
            inset:          0,
            background:     'rgba(0,0,0,0.50)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            zIndex:         'var(--z-modal)' as unknown as number,
            transition:     'opacity 0.20s ease',
          }}
        />
      )}

      {/* Panel */}
      <div
        style={{
          position:       'fixed',
          top:            0,
          right:          0,
          bottom:         0,
          width:          panelWidth,
          zIndex:         'calc(var(--z-modal) + 1)' as unknown as number,
          transform:      isOpen ? 'translateX(0)' : 'translateX(100%)',
          transition:     'transform 0.28s cubic-bezier(0.16,1,0.3,1)',
          display:        'flex',
          flexDirection:  'column',
          background:     'linear-gradient(160deg, var(--bg-elevated) 0%, var(--bg-card-deep) 100%)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          borderLeft:     '1px solid var(--border-strong)',
          boxShadow:      '-24px 0 80px rgba(0,0,0,0.70)',
          pointerEvents:  isOpen ? 'auto' : 'none',
        }}
      >
        {/* Header */}
        <div style={{
          padding:      '20px 24px 16px',
          borderBottom: '1px solid var(--border-base)',
          flexShrink:   0,
        }}>
          {/* Top row: badge + close */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {badge}
            </div>
            <button
              onClick={onClose}
              aria-label="Close report"
              style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid var(--border-base)',
                color: 'var(--text-tertiary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', flexShrink: 0,
                transition: 'var(--transition-fast)',
              }}
            >
              <X size={14} />
            </button>
          </div>

          {/* Title */}
          <h2 style={{
            fontSize: 18, fontWeight: 900,
            color: 'var(--text-primary)',
            letterSpacing: -0.3, margin: '0 0 4px',
          }}>
            {title}
          </h2>

          {subtitle && (
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>
              {subtitle}
            </p>
          )}

          {meta && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              marginTop: 10, paddingTop: 10,
              borderTop: '1px solid var(--border-base)',
              fontSize: 11, color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              flexWrap: 'wrap',
            }}>
              {meta}
            </div>
          )}

          {actions && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {actions}
            </div>
          )}
        </div>

        {/* Scrollable content */}
        <div
          ref={scrollRef}
          style={{
            flex: 1, overflowY: 'auto', overflowX: 'hidden',
            padding: '20px 24px 40px',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {sections.length > 0
            ? sections.map((section, idx) => renderSection(section, idx))
            : (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No content available.
              </p>
            )
          }
        </div>
      </div>
    </>
  );
}
