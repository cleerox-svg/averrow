// v4 "Governance" workspace — consolidates the compliance/config trio
// (Audit Log, Pricing, Platform Notifications) under one nav entry as
// deep-linkable tabs. Tabs are role-gated to match the pages they mount:
// Pricing needs view_billing; Platform Notifications is super_admin-only
// (the page itself bounces everyone else to /admin). Standalone routes
// (/admin/audit, /admin/pricing, /admin/notifications) stay live.

import { lazy } from 'react';
import { ClipboardList, DollarSign, Bell } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { TabbedWorkspace, type WorkspaceTab } from '@/components/v4/TabbedWorkspace';

const AdminAudit = lazy(() => import('@/features/admin/AdminAudit').then(m => ({ default: m.AdminAudit })));
const PricingConfig = lazy(() => import('@/features/admin/PricingConfig').then(m => ({ default: m.PricingConfig })));
const NotificationCenter = lazy(() => import('@/features/admin/NotificationCenter').then(m => ({ default: m.NotificationCenter })));

export function GovernanceWorkspace() {
  const { user, isSuperAdmin } = useAuth();

  const tabs: WorkspaceTab[] = [
    { id: 'audit', label: 'Audit Log', icon: ClipboardList, Component: AdminAudit,
      def: 'The compliance audit trail — every privileged action on the platform, filterable by outcome, window, and action type.' },
    ...(roleHasPermission(user?.role, 'view_billing')
      ? [{ id: 'pricing', label: 'Pricing', icon: DollarSign, Component: PricingConfig,
          def: 'Global baseline prices for plans and modules. Per-customer overrides live on the Customers page.' } as WorkspaceTab]
      : []),
    ...(isSuperAdmin
      ? [{ id: 'notifications', label: 'Platform Notifications', icon: Bell, Component: NotificationCenter,
          def: 'Platform-wide notification volume and system mutes — silence a noisy notification type for everyone.' } as WorkspaceTab]
      : []),
  ];

  return <TabbedWorkspace crumb="PLATFORM" title="Governance" tabs={tabs} />;
}
