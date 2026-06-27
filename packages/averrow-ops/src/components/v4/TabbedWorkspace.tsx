// Reusable v4 tabbed workspace — generalizes the SOC Console pattern so the
// Intelligence "Explorer" and "Coverage" surfaces can consolidate several
// standalone pages under one nav entry without a page-logic rewrite.
//
// A cinematic crumb + title header and a deep-linkable (?tab=) tab bar over
// existing page components mounted as tab bodies. The standalone routes for
// each page stay live, so deep links / pivots are unaffected — this is an
// additional, consolidated entry point, not a replacement.

import { Suspense, useState, type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@averrow/shared/ui';
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
  const initial = urlTab && ids.includes(urlTab) ? urlTab : fallbackId;
  const [tab, setTab] = useState<string>(initial);

  function selectTab(next: string) {
    setTab(next);
    const p = new URLSearchParams(params);
    if (next === fallbackId) p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
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

      <Suspense fallback={<TabLoading />}>
        {Active && <Active />}
      </Suspense>
    </div>
  );
}

function TabLoading() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
      Loading…
    </div>
  );
}
