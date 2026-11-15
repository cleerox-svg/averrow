// AccountMenu: the avatar button + account menu (ACCOUNT_DESIGN_SPEC §4.12,
// §5.5), props-driven so Averrow, the tenant app and FarmTrack render the same
// menu from their own data. Popover on desktop, the same items in a bottom
// Sheet on compact screens (ResponsiveMenu). Initials only: there is no
// picture prop, by design.
//
// Order: identity header · link items · Appearance (Auto | Dark | Light) ·
// `afterAppearance` slot (e.g. FarmTrack's "Look" group) · Switch account
// (optional) · Sign out · version line.
//
// The kit has no router and no icon library: navigation is `onSelect`
// callbacks, glyphs are ReactNode props (kit defaults for theme / sign out /
// switch account / passkey).

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../cn';
import { Avatar } from '../Avatar';
import { Badge, type BadgeProps } from '../Badge';
import {
  MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, ResponsiveMenu, type MenuItemProps,
} from '../overlays/Menu';
import {
  ShellLogOutIcon, ShellMonitorIcon, ShellMoonIcon, ShellShieldAlertIcon, ShellShieldCheckIcon,
  ShellSunIcon, ShellUserPlusIcon,
} from './icons';

export type AccountMenuTheme = 'auto' | 'dark' | 'light';

const THEME_VALUES: readonly AccountMenuTheme[] = ['auto', 'dark', 'light'];
function isTheme(v: string): v is AccountMenuTheme {
  return (THEME_VALUES as readonly string[]).includes(v);
}

export interface AccountMenuRole {
  label: string;
  /** Badge tone props, e.g. from `roleBadgeProps(role).tone` or an app's own map. */
  tone: Pick<BadgeProps, 'severity' | 'status'>;
}

export interface AccountMenuLink {
  /** Stable key (e.g. the route). */
  key: string;
  label: string;
  icon: ReactNode;
  tone?: MenuItemProps['tone'];
  onSelect: () => void;
  /** Trailing count badge; shown only when > 0, capped at "99+". */
  count?: number;
  /** Red (critical) count badge instead of amber (warning). */
  countCritical?: boolean;
  'data-testid'?: string;
}

export interface AccountMenuAction {
  label: string;
  onSelect: () => void;
  /** Secondary line under the label. */
  description?: ReactNode;
  icon?: ReactNode;
  'data-testid'?: string;
}

export interface AccountMenuProps {
  /** Display name (also names the trigger for assistive tech). */
  name: string;
  /** Pre-computed initials (`parseInitials` from `@averrow/shared/avatar`). */
  initials: string;
  email?: string | null;
  /** Role badge beside the passkey indicator. Omit to hide. */
  role?: AccountMenuRole;
  /** `true` = passkey on, `false` = none registered, `undefined` = hide the indicator. */
  hasPasskey?: boolean;
  links: readonly AccountMenuLink[];
  themeValue: AccountMenuTheme;
  onThemeChange: (theme: AccountMenuTheme) => void;
  /** Override the Auto / Dark / Light glyphs. */
  themeIcons?: Partial<Record<AccountMenuTheme, ReactNode>>;
  /** Rendered after the Appearance group, before Switch account / Sign out. Compose `MenuLabel` + `MenuRadioGroup` here. */
  afterAppearance?: ReactNode;
  /** Omit to not render "Switch account". */
  switchAccount?: AccountMenuAction;
  signOut: AccountMenuAction;
  /** Footer text, e.g. "v4.8.0 · 1a2b3c4". Omit to hide. */
  versionLabel?: string;
  /** Accessible name of the menu / sheet. Default "Account menu". */
  title?: string;
  /** Trigger accessible name. Default `Account menu for ${name}`. */
  triggerLabel?: string;
  /** Extra classes on the trigger button (merged; later wins). */
  triggerClassName?: string;
  triggerTestId?: string;
  versionTestId?: string;
  passkeyTestId?: string;
  /** Test id of the menu body (wraps the content in both shells). */
  'data-testid'?: string;
  onOpenChange?: (open: boolean) => void;
}

const AvatarTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { initials: string; name: string; label: string }
>(function AvatarTrigger({ initials, name, label, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      className={cn(
        'inline-flex h-11 w-11 items-center justify-center rounded-full bg-transparent p-0 outline-none ' +
          'focus-visible:ring-2 focus-visible:ring-[var(--primary-focus)] touch-target',
        className,
      )}
      {...rest}
    >
      <Avatar name={name} initials={initials} tone="self" size={36} radius={18} />
    </button>
  );
});

const THEME_LABELS: Record<AccountMenuTheme, string> = { auto: 'Auto', dark: 'Dark', light: 'Light' };

export function AccountMenu({
  name, initials, email, role, hasPasskey, links, themeValue, onThemeChange, themeIcons,
  afterAppearance, switchAccount, signOut, versionLabel, title = 'Account menu', triggerLabel,
  triggerClassName, triggerTestId, versionTestId, passkeyTestId, 'data-testid': testId, onOpenChange,
}: AccountMenuProps) {
  const icons: Record<AccountMenuTheme, ReactNode> = {
    auto: themeIcons?.auto ?? <ShellMonitorIcon />,
    dark: themeIcons?.dark ?? <ShellMoonIcon />,
    light: themeIcons?.light ?? <ShellSunIcon />,
  };

  const body = (
    <>
      <div className="flex items-start gap-3 px-3 pb-3 pt-2.5">
        <Avatar name={name} initials={initials} tone="self" shape="squircle" size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold leading-tight text-[var(--text-primary)]" title={name}>{name}</p>
          {email ? (
            <p className="truncate text-[13px] text-[var(--text-secondary)]" title={email}>{email}</p>
          ) : null}
          {role || hasPasskey !== undefined ? (
            <div className="mt-1.5 flex items-center gap-2">
              {role ? <Badge {...role.tone} size="md" font="sans">{role.label}</Badge> : null}
              {hasPasskey === true ? (
                <span
                  role="img"
                  title="Passkey on"
                  aria-label="Passkey on"
                  data-testid={passkeyTestId}
                  className="inline-flex h-5 w-5 items-center justify-center text-[var(--green-text)]"
                >
                  <ShellShieldCheckIcon aria-hidden="true" className="h-[18px] w-[18px]" />
                </span>
              ) : null}
              {hasPasskey === false ? (
                <span
                  role="img"
                  title="No passkey"
                  aria-label="No passkey"
                  data-testid={passkeyTestId}
                  className="inline-flex h-5 w-5 items-center justify-center text-[var(--primary-text)]"
                >
                  <ShellShieldAlertIcon aria-hidden="true" className="h-[18px] w-[18px]" />
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <MenuSeparator />

      {links.map((link) => {
        const count = link.count ?? 0;
        return (
          <MenuItem
            key={link.key}
            icon={link.icon}
            tone={link.tone}
            data-testid={link['data-testid']}
            trailing={count > 0
              ? (
                <Badge
                  {...(link.countCritical ? { severity: 'critical' as const } : { status: 'warning' as const })}
                  size="md"
                  label={count > 99 ? '99+' : String(count)}
                />
              )
              : undefined}
            onSelect={link.onSelect}
          >
            {link.label}
          </MenuItem>
        );
      })}

      <MenuSeparator />

      {/* One compact Auto | Dark | Light control. Segments are real menu radio
          items, so arrow keys reach them in the popover and the sheet. keepOpen:
          a theme change is visible instantly behind the menu and people compare
          Dark/Light; Esc / outside tap closes. */}
      <MenuLabel>Appearance</MenuLabel>
      <MenuRadioGroup
        aria-label="Appearance"
        layout="segmented"
        value={themeValue}
        onValueChange={(v) => { if (isTheme(v)) onThemeChange(v); }}
      >
        {THEME_VALUES.map((value) => (
          <MenuRadioItem key={value} value={value} icon={icons[value]} keepOpen data-testid={`account-menu-theme-${value}`}>
            {THEME_LABELS[value]}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>

      {afterAppearance}

      <MenuSeparator />

      {switchAccount ? (
        <MenuItem
          icon={switchAccount.icon ?? <ShellUserPlusIcon />}
          description={switchAccount.description}
          onSelect={switchAccount.onSelect}
          data-testid={switchAccount['data-testid']}
        >
          {switchAccount.label}
        </MenuItem>
      ) : null}
      <MenuItem
        tone="danger"
        icon={signOut.icon ?? <ShellLogOutIcon />}
        onSelect={signOut.onSelect}
        data-testid={signOut['data-testid']}
      >
        {signOut.label}
      </MenuItem>

      {versionLabel ? (
        <p
          data-testid={versionTestId}
          className="px-3 pb-1.5 pt-2 text-center font-mono text-[12px] text-[var(--text-tertiary)]"
        >
          {versionLabel}
        </p>
      ) : null}
    </>
  );

  return (
    <ResponsiveMenu
      title={title}
      onOpenChange={onOpenChange}
      trigger={
        <AvatarTrigger
          initials={initials}
          name={name}
          label={triggerLabel ?? `Account menu for ${name}`}
          className={triggerClassName}
          data-testid={triggerTestId}
        />
      }
    >
      {testId ? <div data-testid={testId}>{body}</div> : body}
    </ResponsiveMenu>
  );
}
