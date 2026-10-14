/**
 * Lens switcher: one tab per question the map can answer. Arrow keys move and
 * select (activation="auto"), so a keyboard user can flip through lenses. On
 * narrow screens the strip scrolls horizontally instead of wrapping.
 */

import { Tabs } from '@/design-system/components';
import { cn } from '@/lib/cn';
import { LENS_DEFS, LENS_IDS, type LensId } from '../lib/lenses';

const TABS = LENS_IDS.map(id => ({ id, label: LENS_DEFS[id].label }));

export interface LensSwitcherProps {
  lens: LensId;
  onChange: (lens: LensId) => void;
  className?: string;
}

export function LensSwitcher({ lens, onChange, className }: LensSwitcherProps) {
  return (
    <div className={cn('max-w-full min-w-0 overflow-x-auto', className)} style={{ scrollbarWidth: 'none' }}>
      <Tabs
        tabs={TABS}
        activeTab={lens}
        onChange={id => onChange(id as LensId)}
        variant="bar"
        activation="auto"
        aria-label="Observatory lens"
        className="min-w-max"
      />
      <span className="sr-only" aria-live="polite">{LENS_DEFS[lens].question}</span>
    </div>
  );
}
