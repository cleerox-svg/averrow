// Averrow Design System — Component Barrel
// Future-facing import path: @/design-system/components
//
// Usage:
//   import { Card, Button, Badge, Avatar, StatCard, ... } from '@/design-system/components'
//
// Single barrel for ops (Phase 1 PR6a folded `components/ui/index.ts` into it).
// Badge, Tabs, FilterBar, Sparkline and Avatar come from the shared kit
// (`@averrow/shared/ui`); PageHeader is the thin ops adapter in ./PageHeader.
// The remaining primitives still live in components/ui/ and move to the kit in
// PR6b (EmptyState, StatCard) and PR6c (Card, tables).

// ── Foundation ─────────────────────────────────────────────────────────────
export { Card, CardHeader, CardBody } from '../../components/ui/Card';
export type { CardProps, CardVariant } from '../../components/ui/Card';

export { Button } from '../../components/ui/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from '../../components/ui/Button';

// ── Shared kit (@averrow/shared/ui) ────────────────────────────────────────
export { Badge, Tabs, FilterBar, Sparkline, Avatar } from '@averrow/shared/ui';
export type {
  BadgeProps,
  Severity,
  BadgeStatus,
  BadgeSize,
  ContextTag,
  VerdictTag,
  Classification,
  LegacyVariant,
  Tab,
  TabsProps,
  FilterBarProps,
  FilterOption,
  SparklineProps,
  AvatarProps,
  AvatarSeverity,
  AvatarTone,
} from '@averrow/shared/ui';

export { StatCard, SimpleStatCard, DetailStatCard } from '../../components/ui/StatCard';
export type { StatCardProps } from '../../components/ui/StatCard';

export { StatTile } from '../../components/ui/StatTile';
export type { StatTileProps } from '../../components/ui/StatTile';

export { GradeBadge } from '../../components/ui/GradeBadge';
export type { GradeBadgeProps, Grade } from '../../components/ui/GradeBadge';

export { SignalBreakdownCard, PAGE_SIGNAL_WEIGHTS, SHADOW_SIGNAL_WEIGHTS } from '../../components/ui/SignalBreakdownCard';
export type { SignalBreakdownCardProps } from '../../components/ui/SignalBreakdownCard';

export { SaasTechniqueBadge } from '../../components/ui/SaasTechniqueBadge';
export type { SaasTechniqueBadgeProps } from '../../components/ui/SaasTechniqueBadge';

// ── Entity cards (unified across Brands / Providers / Campaigns / Threat Actors)
export { EntityCard } from '../../components/ui/EntityCard';
export type { EntityCardProps } from '../../components/ui/EntityCard';

export { MetricTile } from '../../components/ui/MetricTile';
export type { MetricTileProps } from '../../components/ui/MetricTile';

export { EntityListShell } from '../../components/ui/EntityListShell';
export type { EntityListShellProps, EntityListSort } from '../../components/ui/EntityListShell';

// ── Data display ───────────────────────────────────────────────────────────
export { DataRow, SeverityDot } from '../../components/ui/DataRow';
export type { DataRowProps, SeverityDotProps } from '../../components/ui/DataRow';

export { PriorityBar } from '../../components/ui/PriorityBar';
export type { PriorityBarProps, PriorityBarColor } from '../../components/ui/PriorityBar';

export { StateMachineButtons } from '../../components/ui/StateMachineButtons';
export type {
  StateMachineButtonsProps,
  StateMachineState,
} from '../../components/ui/StateMachineButtons';

export { GlowNumber } from '../../components/ui/GlowNumber';
export type { GlowNumberProps, GlowSize, GlowFormat } from '../../components/ui/GlowNumber';

export { LiveIndicator } from '../../components/ui/LiveIndicator';
export type { LiveIndicatorProps } from '../../components/ui/LiveIndicator';

export { SectionLabel } from '../../components/ui/SectionLabel';
export type { SectionLabelProps } from '../../components/ui/SectionLabel';

// ── Navigation & layout ────────────────────────────────────────────────────
export { PageHeader } from './PageHeader';
export type { PageHeaderProps } from './PageHeader';

export { StatGrid } from '../../components/ui/StatGrid';
export type { StatGridProps } from '../../components/ui/StatGrid';

export { ReportPanel } from '../../components/ui/ReportPanel';
export type { ReportPanelProps } from '../../components/ui/ReportPanel';

export { ThreatAreaChart } from '../../components/ui/ThreatAreaChart';
export type { ThreatAreaChartProps, ThreatDataPoint } from '../../components/ui/ThreatAreaChart';

// ── Form elements ──────────────────────────────────────────────────────────
export { Input } from '../../components/ui/Input';

export { Select } from '../../components/ui/Select';

// ── Feedback ───────────────────────────────────────────────────────────────
export { EmptyState } from '../../components/ui/EmptyState';
export type { EmptyVariant } from '../../components/ui/EmptyState';

export { Skeleton } from '../../components/ui/Skeleton';
