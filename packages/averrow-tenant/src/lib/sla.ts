// SLA / aging for the analyst queues. Severity-keyed targets, tuned for
// brand-protection (longer than SOC alert SLAs — these age over days, not
// minutes). An item past its target is "aging"; past 2× is "overdue".
// (TENANT_ANALYST_UX_RESEARCH_2026-06 #11.)

export const SLA_TARGET_HOURS: Record<string, number> = {
  critical: 4,
  high:     24,
  medium:   72,
  low:      168,
};

export type AgeLevel = 'ok' | 'aging' | 'overdue';

export interface AgeInfo {
  label: string;   // compact: "45m" / "6h" / "3d"
  level: AgeLevel;
  hours: number;
}

function parseTs(ts: string): number {
  // DB timestamps are 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO.
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return d.getTime();
}

function humanizeAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function ageInfo(createdAt: string, severity: string): AgeInfo {
  const created = parseTs(createdAt);
  const hours = Number.isNaN(created) ? 0 : Math.max(0, (Date.now() - created) / 3_600_000);
  const target = SLA_TARGET_HOURS[(severity ?? '').toLowerCase()] ?? SLA_TARGET_HOURS.medium;
  const level: AgeLevel = hours > target * 2 ? 'overdue' : hours > target ? 'aging' : 'ok';
  return { label: humanizeAge(hours), level, hours };
}
