// BuyingSignalsCard — public evidence the brand cares about the problem
// Averrow solves. Three sources, all free:
//
//   - last_breach_disclosed_at: most recent breach disclosure
//     (news_watcher → brand_firmographics in a follow-up wire-up).
//
//   - cyber_10k_mentions: count of cybersecurity / ransomware / phishing
//     mentions in the brand's latest 10-K Item 1C. SEC has required this
//     disclosure since 2023 (rule 33-11216) so the data is on the
//     public record for every US public company.
//
//   - security_news_headline + url: most recent security-relevant news
//     (CISO hires, SOC expansion, breach announcements). Populated by
//     Pathfinder's Haiku research with web_search enabled.
//
//   - security_maturity: 'high' | 'medium' | 'low' classification from
//     the same AI research pass. Useful as a quick filter.
//
//   - target_linkedin: the CISO's profile URL when discovered.
//
// Hides individual rows when their field is null. Whole card collapses
// to a single hint when nothing's known yet.

import { Card, SectionLabel, Badge } from '@/design-system/components';
import { ExternalLink, AlertTriangle } from 'lucide-react';
import { relativeTime } from '@/lib/time';
import type { SalesLead } from '@/hooks/useLeads';

export interface BuyingSignalsCardProps {
  lead: SalesLead;
}

function breachSeverity(disclosedAt: string | null): { label: string; variant: 'critical' | 'high' | 'medium' } | null {
  if (!disclosedAt) return null;
  const ms = Date.parse(disclosedAt);
  if (!Number.isFinite(ms)) return null;
  const ageDays = (Date.now() - ms) / 86_400_000;
  if (ageDays <= 30) return { label: 'Within 30 days', variant: 'critical' };
  if (ageDays <= 90) return { label: 'Within 90 days', variant: 'high' };
  if (ageDays <= 180) return { label: 'Within 180 days', variant: 'medium' };
  return null;
}

function maturityVariant(m: string | null | undefined): 'critical' | 'high' | 'medium' | 'success' | 'default' {
  if (!m) return 'default';
  const v = m.toLowerCase();
  if (v === 'low')    return 'critical';
  if (v === 'medium') return 'medium';
  if (v === 'high')   return 'success';
  return 'default';
}

export function BuyingSignalsCard({ lead }: BuyingSignalsCardProps) {
  const breach = breachSeverity(lead.last_breach_disclosed_at);
  const has10k = lead.cyber_10k_mentions != null && lead.cyber_10k_mentions > 0;
  const hasNews = !!lead.security_news_headline;
  const hasMaturity = !!lead.security_maturity;
  const hasCISO = !!lead.target_linkedin;

  const hasAny = breach || has10k || hasNews || hasMaturity || hasCISO;

  return (
    <Card hover={false} variant={breach && breach.variant === 'critical' ? 'critical' : 'base'}>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Buying Signals</SectionLabel>
        {breach && (
          <Badge variant="critical" pulse>
            <AlertTriangle className="w-3 h-3 mr-1 inline" />
            Recent Breach
          </Badge>
        )}
      </div>

      {!hasAny ? (
        <p className="text-sm text-white/40 italic">
          No public buying signals yet. SEC 10-K parsing + news_watcher → brand mapping are scheduled to populate this in
          subsequent sessions; today's data comes from Pathfinder's AI research only.
        </p>
      ) : (
        <div className="space-y-4">
          {breach && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[10px] uppercase" style={{ color: 'var(--text-tertiary)' }}>
                  Last Disclosed Breach
                </span>
                <Badge variant={breach.variant}>{breach.label}</Badge>
              </div>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                Disclosed {relativeTime(lead.last_breach_disclosed_at!)}.
                {' '}A breach disclosure within the last 6 months is the strongest single procurement signal.
              </p>
            </div>
          )}

          {hasNews && (
            <div>
              <div className="font-mono text-[10px] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
                Recent Security News
              </div>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                {lead.security_news_headline}
              </p>
              {lead.security_news_url && (
                <a
                  href={lead.security_news_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs mt-1 hover:underline"
                  style={{ color: 'var(--amber)' }}
                >
                  Source
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {has10k && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[10px] uppercase" style={{ color: 'var(--text-tertiary)' }}>
                  10-K Cybersecurity Mentions
                </span>
                <Badge variant={lead.cyber_10k_mentions! >= 10 ? 'high' : lead.cyber_10k_mentions! >= 5 ? 'medium' : 'low'}>
                  {lead.cyber_10k_mentions}
                </Badge>
              </div>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Mentions of "cybersecurity" / "ransomware" / "data breach" / "phishing" in latest 10-K Item 1C.
                High counts indicate the board treats cybersecurity as material risk.
              </p>
            </div>
          )}

          {hasMaturity && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase" style={{ color: 'var(--text-tertiary)' }}>
                Security Maturity (AI)
              </span>
              <Badge variant={maturityVariant(lead.security_maturity)} className="capitalize">
                {lead.security_maturity}
              </Badge>
            </div>
          )}

          {hasCISO && (
            <div>
              <div className="font-mono text-[10px] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
                Security Leader
              </div>
              <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {lead.target_name ?? '—'}
                {lead.target_title && (
                  <span className="font-mono text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>
                    {lead.target_title}
                  </span>
                )}
              </div>
              {lead.target_linkedin && (
                <a
                  href={lead.target_linkedin.startsWith('http') ? lead.target_linkedin : `https://${lead.target_linkedin}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs mt-1 hover:underline"
                  style={{ color: 'var(--amber)' }}
                >
                  LinkedIn profile
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
