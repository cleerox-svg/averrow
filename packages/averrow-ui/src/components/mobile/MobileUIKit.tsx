// packages/averrow-ui/src/components/mobile/MobileUIKit.tsx
//
// Phase 0.5 of the unified-Home rebuild: every primitive originally
// defined in this file has been promoted to the shared design system.
// This file is now a thin compatibility shim that re-exports them
// under the original names so MobileCommandCenter (and any other
// historical consumer) keep working without source changes.
//
// New code should import directly from the design system:
//
//   import { DimensionalCard, StatTile, BrandAvatar, SeverityPill,
//            GradeBadge } from '@/design-system/components';
//   import { useCountUp } from '@/design-system/hooks';
//   import { M, SEV } from '@/design-system/tokens';

import { useCountUp as _useCountUp } from '@/design-system/hooks/useCountUp';

// ── Promoted primitives (re-exports) ──────────────────────────────────────
export { DimensionalCard as DeepCard } from '@/components/ui/DimensionalCard';
export type { DimensionalCardProps as DeepCardProps } from '@/components/ui/DimensionalCard';

export { StatTile } from '@/components/ui/StatTile';
export type { StatTileProps } from '@/components/ui/StatTile';

export { BrandAvatar } from '@/components/ui/BrandAvatar';
export type { BrandAvatarProps } from '@/components/ui/BrandAvatar';

export { SeverityPill as SevChip } from '@/components/ui/SeverityPill';
export type { SeverityPillProps as SevChipProps } from '@/components/ui/SeverityPill';

export { GradeBadge } from '@/components/ui/GradeBadge';
export type { GradeBadgeProps } from '@/components/ui/GradeBadge';

// ── Tokens (re-exports) ───────────────────────────────────────────────────
export { M, SEV } from '@/design-system/tokens';

// Back-compat: MobileUIKit's useCountUp historically returned the
// already-formatted string. The canonical hook returns a number, so
// wrap it here for any caller still relying on the old signature.
export function useCountUp(target: number, duration = 1100): string {
  return _useCountUp(target, duration).toLocaleString();
}
