// averrow-tenant — sidebar.
//
// One entry per module the tenant has access to. Modules show as
// active / trial badges; not_entitled modules render in a separate
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

const NAV_BASE = 'flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] transition-colors';
const NAV_INACTIVE = 'text-white/55 hover:bg-white/[0.04] hover:text-white/85';
const NAV_ACTIVE   = 'bg-amber/[0.10] text-amber border border-amber/[0.20]';

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
  const locked = (data?.modules ?? []).filter((m) => m.status === 'not_entitled' || m.status === 'suspended');

  return (
    <aside
      id="tenant-sidebar"
      {...(open ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Main navigation' } : {})}
      className={cn(
        // Below md the sidebar is an off-canvas drawer (a permanent 240px
        // column left ~150px of content at 390px and made every page scroll
        // horizontally). From md up it is the static column it always was.
        'w-60 shrink-0 h-full flex flex-col bg-bg-sidebar border-r border-white/[0.06]',
        'fixed inset-y-0 left-0 z-40 transition-[transform,visibility] duration-200 motion-reduce:transition-none md:static md:z-auto md:translate-x-0 md:visible',
        // Opening flips visibility instantly (0s) so focus can move in on the same
        // frame; closing keeps it visible for the 200ms slide-out, then hides it.
        open
          ? 'translate-x-0 visible [transition-duration:200ms,0s]'
          : '-translate-x-full invisible [transition-duration:200ms,200ms]',
      )}
    >
      <div className="px-4 py-4 border-b border-white/[0.05] flex items-start justify-between gap-2">
        <AverrowLogo />
        <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={cycleTheme}
          aria-label={themeLabelFor(theme)}
          title={themeLabelFor(theme)}
          className="p-1.5 rounded text-white/55 hover:text-white/95 hover:bg-white/[0.06] transition-colors"
        >
          <ThemeIcon size={14} />
        </button>
        <button
          type="button"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close navigation"
          className="md:hidden inline-flex h-11 w-11 -mr-2 items-center justify-center rounded-lg text-white/85 hover:bg-white/[0.06] transition-colors"
        >
          <X size={20} />
        </button>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto overscroll-contain py-3 px-2 space-y-4">
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
          {isLoading && <div className="px-3 py-2 text-[12px] text-white/55 font-mono">Loading…</div>}
          {!isLoading && active.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-white/55 font-mono">No modules entitled yet.</div>
          )}
          {active.map((m) => {
            const Icon = MODULE_ICONS[m.module_key];
            return (
              <NavLink
                key={m.module_key}
                to={MODULE_PATHS[m.module_key]}
                className={({ isActive }) => cn(NAV_BASE, isActive ? NAV_ACTIVE : NAV_INACTIVE)}
              >
                <Icon size={16} />
                <span className="min-w-0 flex-1 truncate">{MODULE_LABELS[m.module_key]}</span>
                {m.status === 'trial' && (
                  <span className="shrink-0 text-[11px] uppercase tracking-wider font-mono text-amber">trial</span>
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
                  className={cn(NAV_BASE, 'text-white/55 hover:text-white/75')}
                >
                  <Icon size={16} className="opacity-50" />
                  <span className="min-w-0 flex-1 truncate">{MODULE_LABELS[m.module_key]}</span>
                  <span className="shrink-0 text-[11px] uppercase tracking-wider font-mono text-white/55">upgrade</span>
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
        className="px-3 py-2.5 border-t border-white/10 font-mono text-[11px] tracking-[0.08em] text-white/55"
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
      <div className="px-3 mb-1 text-[11px] uppercase tracking-[0.12em] font-mono text-white/55">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
