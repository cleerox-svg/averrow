// Averrow Design System — SeverityChip (alias for Badge)
// Import Badge directly for new code.

import React from 'react';
import { Badge } from './Badge';
import type { Severity, BadgeSize } from './Badge';

export type { Severity };
export type ChipSize = BadgeSize;

export interface SeverityChipProps {
  severity: Severity;
  size?:    BadgeSize;
  pulse?:   boolean;
}

export function SeverityChip({ severity, size = 'sm', pulse = false }: SeverityChipProps) {
  return <Badge severity={severity} size={size} pulse={pulse} />;
}
