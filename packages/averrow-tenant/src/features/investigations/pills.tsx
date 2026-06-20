// Shared status + severity chips for the Investigations surface.

import type { InvestigationStatus } from '@/lib/investigations';

const STATUS_TONE: Record<InvestigationStatus, string> = {
  open:       'text-amber      bg-amber/[0.10]       border-amber/[0.20]',
  monitoring: 'text-blue       bg-blue/[0.08]        border-blue/[0.18]',
  closed:     'text-green/85   bg-green/[0.06]       border-green/[0.15]',
};

export function StatusPill({ status }: { status: InvestigationStatus }) {
  const tone = STATUS_TONE[status] ?? 'text-white/55 bg-white/[0.04] border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {status}
    </span>
  );
}

const SEV_COLOR: Record<string, string> = {
  critical: 'bg-sev-critical', high: 'bg-amber', medium: 'bg-amber/50', low: 'bg-white/30',
};

export function SeverityDot({ severity }: { severity: string | null }) {
  const c = SEV_COLOR[(severity ?? '').toLowerCase()] ?? 'bg-white/30';
  return <span title={severity ?? undefined} className={`inline-block w-2 h-2 rounded-full ${c} flex-shrink-0`} />;
}
