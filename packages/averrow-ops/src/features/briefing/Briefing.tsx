// One briefing shell, two bodies (Phase 1 PR7a, owner decision "one briefing
// component, two data sources").
//
//   <Briefing source="intelligence" />   Home. Observer's latest insight from
//                                        /api/trends/intelligence, with entity
//                                        "source" chips.
//   <Briefing source="ops" />            /admin -> Briefing tab. The 12-section
//                                        Platform Operations Briefing
//                                        (`threat_briefings`) plus the sections
//                                        the old widget ignored.
//
// The shell (BriefingShell.tsx) owns the header, freshness, action slot and the
// loading / error / empty states; each body only decides which state applies
// and renders its content.

import { lazy, Suspense } from 'react';
import { PageState } from '@/design-system/components';
import { IntelligenceBriefingBody } from './IntelligenceBody';

// The ops body is ~700 lines of admin-only tables; keep it out of Home's chunk.
const OpsBriefingBody = lazy(() => import('./OpsBody').then((m) => ({ default: m.OpsBriefingBody })));

export { BriefingShell, briefingFreshness } from './BriefingShell';
export type { BriefingShellProps, BriefingSource, BriefingStatus, Freshness } from './BriefingShell';

export type BriefingProps =
  | { source: 'intelligence' }
  | { source: 'ops' };

export function Briefing(props: BriefingProps) {
  if (props.source === 'ops') {
    return (
      <Suspense fallback={<PageState kind="loading" layout="card" compact title="Loading briefing…" />}>
        <OpsBriefingBody />
      </Suspense>
    );
  }
  return <IntelligenceBriefingBody />;
}
