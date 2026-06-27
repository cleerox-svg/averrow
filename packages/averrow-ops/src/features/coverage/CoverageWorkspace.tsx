// v4 "Coverage" workspace — consolidates the detection-surface pages (Apps,
// Dark Web, Trademarks, Trends) under one nav entry as deep-linkable tabs.
// Each standalone route (/apps, /dark-web, /trademarks, /trends) stays live
// for pivots and bookmarks.

import { lazy } from 'react';
import { Smartphone, EyeOff, Award, TrendingUp } from 'lucide-react';
import { TabbedWorkspace, type WorkspaceTab } from '@/components/v4/TabbedWorkspace';

const Apps = lazy(() => import('@/features/apps/Apps').then(m => ({ default: m.Apps })));
const DarkWeb = lazy(() => import('@/features/dark-web/DarkWeb').then(m => ({ default: m.DarkWeb })));
const Trademarks = lazy(() => import('@/features/trademarks/Trademarks').then(m => ({ default: m.Trademarks })));
const Trends = lazy(() => import('@/features/trends/Trends').then(m => ({ default: m.Trends })));

const TABS: WorkspaceTab[] = [
  { id: 'apps', label: 'Apps', icon: Smartphone, Component: Apps,
    def: 'App-store impersonation coverage — fake mobile listings mimicking your brand by bundle ID, name, or developer.' },
  { id: 'dark-web', label: 'Dark Web', icon: EyeOff, Component: DarkWeb,
    def: 'Paste archives and leak forums monitored for brand mentions — confirmed leaks and ransomware listings.' },
  { id: 'trademarks', label: 'Trademarks', icon: Award, Component: Trademarks,
    def: 'Wordmark misuse unified across social, app-store, and domain signals — where your marks are being abused.' },
  { id: 'trends', label: 'Trends', icon: TrendingUp, Component: Trends,
    def: 'Threat trends over time — what is rising, falling, and shifting across the detection surfaces.' },
];

export function CoverageWorkspace() {
  return <TabbedWorkspace crumb="INTELLIGENCE" title="Coverage" tabs={TABS} />;
}
