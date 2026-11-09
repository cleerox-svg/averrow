// v4 "Explorer" workspace — consolidates the four threat-intel entity
// explorers (Brands, Threat Actors, Campaigns, Providers) under one nav entry
// as deep-linkable tabs. The old standalone list paths (/brands,
// /threat-actors, /campaigns, /providers) redirect here (LEGACY_TAB_PATHS).

import { lazy } from 'react';
import { Shield, Users, Activity, Server } from 'lucide-react';
import { TabbedWorkspace, type WorkspaceTab } from '@/components/v4/TabbedWorkspace';
import { loadBrands, loadThreatActors, loadCampaigns, loadProviders } from './tabLoaders';

const Brands = lazy(loadBrands);
const ThreatActors = lazy(loadThreatActors);
const Campaigns = lazy(loadCampaigns);
const Providers = lazy(loadProviders);

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
