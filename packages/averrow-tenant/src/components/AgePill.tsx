// Aging / SLA pill — shows how long an open item has been waiting, colored
// by its severity-keyed SLA target (ok / aging / overdue).

import { Clock } from 'lucide-react';
import { ageInfo } from '@/lib/sla';

const TONE: Record<string, string> = {
  overdue: 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]',
  aging:   'text-amber        bg-amber/[0.08]        border-amber/[0.18]',
  ok:      'text-white/45     bg-white/[0.03]        border-white/[0.07]',
};

const TITLE: Record<string, string> = {
  overdue: 'Past SLA target',
  aging:   'Approaching SLA target',
  ok:      'Within SLA target',
};

export function AgePill({ createdAt, severity }: { createdAt: string; severity: string }) {
  if (!createdAt) return null;
  const { label, level } = ageInfo(createdAt, severity);
  return (
    <span
      title={TITLE[level]}
      className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider border rounded px-1.5 py-0.5 ${TONE[level]}`}
    >
      <Clock size={9} />{label}
    </span>
  );
}
