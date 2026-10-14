/**
 * Takedown effectiveness (providers-geo `takedown`, takedowns-geo) is limited to
 * roles holding `manage_takedowns`; the server answers 403 / null for the rest.
 * The UI checks the same permission so non-holders never fire the request and see
 * a neutral note instead of an error or an empty-looking "no data".
 *
 * The takedowns-geo hook (`useTakedownsGeo`) applies the same check itself, so a
 * caller cannot forget it.
 */

import { useCanManageTakedowns } from '@/hooks/useObservatoryLenses';
import { roleHasPermission } from '@/lib/permissions';

export function canSeeTakedowns(role: string | null | undefined): boolean {
  return roleHasPermission(role, 'manage_takedowns');
}

export const useCanSeeTakedowns = useCanManageTakedowns;
