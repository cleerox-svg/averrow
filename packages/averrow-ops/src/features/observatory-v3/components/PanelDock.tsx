/**
 * The docked / floating right-hand panel: one `<aside>` that owns the geometry, the Intel | Events tab strip and the
 * tab panel. The panels inside (`SidePanel`, `LensPanel`, `EventRail` with `embedded`) are plain in-flow content, so
 * swapping tabs (or lenses) replaces only the panel's content: the tab strip is the same DOM node throughout and keeps
 * keyboard focus.
 *
 * Same geometry as the panels it hosts (the stats bar + headline band sit below the 76px): `bottom-[88px]` leaves the
 * floating variant a 12px margin above them.
 */

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { PanelTabPanels, PanelTabs, type PanelTab } from './PanelTabs';

export interface PanelDockProps {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  eventCount?: number;
  placement: 'dock' | 'overlay';
  /** The landmark name: what the panel currently shows ("Hosting panel", "Event rail", ...). */
  label: string;
  /**
   * What the Intel tab is showing (e.g. the Threats panel vs a lens panel). The aside is the scroll container and never
   * remounts, so a change of `tab` or `contentKey` resets its scroll to the top: the new content never opens part-way down.
   */
  contentKey?: string;
  children: ReactNode;
}

export function PanelDock({ tab, onTab, eventCount, placement, label, contentKey, children }: PanelDockProps) {
  const overlay = placement === 'overlay';
  const asideRef = useRef<HTMLElement>(null);
  // Layout effect: reset before paint, so the old offset never flashes on the new content.
  useLayoutEffect(() => {
    if (asideRef.current) asideRef.current.scrollTop = 0;
  }, [tab, contentKey]);
  return (
    <aside
      ref={asideRef}
      aria-label={label}
      className={overlay
        ? 'absolute top-[60px] right-3 bottom-[88px] z-20 w-80 max-w-[calc(100%-24px)] flex flex-col overflow-y-auto rounded-xl animate-drawer-in motion-reduce:animate-none'
        : 'absolute top-[60px] right-0 bottom-[76px] z-20 w-80 flex flex-col overflow-y-auto animate-drawer-in motion-reduce:animate-none'}
      style={{
        background: 'var(--bg-card-deep)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: overlay ? '1px solid var(--border-base)' : undefined,
        borderLeft: '1px solid var(--border-base)',
        boxShadow: overlay ? 'var(--card-shadow-elevated)' : 'var(--card-shadow-elevated), inset 1px 0 0 var(--border-base)',
      }}
    >
      <PanelTabs tab={tab} onTab={onTab} eventCount={eventCount} />
      <PanelTabPanels tab={tab}>{children}</PanelTabPanels>
    </aside>
  );
}
