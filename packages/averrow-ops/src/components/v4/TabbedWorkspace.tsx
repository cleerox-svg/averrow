// Reusable v4 tabbed workspace — generalizes the SOC Console pattern so the
// Intelligence "Explorer" and "Coverage" surfaces can consolidate several
// standalone pages under one nav entry without a page-logic rewrite.
//
// A cinematic crumb + title header and a deep-linkable (?tab=) tab bar over
// existing page components mounted as tab bodies. The old standalone routes
// redirect here (see App.tsx / lib/workspaceRoutes.ts). The active tab is
// derived from the URL so in-app links and redirects that only change `?tab=`
// switch panes without a remount.

import { Suspense, type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Button, WorkspaceEmbedContext } from '@averrow/shared/ui';
import { PageState } from '@/design-system/components';
import '@/features/console/console.css';

export interface WorkspaceTab {
  id: string;
  label: string;
  icon: LucideIcon;
  /** One-line description shown under the tab bar for the active tab. */
  def?: string;
  Component: ComponentType;
}

export function TabbedWorkspace({
  crumb,
  title,
  tabs,
}: {
  crumb: string;
  title: string;
  tabs: WorkspaceTab[];
}) {
  const [params, setParams] = useSearchParams();
  const ids = tabs.map(t => t.id);
  const fallbackId = tabs[0]?.id ?? '';
  const urlTab = params.get('tab');
  const tab = urlTab && ids.includes(urlTab) ? urlTab : fallbackId;

  function selectTab(next: string) {
    // Only `tab` carries over — q/focus/brand_id etc. belong to the pane
    // being left and must not filter the next one.
    setParams(next === fallbackId ? {} : { tab: next }, { replace: true });
  }

  const active = tabs.find(t => t.id === tab) ?? tabs[0];
  const Active = active?.Component;

  return (
    <div className="console-v4">
      <div className="console-head">
        <div>
          <div className="console-crumb">{crumb}</div>
          <h1 className="console-title">{title}</h1>
        </div>
        <span className="console-live"><span className="dot" />LIVE</span>
      </div>

      <div className="console-tabs">
        {tabs.map(t => {
          const Icon = t.icon;
          return (
            <Button
              key={t.id}
              variant={tab === t.id ? 'primary' : 'secondary'}
              size="md"
              onClick={() => selectTab(t.id)}
            >
              <Icon size={15} strokeWidth={2} /> {t.label}
            </Button>
          );
        })}
      </div>

      {active?.def && <p className="console-def">{active.def}</p>}

      <Suspense fallback={<PageState kind="loading" />}>
        {/* Panes read `q` on mount only; keying on it re-applies a new ?q= (e.g. ⌘K
            "view all" while already on this tab). */}
        {/* The workspace owns the view's single h1; embedded panes drop theirs. */}
        <WorkspaceEmbedContext.Provider value={true}>
          {Active && <Active key={params.get('q') ?? ''} />}
        </WorkspaceEmbedContext.Provider>
      </Suspense>
    </div>
  );
}
