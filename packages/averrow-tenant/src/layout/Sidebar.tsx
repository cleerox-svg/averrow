// averrow-tenant — sidebar.
//
// One entry per module the tenant has access to. Modules show as
// active / trial / suspended badges; not_entitled modules render in a separate
// "Unlock" section with an upsell pill (clicks → /settings/modules
// once that lands in Phase B).

import type { Ref } from 'react';
import { NavLink } from 'react-router-dom';
import { X, Globe, Users, Smartphone, EyeOff, Inbox, Award, Crosshair, Settings, Bell, AlertTriangle, Send, Sun, Moon, Laptop, ShieldAlert, SlidersHorizontal, ScrollText, LayoutDashboard, ListFilter, FolderSearch, UserCog, type LucideIcon } from 'lucide-react';
import { useTenantModules, MODULE_LABELS, type ModuleKey } from '@/lib/modules';
import { useCanViewAudit } from '@/lib/auditLog';
import { useTheme } from '@/lib/useTheme';
import { cn } from '@/lib/cn';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { Badge } from '@averrow/shared/ui';
import { AverrowLogo } from './AverrowLogo';

const MODULE_ICONS: Record<ModuleKey, LucideIcon> = {
  domain:        Globe,
  social:        Users,
  app_store:     Smartphone,
  dark_web:      EyeOff,
  abuse_mailbox: Inbox,
  trademark:     Award,
  threat_actor:  Crosshair,
};

const MODULE_PATHS: Record<ModuleKey, string> = {
  domain:        '/modules/domain',
  social:        '/modules/social',
  app_store:     '/modules/app-store',
  dark_web:      '/modules/dark-web',
  abuse_mailbox: '/modules/abuse-mailbox',
  trademark:     '/modules/trademark',
  threat_actor:  '/modules/threat-actor',
};

// min-h-11: 44px touch targets in the mobile drawer; desktop keeps its density.
const NAV_BASE = 'flex items-center gap-3 px-3 py-2 min-h-11 md:min-h-0 [@media(pointer:coarse)]:min-h-11 rounded-lg text-[13px] transition-colors ds-focusable';
const NAV_INACTIVE = 'text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] hover:text-[var(--text-primary)]';
const NAV_ACTIVE   = 'bg-primary/[0.10] text-primary-text border border-primary/[0.20]';

function themeIconFor(theme: 'auto' | 'dark' | 'light') {
  if (theme === 'auto')  return Laptop;
  if (theme === 'light') return Sun;
  return Moon;
}

function themeLabelFor(theme: 'auto' | 'dark' | 'light'): string {
  if (theme === 'auto')  return 'Theme: auto (follows OS) — click for dark';
  if (theme === 'dark')  return 'Theme: dark — click for light';
  return 'Theme: light — click for auto';
}

export function Sidebar({ open = false, onClose, closeRef }: { open?: boolean; onClose?: () => void; closeRef?: Ref<HTMLButtonElement> }) {
  const { data, isLoading } = useTenantModules();
  const { theme, cycle: cycleTheme } = useTheme();
  const ThemeIcon = themeIconFor(theme);
  const canViewAudit = useCanViewAudit();

  const active = (data?.modules ?? []).filter((m) => m.status === 'active' || m.status === 'trial');
  // Suspended modules stay in the customer's own list (badged); only never-bought ones are upsell.
  const owned = (data?.modules ?? []).filter((m) => m.status === 'active' || m.status === 'trial' || m.status === 'suspended');
  const locked = (data?.modules ?? []).filter((m) => m.status === 'not_entitled');

  return (
    <aside
      id="tenant-sidebar"
      {...(open ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Main navigation' } : {})}
      className={cn(
        // Below md the sidebar is an off-canvas drawer (a permanent 240px
        // column left ~150px of content at 390px and made every page scroll
        // horizontally). From md up it is the static column it always was.
        'w-60 shrink-0 h-full flex flex-col bg-bg-sidebar border-r border-[var(--border-base)]',
        'fixed inset-y-0 left-0 z-40 transition-[transform,visibility] motion-reduce:transition-none md:static md:z-auto md:translate-x-0 md:visible',
        // Opening flips visibility instantly (0s) so focus can move in on the same
        // frame; closing keeps it visible for the 200ms slide-out, then hides it.
        open
          ? 'translate-x-0 visible [transition-duration:200ms,0s]'
          : '-translate-x-full invisible [transition-duration:200ms,200ms]',
      )}
    >
      <div className="px-4 py-4 border-b border-[var(--border-base)] flex items-start justify-between gap-2">
        <AverrowLogo />
        <div className="flex items-center gap-2 md:gap-1">
        <button
          type="button"
          onClick={cycleTheme}
          aria-label={themeLabelFor(theme)}
          title={themeLabelFor(theme)}
          className="inline-flex h-11 w-11 md:h-auto md:w-auto md:p-1.5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 items-center justify-center rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] transition-colors ds-focusable"
        >
          <ThemeIcon size={14} />
        </button>
        <button
          type="button"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close navigation"
          className="md:hidden inline-flex h-11 w-11 -mr-2 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] hover:text-[var(--text-primary)] transition-colors ds-focusable"
        >
          <X size={20} />
        </button>
        </div>
      </div>

      {/* Route changes close the drawer (Shell); this also closes it when the
          tapped link is the page you're already on. */}
      <nav
        aria-label="Primary"
        className="flex-1 overflow-y-auto overscroll-contain py-3 px-2 space-y-4"
        onClick={(e) => { if ((e.target as Element).closest('a')) onClose?.(); }}
      >
        <Section label="Workspace">
          <NavLink to="/console" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <LayoutDashboard size={16} />
            <span>Console</span>
          </NavLink>
          <NavLink to="/" end className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <Globe size={16} />
            <span>Overview</span>
          </NavLink>
          <NavLink to="/threats" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <ShieldAlert size={16} />
            <span>Threats</span>
          </NavLink>
          <NavLink to="/alerts" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <AlertTriangle size={16} />
            <span>Alerts</span>
          </NavLink>
          <NavLink to="/notifications" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <Bell size={16} />
            <span>Notifications</span>
          </NavLink>
          <NavLink to="/takedowns" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <Send size={16} />
            <span>Takedowns</span>
          </NavLink>
          <NavLink to="/investigations" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <FolderSearch size={16} />
            <span>Investigations</span>
          </NavLink>
        </Section>

        <Section label="Modules">
          {isLoading && <div className="px-3 py-2 text-[12px] text-[var(--text-tertiary)]">Loading…</div>}
          {!isLoading && owned.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-[var(--text-tertiary)]">No modules entitled yet.</div>
          )}
          {owned.map((m) => {
            const Icon = MODULE_ICONS[m.module_key];
            return (
              <NavLink
                key={m.module_key}
                to={MODULE_PATHS[m.module_key]}
                className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}
              >
                <Icon size={16} />
                <span className="min-w-0 flex-1 truncate" title={MODULE_LABELS[m.module_key]}>{MODULE_LABELS[m.module_key]}</span>
                {m.status === 'suspended' && (
                  <Badge status="warning" size="xs" font="sans" label="Suspended" className="shrink-0 !py-0 !leading-4" />
                )}
                {m.status === 'trial' && (
                  <Badge status="running" size="xs" font="sans" label="Trial" className="shrink-0 !py-0 !leading-4" />
                )}
              </NavLink>
            );
          })}
        </Section>

        {locked.length > 0 && (
          <Section label="Unlock">
            {locked.map((m) => {
              const Icon = MODULE_ICONS[m.module_key];
              return (
                <NavLink
                  key={m.module_key}
                  to={MODULE_PATHS[m.module_key]}
                  className={cn(NAV_BASE, 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]')}
                >
                  <Icon size={16} className="opacity-50" />
                  <span className="min-w-0 flex-1 truncate" title={MODULE_LABELS[m.module_key]}>{MODULE_LABELS[m.module_key]}</span>
                  <span className="shrink-0 text-[12px] font-medium text-[var(--text-tertiary)]">Upgrade</span>
                </NavLink>
              );
            })}
          </Section>
        )}

        <Section label="Account">
          <NavLink to="/automation-policy" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <SlidersHorizontal size={16} />
            <span>Automation Policy</span>
          </NavLink>
          <NavLink to="/settings/monitoring" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <ListFilter size={16} />
            <span>Monitoring Rules</span>
          </NavLink>
          <NavLink to="/settings/executives" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <UserCog size={16} />
            <span>Executives</span>
          </NavLink>
          {canViewAudit && (
            <NavLink to="/audit-log" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
              <ScrollText size={16} />
              <span>Audit Log</span>
            </NavLink>
          )}
          <NavLink to="/settings" className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}>
            <Settings size={16} />
            <span>Settings</span>
          </NavLink>
        </Section>
      </nav>
      <div
        className="px-3 py-2.5 border-t border-[var(--border-base)] font-mono text-[12px] text-[var(--text-tertiary)]"
        title={`${VERSION_LABEL} · ${BUILD_SHA}`}
      >
        {VERSION_LABEL} · {BUILD_SHA}
      </div>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-3 mb-1 text-[12px] font-medium text-[var(--text-tertiary)]">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
