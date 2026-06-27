// v4 "Explorer" workspace — consolidates the four threat-intel entity
// explorers (Brands, Threat Actors, Campaigns, Providers) under one nav entry
// as deep-linkable tabs. Each standalone route (/brands, /threat-actors,
// /campaigns, /providers) stays live for pivots and bookmarks.

import { lazy } from 'react';
import { Shield, Users, Activity, Server } from 'lucide-react';
import { TabbedWorkspace, type WorkspaceTab } from '@/components/v4/TabbedWorkspace';

const Brands = lazy(() => import('@/features/brands/Brands').then(m => ({ default: m.BrandsV3 })));
const ThreatActors = lazy(() => import('@/features/threat-actors/ThreatActors').then(m => ({ default: m.ThreatActors })));
const Campaigns = lazy(() => import('@/features/campaigns/Campaigns').then(m => ({ default: m.Campaigns })));
const Providers = lazy(() => import('@/features/providers/Providers').then(m => ({ default: m.Providers })));

const TABS: WorkspaceTab[] = [
  { id: 'brands', label: 'Brands', icon: Shield, Component: Brands,
    def: 'The brands you protect — exposure, defense posture, and the pressure each is under across the catalog.' },
  { id: 'actors', label: 'Threat Actors', icon: Users, Component: ThreatActors,
    def: 'State-sponsored and organized threat actors — infrastructure, TTPs, attribution, and the brands in their crosshairs.' },
  { id: 'campaigns', label: 'Campaigns', icon: Activity, Component: Campaigns,
    def: 'Correlated threat campaigns — grouped infrastructure and activity that point to a single coordinated operation.' },
  { id: 'providers', label: 'Providers', icon: Server, Component: Providers,
    def: 'Hosting providers and infrastructure clusters carrying threat activity — accelerating, pivoting, or going quiet.' },
];

export function ExploreWorkspace() {
  return <TabbedWorkspace crumb="INTELLIGENCE" title="Explorer" tabs={TABS} />;
}
