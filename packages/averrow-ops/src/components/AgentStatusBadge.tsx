// Shared agent status badge — consistent rendering across Monitor, Config, History.
// Uses the design-system Badge with standardized status → variant mapping.

import { Badge } from '@/design-system/components';
import type { BadgeStatus } from '@/design-system/components';

const STATUS_MAP: Record<string, { badgeStatus: BadgeStatus; pulse: boolean }> = {
  active:   { badgeStatus: 'active',   pulse: true  },
  degraded: { badgeStatus: 'degraded', pulse: true  },
  error:    { badgeStatus: 'failed',   pulse: false },
  idle:     { badgeStatus: 'inactive', pulse: false },
};

export function AgentStatusBadge({ status }: { status: string }) {
  const mapped = STATUS_MAP[status] ?? { badgeStatus: 'inactive' as BadgeStatus, pulse: false };
  return (
    <Badge
      status={mapped.badgeStatus}
      label={status}
      size="xs"
      pulse={mapped.pulse}
    />
  );
}
