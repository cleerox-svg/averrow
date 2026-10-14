/**
 * Takedown effectiveness (providers-geo `takedown`, takedowns-geo) is limited to
 * roles holding `manage_takedowns`; the server answers 403 / null for the rest.
 * The UI checks the same permission so non-holders never fire the request and see
 * a neutral note instead of an error or an empty-looking "no data".
 */

import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';

export function canSeeTakedowns(role: string | null | undefined): boolean {
  return roleHasPermission(role, 'manage_takedowns');
}

export function useCanSeeTakedowns(): boolean {
  const { user } = useAuth();
  return canSeeTakedowns(user?.role);
}
