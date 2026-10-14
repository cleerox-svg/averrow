/**
 * Lens data + memoised models in one place: the lens queries (each enabled only
 * while its layer — or a selection / search that needs it — is on) and the pure
 * transforms that turn their payloads into drawable models. Models are memoised
 * on data identity, so deck layers see stable data between polls.
 */

import { useMemo } from 'react';
import {
  useActorDetail, useActorList, useCampaignsGeo, useMovements, useObservatoryTimeline, useOperationsGeo,
  useOverindex, useProvidersGeo, useTakedownsGeo, useVelocityNodes,
  type ActorListItem, type CampaignGeo, type Movement, type OperationGeo, type ProviderGeo, type OverindexRow, type TakedownGeoRow,
} from '@/hooks/useObservatoryLenses';
import { periodToMs } from './trips';
import type { DataNeeds } from './mode-data';
import { buildOperationsModel } from './lens/operations';
import { buildHostingModel } from './lens/hosting';
import { buildBaselineModel } from './lens/baseline';
import { buildCampaignsModel } from './lens/campaigns';
import { buildActorModel } from './lens/actors';
import { buildMovementModel } from './lens/movement';
import { buildVelocityModel } from './lens/velocity';
import { buildTakedownCountryModel, buildTakedownProviderModel } from './lens/takedowns';
import { useCountryGeometry } from './country-geometry';

const NO_OPS: OperationGeo[] = [];

export interface UseLensDataArgs {
  needs: DataNeeds;
  period: string;
  source: string;
  /** Actor whose infrastructure to load (actors lens or an actor selection). */
  actorId: string | null;
  /** Filter the replay histogram to one country. */
  timelineCountry: string | null;
  /** Replay window end (ms): movement trails are timed inside [replayNowMs - period, replayNowMs], like the particles. */
  replayNowMs: number;
}

export function useLensData({ needs, period, source, actorId, timelineCountry, replayNowMs }: UseLensDataArgs) {
  const operationsQ = useOperationsGeo({ enabled: needs.operations });
  const movementsQ = useMovements({ enabled: needs.movements, period });
  const providersQ = useProvidersGeo({ enabled: needs.providers });
  const overindexQ = useOverindex({ enabled: needs.overindex, period });
  const campaignsQ = useCampaignsGeo({ enabled: needs.campaigns });
  const actorsQ = useActorList({ enabled: needs.actors });
  const actorDetailQ = useActorDetail(actorId, { enabled: needs.actors });
  // The Fast view's replay bar is the velocity series (no source split: the server 400s velocity + a source).
  const timelineQ = useObservatoryTimeline({
    enabled: needs.timeline, period, source, country: timelineCountry, velocity: needs.velocity ? 'all' : null,
  });
  const velocityQ = useVelocityNodes({ enabled: needs.velocity, period });
  // Requires manage_takedowns: the hook never requests either for any other role.
  const takedownCountriesQ = useTakedownsGeo({ enabled: needs.takedownsCountry, period, by: 'country' });
  const takedownProvidersQ = useTakedownsGeo({ enabled: needs.takedownsProvider, period, by: 'provider' });
  // Shapes load only while a choropleth is visible, never for a country drawer or a lens that draws no shapes.
  const geometry = useCountryGeometry(needs.geometry);

  const operations: readonly OperationGeo[] | undefined = operationsQ.data?.data.operations;
  const components = operationsQ.data?.data.components;
  const operationsModel = useMemo(
    () => (operations && components ? buildOperationsModel(operations, components) : null),
    [operations, components],
  );

  const movements: readonly Movement[] | undefined = movementsQ.data?.data;
  const movementModel = useMemo(
    () => (movements ? buildMovementModel(movements, { nowMs: replayNowMs, periodMs: periodToMs(period) }) : null),
    [movements, period, replayNowMs],
  );

  const providers: readonly ProviderGeo[] | undefined = providersQ.data?.data;
  const hostingModel = useMemo(() => (providers ? buildHostingModel(providers) : null), [providers]);

  const overindex: readonly OverindexRow[] | undefined = overindexQ.data?.data;
  const baselineModel = useMemo(() => (overindex ? buildBaselineModel(overindex) : null), [overindex]);

  const campaigns: readonly CampaignGeo[] | undefined = campaignsQ.data?.data;
  const campaignsModel = useMemo(() => (campaigns ? buildCampaignsModel(campaigns) : null), [campaigns]);

  const takedownCountries: readonly TakedownGeoRow[] | undefined = takedownCountriesQ.data?.data;
  const takedownCountryModel = useMemo(() => (takedownCountries ? buildTakedownCountryModel(takedownCountries) : null), [takedownCountries]);
  const takedownProviders: readonly TakedownGeoRow[] | undefined = takedownProvidersQ.data?.data;
  const takedownProviderModel = useMemo(
    () => (takedownProviders && hostingModel ? buildTakedownProviderModel(hostingModel, takedownProviders) : null),
    [takedownProviders, hostingModel],
  );

  const velocityNodes = velocityQ.data?.data;
  const velocityDropped = velocityQ.data?.meta.dropped_no_centroid ?? 0;
  const velocityModel = useMemo(
    () => (velocityNodes ? buildVelocityModel(velocityNodes, velocityDropped) : null),
    [velocityNodes, velocityDropped],
  );

  const actorDetail = actorId ? actorDetailQ.data?.data : undefined;
  const actorModel = useMemo(() => (actorDetail ? buildActorModel(actorDetail) : null), [actorDetail]);
  const actorList: readonly ActorListItem[] | undefined = actorsQ.data?.data;

  return {
    operationsQ, movementsQ, providersQ, overindexQ, campaignsQ, actorsQ, actorDetailQ, timelineQ, velocityQ, takedownCountriesQ, takedownProvidersQ,
    geometry,
    operations: operations ?? NO_OPS,
    operationsLoaded: operations !== undefined,
    movements, providers, overindex, campaigns, actorList, takedownCountries, takedownProviders,
    operationsModel, movementModel, hostingModel, baselineModel, campaignsModel, actorModel, velocityModel,
    takedownCountryModel, takedownProviderModel,
  };
}

export type LensData = ReturnType<typeof useLensData>;
