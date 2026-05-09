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

export { useTheme, bootstrapTheme } from './useTheme';
export type { Theme } from './useTheme';
