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
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';

/** The one line shown where a Takedowns link was refused to a role that does not manage takedowns. */
export const TAKEDOWN_ROLE_NOTE = 'Takedown outcomes are shown to roles that manage takedowns.';

/** `unknown` until the signed-in user is known: a shared link must not be rewritten on a guess. */
export type TakedownAccess = 'allowed' | 'denied' | 'unknown';

export function takedownAccess(user: { role?: string | null } | null | undefined): TakedownAccess {
  if (!user) return 'unknown';
  return canSeeTakedowns(user.role) ? 'allowed' : 'denied';
}

export function useTakedownAccess(): TakedownAccess {
  const { user } = useAuth();
  return takedownAccess(user);
}

export function canSeeTakedowns(role: string | null | undefined): boolean {
  return roleHasPermission(role, 'manage_takedowns');
}

export const useCanSeeTakedowns = useCanManageTakedowns;
