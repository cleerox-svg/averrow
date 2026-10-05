// @averrow/shared/ui — the v4 design system.
//
// Token-native shadcn/Radix primitives shared by averrow-ops + averrow-tenant.
// Radix powers behavior/a11y; cva drives variants; styling uses Tailwind
// arbitrary-value classes referencing the brand CSS vars in
// @averrow/shared/theme so the same component renders identically in both
// apps with no per-app Tailwind config changes. All primitives are fluid /
// responsive by construction.
//
// Growth path (added wave by wave): Dialog, Sheet, Popover, Tooltip, Select,
// Command (⌘K), Toast.
//
// Kit (Phase 1 PR5): Badge, StatTile, PageState, Sparkline, Avatar, Table,
// Tabs, FilterBar, PageHeader. Named exports only; no `@/` or router imports.

export { cn } from './cn';
export { Button, buttonVariants, type ButtonProps } from './Button';
export {
  Card, CardHeader, CardTitle, CardContent, CardFooter, resolveCardPadding,
  type CardProps, type CardVariant, type CardPaddingToken,
} from './Card';
export {
  Badge,
  type BadgeProps, type BadgeSize, type BadgeStatus, type Severity,
  type ContextTag, type VerdictTag, type Classification, type LegacyVariant,
} from './Badge';
export { StatTile, type StatTileProps, type StatTone } from './StatTile';
export {
  PageState, pageStateKind,
  type PageStateProps, type PageStateKind, type PageStateLayout,
  type PageStateAction, type PageStateActionSpec,
} from './PageState';
export { Sparkline, type SparklineProps } from './Sparkline';
export { Avatar, type AvatarProps, type AvatarSeverity, type AvatarTone, type AvatarShape } from './Avatar';
export {
  Table, Th, Td, DataTable,
  type TableProps, type Column, type DataTableProps, type SortState, type SortDir,
  type RowSeverity, type TableDensity,
} from './Table';
export { Tabs, type Tab, type TabsProps } from './Tabs';
export { FilterBar, type FilterBarProps, type FilterOption } from './FilterBar';
export {
  PageHeader, WorkspaceEmbedContext, WorkspaceEmbedProvider, useWorkspaceEmbed,
  type PageHeaderProps,
} from './PageHeader';

// Account-experience kit (docs/ACCOUNT_DESIGN_SPEC.md): form controls,
// overlays (sheet, dialog, menu, toast, time zone picker) and settings
// layout (shell, groups, rows, hero).
export { Spinner } from './Spinner';
export * from './forms';
export * from './overlays';
export * from './settings';
