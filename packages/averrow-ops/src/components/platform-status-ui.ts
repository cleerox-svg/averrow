// One source for how a platform status category looks, shared by the Overview's
// PlatformStatusBadge, PlatformStatusFlyout and PlatformPulse so "Degraded" is
// the same severity (--sev-medium; amber is a status colour) everywhere.

import type { CategoryStatus } from '@averrow/shared';
import { STATUS_LABELS } from '@averrow/shared';
import type { BadgeStatus } from '@/design-system/components';

export interface StatusBadgeSpec {
  /** Badge tone props: a status, or a severity where no status tone fits. */
  tone: { status: BadgeStatus; severity?: undefined } | { severity: 'medium'; status?: undefined };
  /** Short pill label for a category row/cell. */
  label: string;
  /** Dot and text colour tokens for the plain (non-Badge) status label. */
  dot: string;
  text: string;
}

export const STATUS_BADGE: Record<CategoryStatus, StatusBadgeSpec> = {
  operational: { tone: { status: 'healthy' }, label: 'Operational', dot: 'var(--green)', text: 'var(--green-text, var(--sev-info-text))' },
  degraded: { tone: { severity: 'medium' }, label: STATUS_LABELS.degraded, dot: 'var(--sev-medium)', text: 'var(--sev-medium-text)' },
  outage: { tone: { status: 'failed' }, label: STATUS_LABELS.outage, dot: 'var(--sev-critical)', text: 'var(--sev-critical-text)' },
};

/** Overall banner wording ("All systems operational", "Degraded", "Outage"). */
export const OVERALL_LABEL = STATUS_LABELS;
