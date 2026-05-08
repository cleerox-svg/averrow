import { useMemo } from 'react';
import { useSpamTrapCaptures } from '@/hooks/useSpamTrap';
import type { SpamTrapCapture } from '@/hooks/useSpamTrap';
import { Skeleton } from '@/components/ui/Skeleton';

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#f87171',
  high: '#fb923c',
  medium: '#fbbf24',
  low: '#78A0C8',
  clean: '#4ade80',
};

interface ActorProfile {
  domain: string;
  captures: SpamTrapCapture[];
  totalUrls: number;
  maxSeverity: string;
}

function severityRank(s: string): number {
  const ranks: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, clean: 0 };
  return ranks[s.toLowerCase()] ?? 0;
}

function ProfileCard({ profile }: { profile: ActorProfile }) {
  const severity = (profile.maxSeverity ?? '—').toUpperCase();
  const severityColor = SEVERITY_COLORS[profile.maxSeverity.toLowerCase()] ?? '#78A0C8';

  const infraLabel = useMemo(() => {
    const domain = profile.domain;
    if (domain.includes('amazonses') || domain.includes('ses.')) return 'Amazon SES Infrastructure';
    if (domain.includes('google') || domain.includes('gmail')) return 'Google Mail Infrastructure';
    if (domain.includes('outlook') || domain.includes('microsoft')) return 'Microsoft Mail Infrastructure';
    if (domain.includes('sendgrid')) return 'SendGrid Infrastructure';
    if (domain.includes('mailgun')) return 'Mailgun Infrastructure';
    return `${domain} Infrastructure`;
  }, [profile.domain]);

  return (
    <div className="rounded-xl p-4 space-y-2" style={{ background:'rgba(15,23,42,0.50)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:'0.75rem', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)' }}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)]">Profile</span>
        <span className="text-white/40 text-[9px]">·</span>
        <span className="font-mono text-[9px] text-white/50">
          {profile.captures.length} signal{profile.captures.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="text-[13px] font-semibold text-white">{infraLabel}</div>

      <div className="space-y-1 text-[10px] font-mono text-white/40">
        <div>
          <span className="text-white/50">from_domain:</span>{' '}
          <span className="text-white/60">{profile.domain}</span>
        </div>
        <div>
          Captures: {profile.captures.length}
          <span className="text-white/40 mx-1.5">·</span>
          URLs: {profile.totalUrls}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-white/50">Risk:</span>
        <span
          className="text-[10px] font-mono font-semibold uppercase"
          style={{ color: severityColor }}
        >
          {severity}
        </span>
      </div>
    </div>
  );
}

export function ThreatActorPanel() {
  const { data: captures, isLoading, isError, refetch } = useSpamTrapCaptures({ limit: 50 });

  const profiles = useMemo(() => {
    if (!captures || captures.length === 0) return [];
    const groups: Record<string, SpamTrapCapture[]> = {};
    for (const c of captures) {
      const domain = c.from_domain ?? 'unknown';
      if (!groups[domain]) groups[domain] = [];
      groups[domain].push(c);
    }
    return Object.entries(groups)
      .map(([domain, caps]): ActorProfile => ({
        domain,
        captures: caps,
        totalUrls: caps.reduce((sum, c) => sum + (c.url_count ?? 0), 0),
        maxSeverity: caps.reduce(
          (max, c) => (severityRank(c.severity ?? 'low') > severityRank(max) ? (c.severity ?? 'low') : max),
          'low',
        ),
      }))
      .sort((a, b) => severityRank(b.maxSeverity) - severityRank(a.maxSeverity));
  }, [captures]);

  const totalCaptures = (captures ?? []).length;
  const clusterCount = profiles.length;

  if (isError) {
    return (
      <div className="rounded-xl p-4 min-h-[400px] flex flex-col items-center justify-center gap-3" style={{ background:'rgba(15,23,42,0.50)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:'0.75rem', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)' }}>
        <span className="text-white/40 text-sm font-mono">Unable to load captures</span>
        <button
          onClick={() => refetch()}
          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-mono text-white/60 transition-colors"
        >
          RETRY
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-4 min-h-[400px] space-y-4" style={{ background:'rgba(15,23,42,0.50)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:'0.75rem', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)' }}>
      <div className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)]">
        Threat Actor Profiling
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : profiles.length === 0 ? (
        <div className="flex items-center justify-center h-[200px]">
          <span className="text-white/30 text-sm font-mono">
            No captures to profile yet
          </span>
        </div>
      ) : (
        <>
          {totalCaptures < 3 && (
            <div
              className="rounded-lg p-3 text-[11px] text-white/40 font-mono leading-relaxed"
              style={{
                background: 'rgba(15,23,42,0.50)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                border: '1px solid rgba(255,255,255,0.07)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
              }}
            >
              Actor profiles emerge as capture volume grows.
              Currently analyzing {totalCaptures} capture{totalCaptures !== 1 ? 's' : ''} across{' '}
              {clusterCount} infrastructure cluster{clusterCount !== 1 ? 's' : ''}.
            </div>
          )}

          <div className="space-y-3">
            {profiles.map((p) => (
              <ProfileCard key={p.domain} profile={p} />
            ))}
          </div>
        </>
      )}

      {/* NEXUS overlap check */}
      <div className="border-t border-white/[0.06] pt-3">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-afterburner animate-pulse" />
          <span className="text-[10px] font-mono text-white/50">
            Checking for infrastructure overlap with known NEXUS clusters…
          </span>
        </div>
      </div>
    </div>
  );
}
