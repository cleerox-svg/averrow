// Averrow Design System — GradeBadge
//
// Letter-grade pill (A+ / A / B / C / D / F) with severity-tinted
// gradient bg + glow. Used to display BIMI / email-security grades
// inline in lists. Returns null when grade is missing.
//
// Originally lived in components/mobile/MobileUIKit.tsx; promoted to
// the shared design system as part of the unified Home work.
//
// Distinct from BIMIGradeBadge (which is the larger, Tailwind-styled
// version used in detail panels). This is the compact inline form.

export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface GradeBadgeProps {
  grade?: string | null;
}

const GRADE_CFG: Record<Grade, {
  bg: string; border: string; text: string; glow: string;
}> = {
  'A+': { bg: 'linear-gradient(135deg,rgba(16,185,129,0.25),rgba(16,185,129,0.10))', border: 'rgba(16,185,129,0.50)', text: '#6ee7b7', glow: 'rgba(16,185,129,0.30)' },
  'A':  { bg: 'linear-gradient(135deg,rgba(16,185,129,0.20),rgba(16,185,129,0.08))', border: 'rgba(16,185,129,0.40)', text: '#6ee7b7', glow: 'rgba(16,185,129,0.25)' },
  'B':  { bg: 'linear-gradient(135deg,rgba(59,130,246,0.18),rgba(59,130,246,0.07))', border: 'rgba(59,130,246,0.35)', text: '#93c5fd', glow: 'rgba(59,130,246,0.25)' },
  'C':  { bg: 'linear-gradient(135deg,rgba(229,168,50,0.18),rgba(229,168,50,0.07))', border: 'rgba(229,168,50,0.35)', text: '#fcd34d', glow: 'rgba(229,168,50,0.25)' },
  'D':  { bg: 'linear-gradient(135deg,rgba(249,115,22,0.18),rgba(249,115,22,0.07))', border: 'rgba(249,115,22,0.35)', text: '#fdba74', glow: 'rgba(249,115,22,0.25)' },
  'F':  { bg: 'linear-gradient(135deg,rgba(239,68,68,0.22),rgba(239,68,68,0.08))',   border: 'rgba(239,68,68,0.45)',  text: '#fca5a5', glow: 'rgba(239,68,68,0.30)' },
};

export function GradeBadge({ grade }: GradeBadgeProps) {
  if (!grade) return null;
  const g = GRADE_CFG[grade as Grade] ?? GRADE_CFG['F'];
  return (
    <span style={{
      fontSize: 10, fontFamily: 'monospace', fontWeight: 900,
      padding: '3px 10px', borderRadius: 8,
      background: g.bg,
      border: `1px solid ${g.border}`,
      color: g.text,
      boxShadow: `inset 0 1px 0 ${g.border}, 0 2px 8px ${g.glow}`,
      letterSpacing: '0.05em',
    }}>
      {grade}
    </span>
  );
}
