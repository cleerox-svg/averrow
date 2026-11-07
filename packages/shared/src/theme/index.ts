// @averrow/shared/theme — unified theme primitives.
//
// Both averrow-ops and averrow-tenant render against the same
// design tokens (CSS custom properties on :root + light overrides
// under [data-theme="light"]). Hosts import the CSS once at app
// boot and the React useTheme hook for in-app toggles.
//
// Usage:
//   // main.tsx
//   import '@averrow/shared/theme.css';
//   import { bootstrapTheme } from '@averrow/shared/theme';
//   bootstrapTheme();
//
//   // Component
//   import { useTheme } from '@averrow/shared/theme';
//   const { theme, toggle, setTheme, isDark } = useTheme();

export { useTheme, bootstrapTheme, applyThemePreference } from './useTheme';
export type { Theme } from './useTheme';
export {
  useAppearance,
  bootstrapAppearance,
  readStoredAccent,
  readStoredBase,
  isAccent,
  isBase,
  ACCENTS,
  BASES,
  DEFAULT_ACCENT,
  DEFAULT_BASE,
  ACCENT_STORAGE_KEY,
  BASE_STORAGE_KEY,
  APPEARANCE_PICKER_ENABLED,
  applyAccent,
  applyBase,
  hydrateAppearanceFromAccount,
  pickAccent,
  pickBase,
} from './useAppearance';
export type { Accent, Base, UseAppearanceReturn, AccountAppearance, AppearanceSaver } from './useAppearance';
export { resetAccountSyncSession } from './accountSync';
// Runtime token reader for canvas / WebGL colours (P3-2a).
export {
  readToken,
  readTokenRgba,
  parseColor,
  subscribeAppearance,
  getAppearanceVersion,
  useAppearanceVersion,
  useTokenColors,
} from './tokenReader';
export type { Rgba, TokenColors } from './tokenReader';
