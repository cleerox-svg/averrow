// Re-export the unified theme hook from @averrow/shared/theme.
// Per the unification arc, the theme hook lives in the shared
// package; this thin file preserves the @/design-system/hooks
// import path so existing call sites don't need to change.
export { useTheme, bootstrapTheme } from '@averrow/shared/theme';
export type { Theme } from '@averrow/shared/theme';
