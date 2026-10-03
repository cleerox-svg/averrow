// Single source of truth for "which workspace tab renders this page".
//
// The v4 shell hosts most list pages as `?tab=` panes inside five workspaces
// (Console / Explorer / Coverage / Operations / Governance). Each page used to
// ALSO be mounted at its own standalone path, giving two URLs per page and two
// highlighted nav states. The standalone paths are now redirects (see
// components/routing/RedirectToTab.tsx) and in-app links go straight to the
// canonical tab URL via `tabUrl()`.
//
// Detail routes (/brands/:id, /campaigns/:id, …) are NOT in this table.

export type WorkspaceTabKey =
  | 'alerts' | 'threats' | 'incidents' | 'takedowns'
  | 'brands' | 'actors' | 'campaigns' | 'providers'
  | 'apps' | 'dark-web' | 'trademarks' | 'trends'
  | 'agents' | 'feeds' | 'takedown-integrations' | 'attribution'
  | 'audit' | 'users' | 'pricing' | 'notifications';

export interface WorkspaceTarget {
  /** Workspace route path (no query). */
  path: string;
  /** `?tab=` id inside that workspace. */
  tab: WorkspaceTabKey;
}

export const WORKSPACE_TABS: Readonly<Record<WorkspaceTabKey, WorkspaceTarget>> = {
  alerts: { path: '/console', tab: 'alerts' },
  threats: { path: '/console', tab: 'threats' },
  incidents: { path: '/console', tab: 'incidents' },
  takedowns: { path: '/console', tab: 'takedowns' },
  brands: { path: '/explore', tab: 'brands' },
  actors: { path: '/explore', tab: 'actors' },
  campaigns: { path: '/explore', tab: 'campaigns' },
  providers: { path: '/explore', tab: 'providers' },
  apps: { path: '/coverage', tab: 'apps' },
  'dark-web': { path: '/coverage', tab: 'dark-web' },
  trademarks: { path: '/coverage', tab: 'trademarks' },
  trends: { path: '/coverage', tab: 'trends' },
  agents: { path: '/admin/operations', tab: 'agents' },
  feeds: { path: '/admin/operations', tab: 'feeds' },
  'takedown-integrations': { path: '/admin/operations', tab: 'takedown-integrations' },
  attribution: { path: '/admin/operations', tab: 'attribution' },
  audit: { path: '/admin/governance', tab: 'audit' },
  users: { path: '/admin/governance', tab: 'users' },
  pricing: { path: '/admin/governance', tab: 'pricing' },
  notifications: { path: '/admin/governance', tab: 'notifications' },
};

/**
 * Legacy standalone list path → tab key. Only list/index routes; detail routes
 * keep their own pages. `/intelligence` is the older alias of `/trends`.
 */
export const LEGACY_TAB_PATHS: Readonly<Record<string, WorkspaceTabKey>> = {
  '/alerts': 'alerts',
  '/threats': 'threats',
  '/admin/incidents': 'incidents',
  '/admin/takedowns': 'takedowns',
  '/brands': 'brands',
  '/brands-v3': 'brands',
  '/threat-actors': 'actors',
  '/campaigns': 'campaigns',
  '/providers': 'providers',
  '/apps': 'apps',
  '/dark-web': 'dark-web',
  '/trademarks': 'trademarks',
  '/trends': 'trends',
  '/intelligence': 'trends',
  '/agents': 'agents',
  '/feeds': 'feeds',
  '/admin/feeds': 'feeds',
  '/admin/agents': 'agents',
  '/admin/integrations': 'takedown-integrations',
  '/admin/agents/attribution-backlog': 'attribution',
  '/admin/audit': 'audit',
  '/admin/platform-users': 'users',
  '/admin/pricing': 'pricing',
  '/admin/notifications': 'notifications',
};

/**
 * Build a workspace URL for a tab, merging extra query params and an optional
 * hash. The `tab` param is always first and always wins over any `tab` in
 * `extra`. Values are percent-encoded with encodeURIComponent.
 */
export function buildTabUrl(
  target: WorkspaceTarget,
  extra?: URLSearchParams | Record<string, string | undefined | null>,
  hash = '',
): string {
  const parts: string[] = [`tab=${encodeURIComponent(target.tab)}`];
  const push = (k: string, v: string) => {
    if (k === 'tab') return;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  };
  if (extra instanceof URLSearchParams) {
    extra.forEach((v, k) => push(k, v));
  } else if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null) push(k, v);
    }
  }
  const h = hash && hash !== '#' ? (hash.startsWith('#') ? hash : `#${hash}`) : '';
  return `${target.path}?${parts.join('&')}${h}`;
}

/** Canonical in-app URL for a workspace tab, e.g. `tabUrl('threats', { q })`. */
export function tabUrl(
  key: WorkspaceTabKey,
  extra?: Record<string, string | undefined | null>,
): string {
  return buildTabUrl(WORKSPACE_TABS[key], extra);
}
