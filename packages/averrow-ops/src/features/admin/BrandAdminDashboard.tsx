import { Link } from 'react-router-dom';
import { Shield, AlertTriangle, Activity, Mail } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useBrandAdminDashboard } from '@/hooks/useBrandAdminDashboard';
import { StatCard } from '@/components/ui/StatCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { severityColor } from '@/lib/severityColor';
import { relativeTime } from '@/lib/time';

const GLASS_CARD: React.CSSProperties = {
  background: 'rgba(15,23,42,0.50)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: '0.75rem',
  boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
};
const GLASS_STAT: React.CSSProperties = {
  background: 'rgba(22,30,48,0.50)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid rgba(229,168,50,0.15)',
  borderRadius: '0.75rem',
  boxShadow: '0 0 20px rgba(229,168,50,0.05), inset 0 1px 0 rgba(255,255,255,0.04)',
};

function emailGrade(score: number | null): string {
  if (score === null) return '-';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function BrandAdminDashboard() {
  const { user } = useAuth();
  const { data, isLoading } = useBrandAdminDashboard();

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const orgName = user?.organization?.name ?? 'Your Organization';
  const plan = user?.organization?.plan ?? 'standard';

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div>
        <h1 className="font-display text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Welcome, {user?.name?.split(' ')[0] ?? 'there'}
        </h1>
        <p className="font-mono text-[11px] mt-1" style={{ color: 'var(--text-secondary)' }}>
          {orgName} &middot; {plan} plan
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Your Threats"
          value={data?.total_threats ?? 0}
          accentColor="#C83C3C"
        />
        <StatCard
          label="Active Now"
          value={data?.active_threats ?? 0}
          accentColor="#FB923C"
        />
        <StatCard
          label="Brands"
          value={data?.brand_count ?? 0}
          accentColor="#0A8AB5"
        />
        <StatCard
          label="Email Grade"
          value={emailGrade(data?.avg_email_score ?? null)}
          accentColor={data?.avg_email_score ? severityColor(data.avg_email_score) : '#78A0C8'}
        />
      </div>

      {/* Brand Health Cards */}
      {data?.brand_health && data.brand_health.length > 0 && (
        <section>
          <SectionLabel>Brand Health</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-3">
            {data.brand_health.map((brand) => (
              <Link
                key={brand.id}
                to={`/brands/${brand.id}`}
                className="p-4 hover:border-afterburner/30 transition-colors block"
                style={GLASS_STAT}
              >
                <div className="flex items-center gap-2">
                  <Shield size={14} style={{ color: 'var(--blue)' }} />
                  <span className="font-display text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{brand.name}</span>
                </div>
                <div className="font-mono text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{brand.canonical_domain}</div>
                <div className="flex items-center gap-4 mt-3">
                  <div className="flex items-center gap-1.5">
                    <div
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: severityColor(null, brand.threat_count) }}
                    />
                    <span className="font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>{brand.threat_count} threats</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Activity size={10} style={{ color: 'var(--text-tertiary)' }} />
                    <span className="font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>{brand.active_threats} active</span>
                  </div>
                  {brand.email_security_grade && (
                    <div className="flex items-center gap-1.5">
                      <Mail size={10} style={{ color: 'var(--text-tertiary)' }} />
                      <span
                        className="font-mono text-[11px] font-bold"
                        style={{ color: severityColor(brand.email_security_score) }}
                      >
                        {brand.email_security_grade}
                      </span>
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Recent Threats */}
      {data?.recent_threats && data.recent_threats.length > 0 && (
        <section>
          <SectionLabel>Recent Threats (24h)</SectionLabel>
          <div className="overflow-hidden mt-3 overflow-x-auto" style={GLASS_CARD}>
            <table className="w-full text-left min-w-[600px]">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="font-mono text-[9px] uppercase tracking-widest px-4 py-2" style={{ color: 'var(--text-tertiary)' }}>Type</th>
                  <th className="font-mono text-[9px] uppercase tracking-widest px-4 py-2" style={{ color: 'var(--text-tertiary)' }}>Domain</th>
                  <th className="font-mono text-[9px] uppercase tracking-widest px-4 py-2" style={{ color: 'var(--text-tertiary)' }}>Brand</th>
                  <th className="font-mono text-[9px] uppercase tracking-widest px-4 py-2" style={{ color: 'var(--text-tertiary)' }}>Severity</th>
                  <th className="font-mono text-[9px] uppercase tracking-widest px-4 py-2" style={{ color: 'var(--text-tertiary)' }}>When</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_threats.map((t) => (
                  <tr key={t.id} className="data-row border-b border-white/5">
                    <td className="px-4 py-2 font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>{t.threat_type}</td>
                    <td className="px-4 py-2 font-mono text-[11px] truncate max-w-[200px]" style={{ color: 'var(--text-secondary)' }}>{t.malicious_domain ?? '-'}</td>
                    <td className="px-4 py-2 font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>{t.brand_name ?? '-'}</td>
                    <td className="px-4 py-2">
                      <span
                        className="font-mono text-[10px] font-bold uppercase"
                        style={{ color: severityColor(null, t.severity === 'critical' ? 200 : t.severity === 'high' ? 100 : t.severity === 'medium' ? 50 : 1) }}
                      >
                        {t.severity ?? '-'}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{relativeTime(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Alert Feed & Takedown Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Alerts */}
        <section>
          <SectionLabel>Recent Alerts</SectionLabel>
          <div className="space-y-2 mt-3">
            {data?.recent_alerts && data.recent_alerts.length > 0 ? (
              data.recent_alerts.slice(0, 8).map((a) => (
                <div key={a.id} className="p-3 flex items-center gap-3" style={GLASS_STAT}>
                  <AlertTriangle
                    size={14}
                    style={{ color: severityColor(null, a.severity === 'CRITICAL' ? 200 : a.severity === 'HIGH' ? 100 : 20) }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>{a.title}</div>
                    <div className="font-mono text-[9px]" style={{ color: 'var(--text-tertiary)' }}>{a.brand_name} &middot; {relativeTime(a.created_at)}</div>
                  </div>
                  <span className="font-mono text-[9px] uppercase text-white/55">{a.status}</span>
                </div>
              ))
            ) : (
              <div className="font-mono text-[11px] text-white/40 py-4 text-center">No recent alerts</div>
            )}
          </div>
        </section>

        {/* Takedown Status */}
        <section>
          <SectionLabel>Takedown Status</SectionLabel>
          <div className="p-5 mt-3" style={GLASS_STAT}>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="font-display text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{data?.takedown_summary?.total ?? 0}</div>
                <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Total Requests</div>
              </div>
              <div>
                <div className="font-display text-2xl font-bold" style={{ color: 'var(--amber)' }}>{data?.takedown_summary?.pending ?? 0}</div>
                <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Pending</div>
              </div>
              <div>
                <div className="font-display text-2xl font-bold" style={{ color: 'var(--green)' }}>{data?.takedown_summary?.taken_down ?? 0}</div>
                <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Taken Down</div>
              </div>
              <div>
                <div className="font-display text-2xl font-bold" style={{ color: 'var(--red)' }}>{data?.takedown_summary?.failed ?? 0}</div>
                <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Failed</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
