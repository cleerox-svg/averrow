// Minimal, theme-aware primitives used inside the unified
// ProfilePage. They read from the same CSS custom properties the
// host apps already define (--bg-card, --text-primary, etc.) so
// they flip automatically with [data-theme="light"].
//
// These are intentionally inline-styled (not Tailwind) so the
// shared package doesn't have to coordinate Tailwind config with
// either consumer. When averrow-shared eventually exports a full
// design system, these can move into it.

import { type CSSProperties, type ReactNode } from 'react';

interface CardProps {
  children:  ReactNode;
  className?: string;
  style?:     CSSProperties;
  onClick?:   () => void;
}

export function ProfileCard({ children, className, style, onClick }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={className}
      style={{
        background: 'var(--bg-card)',
        border:     '1px solid var(--border-base)',
        borderRadius: 12,
        padding: '20px 22px',
        marginBottom: 16,
        boxShadow: 'inset 0 1px 0 var(--border-base)',
        cursor: onClick ? 'pointer' : undefined,
        transition: 'border-color 150ms ease',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

interface SectionLabelProps {
  children:   ReactNode;
  className?: string;
}

export function ProfileSectionLabel({ children, className }: SectionLabelProps) {
  return (
    <div
      className={className}
      style={{
        fontSize:     11,
        fontFamily:   'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.16em',
        fontWeight:   700,
        color:        'var(--text-tertiary)',
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

interface FieldLabelProps {
  children:  ReactNode;
  htmlFor?:  string;
}

export function ProfileFieldLabel({ children, htmlFor }: FieldLabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display:       'block',
        fontSize:      10,
        fontFamily:    'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        color:         'var(--text-tertiary)',
        marginBottom:  6,
      }}
    >
      {children}
    </label>
  );
}

interface FieldHelperProps {
  children: ReactNode;
  tone?:    'default' | 'error' | 'success';
}

export function ProfileFieldHelper({ children, tone = 'default' }: FieldHelperProps) {
  const color = tone === 'error'   ? 'var(--sev-critical, #f87171)'
              : tone === 'success' ? 'var(--green, #3cb878)'
              :                      'var(--text-tertiary)';
  return (
    <p style={{
      marginTop:  6,
      fontSize:   11,
      fontFamily: 'var(--font-mono)',
      color,
      lineHeight: 1.5,
    }}>{children}</p>
  );
}

interface InputProps {
  id?:           string;
  type?:         string;
  value:         string;
  onChange:      (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?:  string;
  disabled?:     boolean;
  maxLength?:    number;
  readOnly?:     boolean;
  className?:    string;
  style?:        CSSProperties;
}

export function ProfileInput({
  id, type = 'text', value, onChange, placeholder, disabled, maxLength,
  readOnly, className, style,
}: InputProps) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      readOnly={readOnly}
      className={className}
      style={{
        width:        '100%',
        background:   readOnly ? 'transparent' : 'var(--bg-input)',
        color:        readOnly ? 'var(--text-tertiary)' : 'var(--text-primary)',
        border:       '1px solid var(--border-base)',
        borderRadius: 8,
        padding:      '10px 12px',
        fontSize:     13,
        cursor:       readOnly ? 'not-allowed' : 'text',
        transition:   'border-color 120ms ease',
        ...style,
      }}
    />
  );
}

interface ButtonProps {
  onClick?:   () => void;
  disabled?:  boolean;
  variant?:   'primary' | 'secondary' | 'danger' | 'ghost';
  size?:      'sm' | 'md';
  type?:      'button' | 'submit';
  children:   ReactNode;
}

export function ProfileButton({
  onClick, disabled, variant = 'primary', size = 'md', type = 'button', children,
}: ButtonProps) {
  const palette = (() => {
    if (variant === 'primary') return {
      background: 'linear-gradient(135deg, var(--amber), var(--amber-dim))',
      color:      'var(--text-on-amber, #0A0F1E)',
      border:     '1px solid rgba(229,168,50,0.60)',
    };
    if (variant === 'danger') return {
      background: 'transparent',
      color:      'var(--sev-critical, #f87171)',
      border:     '1px solid var(--sev-critical-border, rgba(239,68,68,0.30))',
    };
    if (variant === 'ghost') return {
      background: 'transparent',
      color:      'var(--text-tertiary)',
      border:     '1px solid transparent',
    };
    return {
      background: 'var(--bg-card)',
      color:      'var(--text-primary)',
      border:     '1px solid var(--border-strong)',
    };
  })();

  const padding = size === 'sm' ? '6px 12px' : '10px 18px';
  const fontSize = size === 'sm' ? 11 : 12;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...palette,
        padding,
        fontSize,
        fontFamily:    'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        fontWeight:    700,
        borderRadius:  8,
        cursor:        disabled ? 'not-allowed' : 'pointer',
        opacity:       disabled ? 0.55 : 1,
        transition:    'transform 80ms ease, opacity 120ms ease',
        whiteSpace:    'nowrap',
      }}
    >
      {children}
    </button>
  );
}

interface PillProps {
  children: ReactNode;
  tone?:    'amber' | 'green' | 'red' | 'blue' | 'neutral';
}

export function ProfilePill({ children, tone = 'neutral' }: PillProps) {
  const palette = {
    amber:   { color: 'var(--amber, #E5A832)',  bg: 'rgba(229,168,50,0.10)', border: 'rgba(229,168,50,0.30)' },
    green:   { color: 'var(--green, #3CB878)',  bg: 'rgba(60,184,120,0.10)', border: 'rgba(60,184,120,0.30)' },
    red:     { color: 'var(--red, #C83C3C)',    bg: 'rgba(200,60,60,0.10)',  border: 'rgba(200,60,60,0.30)' },
    blue:    { color: 'var(--blue, #0A8AB5)',   bg: 'rgba(10,138,181,0.10)', border: 'rgba(10,138,181,0.30)' },
    neutral: { color: 'var(--text-tertiary)',   bg: 'transparent',           border: 'var(--border-base)' },
  }[tone];

  return (
    <span style={{
      display:       'inline-flex',
      alignItems:    'center',
      padding:       '2px 10px',
      borderRadius:  99,
      fontSize:      10,
      fontFamily:    'var(--font-mono)',
      textTransform: 'uppercase',
      letterSpacing: '0.10em',
      fontWeight:    700,
      color:         palette.color,
      background:    palette.bg,
      border:        `1px solid ${palette.border}`,
    }}>{children}</span>
  );
}

// Re-export the canonical avatar helper from
// @averrow/shared/avatar so callers inside the profile module
// have a single import path. The implementation lives in the
// shared/avatar module per SHARED_LOGIN_SPEC §3.
export { parseInitials } from '../avatar';
