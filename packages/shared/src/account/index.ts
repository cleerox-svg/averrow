// @averrow/shared/account — the account experience (ACCOUNT_DESIGN_SPEC).
// Pages take data + callbacks only (no router, no api module) so ops, tenant
// and FarmTrack can mount the same screens with their own adapters.
//

export {
  ACCOUNT_SECTION_DEFS, ACCOUNT_SECTION_IDS, ACCOUNT_SETTINGS_BASE_PATH,
  getAccountSections, accountSectionIdFromPath,
  type AccountSectionId, type AccountSectionsOptions,
} from './sections';
export { SignOutRow, type SignOutRowProps } from './SignOutRow';
export {
  ProfileSettings, type ProfileSettingsProps, type ProfileSettingsUser,
} from './ProfileSettings';
export {
  DevicesSettings,
  type DevicesSettingsProps, type DevicesInstallState, type DevicesPushAdapter, type PushDeviceRow,
} from './DevicesSettings';
export {
  describeUserAgent, formatRelativeTime, formatShortDate, formatFullDate, parseTimestamp,
  type ParsedDevice,
} from './time-format';
export * from './security';
export * from './notifications';
