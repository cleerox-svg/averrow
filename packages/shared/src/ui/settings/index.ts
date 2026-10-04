// @averrow/shared/ui/settings — settings-layout primitives for the account
// experience (docs/ACCOUNT_DESIGN_SPEC.md). Router-agnostic, token-only.
// The orchestrator re-exports this barrel from ui/index.ts.

export { IconTile, ICON_TILE_TONES, type IconTileProps, type IconTileTone } from './IconTile';
export { SettingsGroup, type SettingsGroupProps } from './SettingsGroup';
export { SettingsRow, type SettingsRowProps, type SettingsRowControlContext } from './SettingsRow';
export { DangerZone, type DangerZoneProps, type DangerZoneAction } from './DangerZone';
export { InlineBanner, type InlineBannerProps, type InlineBannerTone } from './InlineBanner';
export { CopyField, copyText, type CopyFieldProps } from './CopyField';
export { AccountHero, describeAccountScope, type AccountHeroProps } from './AccountHero';
export { SettingsShell, type SettingsShellProps, type SettingsSection } from './SettingsShell';
export { type SettingsLinkRenderProps, type SettingsRenderLink, defaultRenderLink } from './types';
export { useMediaQuery } from './useMediaQuery';
