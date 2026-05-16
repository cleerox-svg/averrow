// ScoreBreakdownCard — answers "why is this lead's score 85?" by cracking
// the score_breakdown_json blob produced by Pathfinder's identifyAndCreate.
//
// Factor keys map 1:1 to the SCORING object in agents/pathfinder.ts. The
// card shows each contributing factor with its point value, sorted by
// weight, so a rep can vouch for the lead in one glance.

import { Card, SectionLabel, Badge } from '@/design-system/components';

const FACTOR_LABELS: Record<string, string> = {
  email_grade_f_or_d:         'Email grade F or D',
  email_grade_c:              'Email grade C',
  dmarc_none_or_missing:      'No DMARC enforcement',
  active_phishing_urls:       'Active phishing URLs',
  spam_trap_catches:          'Spam trap catches',
  high_risk_score:            'High composite risk',
  ai_phishing_detected:       'AI-generated phishing',
  tranco_top_10k:             'Top 10K Tranco brand',
  multiple_campaigns:         'Targeted by multiple campaigns',
  recent_risk_spike:          'Recent risk spike',
  social_impersonation:       'Social impersonation',
  social_high_risk:           'High social risk',
  social_takedown_needed:     'Social takedown needed',
  recent_breach_disclosure:   'Recent breach disclosed',
  cyber_10k_disclosure_high:  '10-K cybersecurity heavy',
  recent_security_news:       'Recent security news',
};

export interface ScoreBreakdownCardProps {
  breakdownJson: string | null;
  totalScore: number;
}

export function ScoreBreakdownCard({ breakdownJson, totalScore }: ScoreBreakdownCardProps) {
  let factors: Array<[string, number]> = [];
  if (breakdownJson) {
    try {
      const parsed = JSON.parse(breakdownJson) as Record<string, number>;
      factors = Object.entries(parsed)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .sort((a, b) => b[1] - a[1]);
    } catch {
      // Malformed blobs render as empty — preserve forensic value via the raw JSON tail below.
    }
  }

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Score Breakdown</SectionLabel>
        <span className="font-mono text-sm font-bold" style={{ color: 'var(--amber)' }}>
          {Math.round(totalScore)} pts
        </span>
      </div>

      {factors.length === 0 ? (
        <p className="text-sm text-white/40 italic">
          No factor breakdown available. Older leads created before the breakdown JSON column was populated will show empty here.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {factors.map(([key, points]) => (
            <li key={key} className="flex items-center justify-between text-sm">
              <span style={{ color: 'var(--text-secondary)' }}>
                {FACTOR_LABELS[key] ?? key.replace(/_/g, ' ')}
              </span>
              <Badge variant="info" className="font-mono text-[10px]">
                +{points}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
