/**
 * The right-hand panel's tab strip: Intel (the lens-aware intelligence panel) | Events (the event rail).
 *
 * Built on the shared `Tabs` (underline variant): arrow keys, Home / End, a roving tab stop, and focus that follows the
 * selected tab (`activation="auto"`). The strip lives ABOVE the swapped content (`PanelDock` on the dock and the floating
 * panel, the sheet header on a phone), so it never remounts when the tab changes and keyboard focus stays on it.
 * `PanelTabPanels` renders the matching `role="tabpanel"` wrappers (`tabpanel-<id>`, labelled by `tab-<id>`).
 */

import type { ReactNode } from 'react';
import { Tabs, type Tab } from '@/design-system/components';

export type PanelTab = 'intel' | 'events';

export interface PanelTabsProps {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  /** Event records in the period (the Events tab's count); omitted until known. */
  eventCount?: number;
  /** Phone sheet: the legible 44px size. */
  touch?: boolean;
}

const isPanelTab = (v: string): v is PanelTab => v === 'intel' || v === 'events';

export function PanelTabs({ tab, onTab, eventCount, touch = false }: PanelTabsProps) {
  const tabs: Tab[] = [
    { id: 'intel', label: 'Intel' },
    { id: 'events', label: 'Events', count: typeof eventCount === 'number' && eventCount > 0 ? eventCount : undefined },
  ];
  return (
    <div
      // The shared underline tab is 12px tall above and below its label; in a panel strip that plus the content's own top padding
      // reads as a gap. A fine-pointer strip is tightened to 8px; a coarse pointer (phone, touch tablet) keeps the 44px target.
      className={touch ? 'sticky top-0 z-[1] shrink-0' : 'sticky top-0 z-[1] shrink-0 [&_[role=tab]]:!py-2 [@media(pointer:coarse)]:[&_[role=tab]]:!min-h-[44px]'}
      style={{ background: 'var(--bg-card-deep)', borderBottom: '1px solid var(--border-base)' }}>
      <Tabs
        tabs={tabs}
        activeTab={tab}
        onChange={id => { if (isPanelTab(id)) onTab(id); }}
        variant="underline"
        size={touch ? 'md' : 'sm'}
        linkedPanels
        activation="auto"
        aria-label="Panel"
      />
    </div>
  );
}

/** Both tab panels: the selected one holds the content, the other is an empty hidden stub so every `aria-controls` resolves. */
export function PanelTabPanels({ tab, children }: { tab: PanelTab; children: ReactNode }) {
  const other: PanelTab = tab === 'intel' ? 'events' : 'intel';
  return (
    <>
      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
      <div role="tabpanel" id={`tabpanel-${other}`} aria-labelledby={`tab-${other}`} hidden />
    </>
  );
}
