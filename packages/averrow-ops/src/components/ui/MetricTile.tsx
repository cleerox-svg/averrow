// Averrow Design System — MetricTile
// Small inset box inside an EntityCard showing a label + value.
// Three layouts: number (default), grade (A-F letter box), label (colored text).

import type { ReactNode } from 'react';

type MetricTileLayout = 'number' | 'grade' | 'label';

interface BaseProps {
  label: string;
  /** Override color for value text */
  color?: string;
  /** Center value horizontally */
  center?: boolean;
  /** className pass-through */
  className?: string;
}

interface NumberProps extends BaseProps {
  layout?: 'number';
  value: number | string | null | undefined;
  /** Optional tiny suffix next to the value */
  suffix?: string;
  /** Apply glow shadow effect on the number */
  glow?: boolean;
}

interface GradeProps extends BaseProps {
  layout: 'grade';
  /** The grade letter — A, B, C, D, F */
  grade: string | null | undefined;
  /** Numeric subtext shown next to grade */
  subValue?: number | string | null;
  /** Background color for grade box */
  gradeBg: string;
  /** Text color for grade letter */
  gradeColor: string;
  /** Border color for grade box */
  gradeBorder: string;
}

interface LabelProps extends BaseProps {
  layout: 'label';
  /** The text label — e.g. "HIGH", "CLEAN" */
  text: string | null | undefined;
  /** Label color */
  labelColor: string;
}

export type MetricTileProps = NumberProps | GradeProps | LabelProps;

const TILE_STYLE = {
  flex: 1,
  background: 'rgba(255,255,255,0.04)',
  borderRadius: 8,
  padding: '7px 8px',
  textAlign: 'center' as const,
  border: '1px solid var(--border-base)',
  minWidth: 0,
};

const LABEL_STYLE = {
  fontSize: 9,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.14em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase' as const,
  marginBottom: 5,
};

/**
 * Compact metric box for use inside EntityCard grids.
 * Supports three layouts: number, grade (letter box), or colored label.
 */
export function MetricTile(props: MetricTileProps) {
  const { label, className } = props;

  let body: ReactNode;

  if (props.layout === 'grade') {
    body = props.grade ? (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 800, fontFamily: 'var(--font-mono)',
          background: props.gradeBg,
          color: props.gradeColor,
          border: `1px solid ${props.gradeBorder}`,
        }}>
          {props.grade}
        </div>
        {props.subValue != null && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {props.subValue}
          </span>
        )}
      </div>
    ) : (
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>—</div>
    );
  } else if (props.layout === 'label') {
    body = props.text ? (
      <div style={{
        fontSize: 12,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        color: props.labelColor,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        lineHeight: 1.2,
        padding: '3px 0',
      }}>
        {props.text}
      </div>
    ) : (
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>—</div>
    );
  } else {
    // number layout (default)
    const numberProps = props as NumberProps;
    body = numberProps.value != null && numberProps.value !== '' ? (
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 3 }}>
        <span style={{
          fontSize: 16,
          fontWeight: 800,
          fontFamily: 'var(--font-mono)',
          color: numberProps.color ?? 'var(--text-primary)',
          lineHeight: 1,
          textShadow: numberProps.glow && numberProps.color
            ? `0 0 10px ${numberProps.color}40`
            : undefined,
        }}>
          {typeof numberProps.value === 'number'
            ? numberProps.value.toLocaleString()
            : numberProps.value}
        </span>
        {numberProps.suffix && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {numberProps.suffix}
          </span>
        )}
      </div>
    ) : (
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>—</div>
    );
  }

  return (
    <div className={className} style={TILE_STYLE}>
      <div style={LABEL_STYLE}>{label}</div>
      {body}
    </div>
  );
}
