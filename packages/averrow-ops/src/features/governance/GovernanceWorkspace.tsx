// v4 "Governance" workspace — consolidates the compliance/config trio
// (Audit Log, Pricing, Platform Notifications) under one nav entry as
// deep-linkable tabs. Tabs are role-gated to match the APIs they call:
// Audit Log and Users need admin (/api/admin/audit is requireAdmin);
// Pricing needs view_billing; Platform Notifications is super_admin-only.
// The old standalone paths (/admin/audit, /admin/pricing, ...) redirect here.
// A staff user with no visible tab is sent back to /admin, as the old
// gated pages did.

import { lazy } from 'react';
import { Navigate } from 'react-router-dom';
import { ClipboardList, DollarSign, Bell, Users } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { TabbedWorkspace, type WorkspaceTab } from '@/components/v4/TabbedWorkspace';

const AdminAudit = lazy(() => import('@/features/admin/AdminAudit').then(m => ({ default: m.AdminAudit })));
const PricingConfig = lazy(() => import('@/features/admin/PricingConfig').then(m => ({ default: m.PricingConfig })));
const NotificationCenter = lazy(() => import('@/features/admin/NotificationCenter').then(m => ({ default: m.NotificationCenter })));
const PlatformUsers = lazy(() => import('@/features/admin/PlatformUsers').then(m => ({ default: m.PlatformUsers })));

export function GovernanceWorkspace() {
  const { user, isSuperAdmin } = useAuth();
  const isAdmin = isSuperAdmin || user?.role === 'admin';

  const tabs: WorkspaceTab[] = [
    ...(isAdmin
      ? [{ id: 'audit', label: 'Audit Log', icon: ClipboardList, Component: AdminAudit,
          def: 'The compliance audit trail — every privileged action on the platform, filterable by outcome, window, and action type.' } as WorkspaceTab,
         { id: 'users', label: 'Users', icon: Users, Component: PlatformUsers,
          def: 'Platform accounts — roles, access status, sessions, force sign-out, and staff invitations.' } as WorkspaceTab]
      : []),
    ...(roleHasPermission(user?.role, 'view_billing')
      ? [{ id: 'pricing', label: 'Pricing', icon: DollarSign, Component: PricingConfig,
          def: 'Global baseline prices for plans and modules. Per-customer overrides live on the Customers page.' } as WorkspaceTab]
      : []),
    ...(isSuperAdmin
      ? [{ id: 'notifications', label: 'Platform Notifications', icon: Bell, Component: NotificationCenter,
          def: 'Platform-wide notification volume and system mutes — silence a noisy notification type for everyone.' } as WorkspaceTab]
      : []),
  ];

  if (tabs.length === 0) return <Navigate to="/admin" replace />;
  return <TabbedWorkspace crumb="PLATFORM" title="Governance" tabs={tabs} />;
}
