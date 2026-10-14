/**
 * Lens data + memoised models in one place: the lens queries (each enabled only
 * while its layer — or a selection / search that needs it — is on) and the pure
 * transforms that turn their payloads into drawable models. Models are memoised
 * on data identity, so deck layers see stable data between polls.
 */

import { useMemo } from 'react';
import {
  useActorDetail, useActorList, useCampaignsGeo, useMovements, useObservatoryTimeline, useOperationsGeo,
  useOverindex, useProvidersGeo,
  type ActorListItem, type CampaignGeo, type Movement, type OperationGeo, type ProviderGeo, type OverindexRow,
} from '@/hooks/useObservatoryLenses';
import { periodToMs } from './trips';
import type { DataNeeds } from './mode-data';
import { buildOperationsModel } from './lens/operations';
import { buildHostingModel } from './lens/hosting';
import { buildBaselineModel } from './lens/baseline';
import { buildCampaignsModel } from './lens/campaigns';
import { buildActorModel } from './lens/actors';
import { buildMovementModel } from './lens/movement';
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
}

export function useLensData({ needs, period, source, actorId, timelineCountry }: UseLensDataArgs) {
  const operationsQ = useOperationsGeo({ enabled: needs.operations });
  const movementsQ = useMovements({ enabled: needs.movements, period });
  const providersQ = useProvidersGeo({ enabled: needs.providers });
  const overindexQ = useOverindex({ enabled: needs.overindex, period });
  const campaignsQ = useCampaignsGeo({ enabled: needs.campaigns });
  const actorsQ = useActorList({ enabled: needs.actors });
  const actorDetailQ = useActorDetail(actorId, { enabled: needs.actors });
  const timelineQ = useObservatoryTimeline({ enabled: needs.timeline, period, source, country: timelineCountry });
  const geometry = useCountryGeometry(needs.overindex);

  const operations: readonly OperationGeo[] | undefined = operationsQ.data?.data.operations;
  const components = operationsQ.data?.data.components;
  const operationsModel = useMemo(
    () => (operations && components ? buildOperationsModel(operations, components) : null),
    [operations, components],
  );

  const movements: readonly Movement[] | undefined = movementsQ.data?.data;
  const movementModel = useMemo(
    () => (movements ? buildMovementModel(movements, { nowMs: Date.now(), periodMs: periodToMs(period) }) : null),
    [movements, period],
  );

  const providers: readonly ProviderGeo[] | undefined = providersQ.data?.data;
  const hostingModel = useMemo(() => (providers ? buildHostingModel(providers) : null), [providers]);

  const overindex: readonly OverindexRow[] | undefined = overindexQ.data?.data;
  const baselineModel = useMemo(() => (overindex ? buildBaselineModel(overindex) : null), [overindex]);

  const campaigns: readonly CampaignGeo[] | undefined = campaignsQ.data?.data;
  const campaignsModel = useMemo(() => (campaigns ? buildCampaignsModel(campaigns) : null), [campaigns]);

  const actorDetail = actorId ? actorDetailQ.data?.data : undefined;
  const actorModel = useMemo(() => (actorDetail ? buildActorModel(actorDetail) : null), [actorDetail]);
  const actorList: readonly ActorListItem[] | undefined = actorsQ.data?.data;

  return {
    operationsQ, movementsQ, providersQ, overindexQ, campaignsQ, actorsQ, actorDetailQ, timelineQ,
    geometry,
    operations: operations ?? NO_OPS,
    operationsLoaded: operations !== undefined,
    movements, providers, overindex, campaigns, actorList,
    operationsModel, movementModel, hostingModel, baselineModel, campaignsModel, actorModel,
  };
}

export type LensData = ReturnType<typeof useLensData>;
