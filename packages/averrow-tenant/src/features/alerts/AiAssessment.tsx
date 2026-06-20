// AI reasoning trail — "show your work" for a signal
// (TENANT_ANALYST_UX_RESEARCH_2026-06 §5.3 / §5.2). Surfaces the AI judge's
// verdict + confidence + reasoning, and explains *why* the signal wasn't
// auto-resolved, so an analyst can trust or override the automation.

import { Sparkles, Info } from 'lucide-react';
import {
  parseAiAssessment, AUTO_RESOLVE_CONFIDENCE_FLOOR, type AiVerdict,
} from '@/lib/alerts';

const VERDICT_META: Record<string, { label: string; tone: string }> = {
  active_threat: { label: 'Active threat', tone: 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' },
  needs_human:   { label: 'Needs human',   tone: 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        },
  likely_safe:   { label: 'Likely safe',   tone: 'text-green/85     bg-green/[0.06]        border-green/[0.15]'        },
};

function verdictMeta(v: AiVerdict) {
  return VERDICT_META[v] ?? { label: String(v).replace(/_/g, ' '), tone: 'text-white/60 bg-white/[0.04] border-white/[0.08]' };
}

// One line explaining why the automation didn't act on its own.
function whyNotAuto(verdict: AiVerdict, confidence: number): string | null {
  if (verdict === 'likely_safe' && confidence < AUTO_RESOLVE_CONFIDENCE_FLOOR) {
    return `Below the ${AUTO_RESOLVE_CONFIDENCE_FLOOR}% auto-resolve threshold, so it was left for your review.`;
  }
  if (verdict === 'needs_human') return 'The AI couldn’t decide on its own and flagged it for you.';
  if (verdict === 'active_threat') return 'Assessed as a likely active threat — confirm and act.';
  return null;
}

/** Compact verdict + confidence chip for dense rows (e.g. the Console). */
export function VerdictChip({ raw }: { raw: string | null }) {
  const a = parseAiAssessment(raw);
  if (!a) return null;
  const m = verdictMeta(a.verdict);
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${m.tone}`}>
      <Sparkles size={9} />{m.label} {a.confidence}%
    </span>
  );
}

/** Full reasoning panel for the signal card. */
export function AiAssessmentPanel({ raw }: { raw: string | null }) {
  const a = parseAiAssessment(raw);
  if (!a) return null;
  const m = verdictMeta(a.verdict);
  const why = whyNotAuto(a.verdict, a.confidence);
  return (
    <div className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[9px] uppercase tracking-[0.18em] font-mono text-white/45 flex items-center gap-1">
          <Sparkles size={10} /> AI assessment
        </span>
        <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${m.tone}`}>
          {m.label}
        </span>
        <span className="text-[10px] font-mono text-white/45">{a.confidence}% confidence</span>
      </div>
      {a.reasoning && <p className="text-[12px] text-white/70 leading-relaxed">{a.reasoning}</p>}
      {why && (
        <p className="text-[11px] text-white/45 mt-1.5 flex items-start gap-1.5">
          <Info size={11} className="mt-[2px] flex-shrink-0" />
          <span>{why}</span>
        </p>
      )}
    </div>
  );
}
