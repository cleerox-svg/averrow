// Shared collapsible section chrome — icon + eyebrow label + chevron
// header, localStorage-persisted expand state. Originally hand-rolled
// inline in AdminDashboard.tsx for the Cost & Budget tab's heavier
// panels (D1 Budget, AI Spend) so they default to collapsed instead of
// stacking full standalone pages every time the tab opens. Lifted out
// here (Tier 4 design-review fix) so any sub-section anywhere on the
// platform — including AiSpend's own nested "Cost-reduction levers"
// sub-section — gets identical chrome AND persistence instead of a
// one-off toggle that visually diverges and forgets its state on
// remount.

import { useState, useEffect, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react';
import { Card } from '@/design-system/components';

const sectionEyebrow: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

export interface CollapsibleSectionProps {
  /** localStorage key the expand/collapse state persists under. */
  storageKey: string;
  icon: LucideIcon;
  label: string;
  defaultExpanded: boolean;
  children: ReactNode;
}

export function CollapsibleSection({
  storageKey, icon: Icon, label, defaultExpanded, children,
}: CollapsibleSectionProps) {
  const [expanded, setExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? defaultExpanded : stored === 'true';
    } catch { return defaultExpanded; }
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, String(expanded)); }
    catch { /* noop */ }
  }, [storageKey, expanded]);

  return (
    <Card padding={0}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon size={14} style={{ color: 'var(--amber)' }} />
          <div style={sectionEyebrow}>{label}</div>
        </div>
        {expanded
          ? <ChevronUp size={16} style={{ color: 'var(--text-secondary)' }} />
          : <ChevronDown size={16} style={{ color: 'var(--text-secondary)' }} />}
      </button>

      {expanded && (
        <div style={{ padding: '0 20px 20px' }}>
          {children}
        </div>
      )}
    </Card>
  );
}
