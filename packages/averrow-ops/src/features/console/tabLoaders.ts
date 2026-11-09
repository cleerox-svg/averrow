// Light-weight registry of the Console tab chunk factories. Kept free of
// React/heavy imports so App.tsx can start the active tab's download at boot
// (in parallel with auth) without pulling Console into the main bundle.
// Console.tsx wraps the same factories in React.lazy, so each module is
// fetched exactly once.

export const loadAlerts = () => import('@/features/alerts/Alerts').then(m => ({ default: m.Alerts }));
export const loadThreats = () => import('@/features/threats/Threats').then(m => ({ default: m.Threats }));
export const loadTakedowns = () => import('@/features/takedowns/Takedowns').then(m => ({ default: m.Takedowns }));
export const loadIncidents = () => import('@/features/admin-incidents/Incidents').then(m => ({ default: m.AdminIncidents }));

const LOADERS: Record<string, () => Promise<unknown>> = {
  alerts: loadAlerts,
  threats: loadThreats,
  incidents: loadIncidents,
  takedowns: loadTakedowns,
};

/** Start loading the pane for `?tab=` (`signals` is the legacy alias of alerts; default alerts). */
export function preloadConsoleTab(tab: string | null): void {
  const key = tab === 'signals' || !tab || !(tab in LOADERS) ? 'alerts' : tab;
  void LOADERS[key]().catch(() => undefined);
}
