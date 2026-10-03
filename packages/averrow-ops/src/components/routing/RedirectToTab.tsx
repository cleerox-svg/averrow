// Redirects a retired standalone page path to its workspace `?tab=` URL.
//
// Preserves the incoming query string and hash; the tab param wins over any
// incoming `tab`. Uses `replace` so the dead URL doesn't pollute history.

import { Navigate, useLocation } from 'react-router-dom';
import { buildTabUrl, WORKSPACE_TABS, type WorkspaceTabKey } from '@/lib/workspaceRoutes';

export function RedirectToTab({ tabKey }: { tabKey: WorkspaceTabKey }) {
  const { search, hash } = useLocation();
  return <Navigate to={buildTabUrl(WORKSPACE_TABS[tabKey], new URLSearchParams(search), hash)} replace />;
}
