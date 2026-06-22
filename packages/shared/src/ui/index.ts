// @averrow/shared/ui — the v4 design system.
//
// Token-native shadcn/Radix primitives shared by averrow-ops + averrow-tenant.
// Radix powers behavior/a11y; cva drives variants; styling uses Tailwind
// arbitrary-value classes referencing the brand CSS vars in
// @averrow/shared/theme so the same component renders identically in both
// apps with no per-app Tailwind config changes. All primitives are fluid /
// responsive by construction.
//
// Growth path (added wave by wave): Dialog, Sheet, Popover, Tooltip, Tabs,
// Select, Command (⌘K), DataTable (TanStack), Toast.

export { cn } from './cn';
export { Button, buttonVariants, type ButtonProps } from './Button';
export {
  Card, CardHeader, CardTitle, CardContent, CardFooter,
} from './Card';
export { Badge, badgeVariants, type BadgeProps } from './Badge';
