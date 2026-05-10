// Hero cards for the BrandDetail v3 Risk tab. Extracted from the
// (now-deleted) v2 BrandDetail.tsx as part of the v2 brands
// decommission. These cards stay shared because both the Risk tab
// AND any future per-brand summary surface render them.
//
// 4 cards exported:
//   ExposureIndexCard — exposure_score gauge + top-3 threat-type bars
//   ActiveThreatsCard — count by severity (critical/high/medium/low)
//   EmailPostureCard  — DMARC/SPF/DKIM/MX/BIMI/VMC summary + grade
//   SocialRiskCard    — official/suspicious/impersonation counts
//
// Pure presentation; all data-fetching is at the BrandDetail v3
// shell level. No version toggle, no embedded shenanigans.

import { StatCard } from '@/components/ui/StatCard';
import { BIMIGradeBadge } from '@/components/ui/BIMIGradeBadge';
import { BIMIStatusRow } from '@/components/ui/BIMIStatusRow';

// ── Severity / threat-type styling ──────────────────────────────────

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SEVERITY_TW: Record<string, { dot: string; text: string; hex: string }> = {
  critical: { dot: 'bg-[#f87171]', text: 'text-[#f87171]', hex: '#f87171' },
  high:     { dot: 'bg-[#fb923c]', text: 'text-[#fb923c]', hex: '#fb923c' },
  medium:   { dot: 'bg-[#fbbf24]', text: 'text-[#fbbf24]', hex: '#fbbf24' },
  low:      { dot: 'bg-contrail/50', text: 'text-[var(--text-muted)]', hex: '#78A0C8' },
  info:     { dot: 'bg-contrail/50', text: 'text-[var(--text-muted)]', hex: '#78A0C8' },
};

const THREAT_TYPE_COLORS: Record<string, { bar: string; text: string }> = {
  phishing:             { bar: 'bg-[#78A0C8]', text: 'text-[#78A0C8]' },
  malware_distribution: { bar: 'bg-[#fb923c]', text: 'text-[#fb923c]' },
  c2:                   { bar: 'bg-[#f87171]', text: 'text-[#f87171]' },
  credential_harvesting:{ bar: 'bg-[#f97316]', text: 'text-[#f97316]' },
  typosquatting:        { bar: 'bg-[#fbbf24]', text: 'text-[#fbbf24]' },
  impersonation:        { bar: 'bg-[#fb923c]', text: 'text-[#fb923c]' },
};

function getExposureTier(score: number | null) {
  if (score === null || score === undefined) return { color: 'text-white/30', stroke: '#ffffff4d', label: 'NO DATA', arcClass: 'stroke-white/20' };
  if (score >= 80) return { color: 'text-[#4ade80]', stroke: '#4ade80', label: 'LOW RISK', arcClass: 'stroke-[#4ade80]' };
  if (score >= 60) return { color: 'text-[#fbbf24]', stroke: '#fbbf24', label: 'MEDIUM', arcClass: 'stroke-[#fbbf24]' };
  if (score >= 40) return { color: 'text-[#fb923c]', stroke: '#fb923c', label: 'HIGH', arcClass: 'stroke-[#fb923c]' };
  return { color: 'text-[#f87171]', stroke: '#f87171', label: 'CRITICAL', arcClass: 'stroke-[#f87171]' };
}

// ── Card 1: Exposure Index ──────────────────────────────────────────

export function ExposureIndexCard({ brand, threats }: { brand: any; threats: any[] }) {
  const score = brand?.exposure_score ?? brand?.email_security_score ?? brand?.domain_risk_score ?? null;
  const tier = getExposureTier(score);
  const s = score ?? 0;
  const circumference = 2 * Math.PI * 23;
  const offset = circumference * (1 - s / 100);

  const typeCounts: Record<string, number> = {};
  threats.forEach(t => {
    const type = t.threat_type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });
  const topTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const maxCount = topTypes.length > 0 ? topTypes[0][1] : 1;

  return (
    <StatCard
      title="Exposure Index"
      metricLabel={<span className={tier.color}>{tier.label}</span>}
      metric={
        <div className="relative w-[52px] h-[52px]">
          <svg width="52" height="52" viewBox="0 0 52 52">
            <circle cx="26" cy="26" r="23" fill="none" className="stroke-[#1e3048]" strokeWidth="5" />
            {score !== null && (
              <circle
                cx="26" cy="26" r="23" fill="none"
                className={`transition-all duration-700 ${tier.arcClass}`}
                strokeWidth="5" strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                transform="rotate(-90 26 26)"
              />
            )}
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className={`font-mono text-[13px] font-bold ${tier.color}`}>
              {score ?? '—'}
            </span>
          </div>
        </div>
      }
    >
      <div className="space-y-2">
        {topTypes.length === 0 && (
          <div className="font-mono text-[10px] text-white/40">No threats detected</div>
        )}
        {topTypes.map(([type, count]) => {
          const tc = THREAT_TYPE_COLORS[type] || { bar: 'bg-[#78A0C8]', text: 'text-[#78A0C8]' };
          const pct = Math.max(count > 0 ? 4 : 0, Math.round((count / maxCount) * 100));
          return (
            <div key={type} className="space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-[var(--text-tertiary)] truncate">
                  {type.replace(/_/g, ' ')}
                </span>
                <span className={`font-mono text-[10px] font-semibold ${tc.text}`}>
                  {count}
                </span>
              </div>
              <div className="w-full h-[2px] rounded-full bg-white/[0.04]">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${tc.bar}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </StatCard>
  );
}

// ── Card 2: Active Threats ──────────────────────────────────────────

export function ActiveThreatsCard({ threats }: { threats: any[] }) {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  threats.forEach(t => {
    const sev = t.severity || 'low';
    if (sev in counts) counts[sev]++;
    else counts.low++;
  });

  const total = threats.length;
  const highestActive = SEVERITY_ORDER.find(s => counts[s] > 0) || 'low';
  const totalTextClass = SEVERITY_TW[highestActive]?.text || 'text-[var(--text-muted)]';

  return (
    <StatCard
      title="Active Threats"
      metricLabel="TOTAL"
      metric={
        <span className={`font-display text-[32px] font-extrabold leading-none ${totalTextClass}`}>
          {total}
        </span>
      }
    >
      <div className="space-y-1.5">
        {(['critical', 'high', 'medium', 'low'] as const).map(sev => {
          const tw = SEVERITY_TW[sev];
          const c = counts[sev];
          return (
            <div key={sev} className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tw.dot}`} />
              <span className="font-mono text-[10px] text-[var(--text-muted)] flex-1 capitalize">{sev}</span>
              <span className={`font-mono text-[10px] font-semibold ${c > 0 ? tw.text : 'text-white/[0.15]'}`}>
                {c}
              </span>
            </div>
          );
        })}
        <div className="border-t border-contrail/[0.08] pt-1.5 mt-1">
          <span className="font-mono text-[9px] text-white/50">7-day window</span>
        </div>
      </div>
    </StatCard>
  );
}

// ── Card 3: Email Posture ───────────────────────────────────────────

const EMAIL_PROTOCOLS = ['SPF', 'DKIM', 'DMARC', 'MX'] as const;

function getEmailStatus(protocol: string, emailSec: any) {
  if (!emailSec) return { status: 'MISSING', hint: '' };

  if (protocol === 'MX') {
    if (emailSec.mx_exists) {
      const providers = emailSec.mx_providers;
      const hint = Array.isArray(providers) && providers.length > 0
        ? (typeof providers[0] === 'string' ? providers[0] : providers[0]?.exchange ?? '')
        : '';
      return { status: 'FOUND', hint };
    }
    return { status: 'MISSING', hint: 'risk' };
  }

  if (protocol === 'SPF') {
    if (!emailSec.spf_exists) return { status: 'MISSING', hint: '' };
    if (emailSec.spf_too_many_lookups) return { status: 'PARTIAL', hint: '>10 lookups' };
    const hint = emailSec.spf_raw
      ? (String(emailSec.spf_raw).match(/[~+-]all/)?.[0] ?? '')
      : '';
    return { status: 'PASS', hint };
  }

  if (protocol === 'DKIM') {
    if (!emailSec.dkim_exists) return { status: 'MISSING', hint: '' };
    const selectors = emailSec.dkim_selectors_found;
    const hint = Array.isArray(selectors) && selectors.length > 0
      ? `${selectors.length} selector${selectors.length > 1 ? 's' : ''}`
      : 'valid';
    return { status: 'PASS', hint };
  }

  if (protocol === 'DMARC') {
    if (!emailSec.dmarc_exists) return { status: 'NONE', hint: '' };
    const policy = emailSec.dmarc_policy;
    if (policy === 'none') return { status: 'NONE', hint: 'p=none' };
    return { status: 'PASS', hint: policy ? `p=${policy}` : '' };
  }

  return { status: 'MISSING', hint: '' };
}

const EMAIL_STATUS_CLASSES: Record<string, string> = {
  PASS:    'bg-green-900/40 text-green-400 border-green-500/30',
  FOUND:   'bg-green-900/40 text-green-400 border-green-500/30',
  FAIL:    'bg-red-900/40 text-red-400 border-red-500/30',
  MISSING: 'bg-red-900/40 text-red-400 border-red-500/30',
  PARTIAL: 'bg-amber-900/40 text-amber-400 border-amber-500/30',
  NONE:    'bg-amber-900/40 text-amber-400 border-amber-500/30',
};

function getGradeClass(grade: string | null): string {
  if (!grade) return 'text-[var(--text-muted)]';
  const g = grade.toUpperCase();
  if (g === 'A+' || g === 'A') return 'text-[#4ade80]';
  if (g.startsWith('B')) return 'text-[#78A0C8]';
  if (g.startsWith('C')) return 'text-[#fbbf24]';
  if (g.startsWith('D')) return 'text-[#fb923c]';
  return 'text-[#f87171]';
}

function deriveBimiGrade(brand: any, emailSec: any): string | null {
  if (brand?.bimi_grade) return brand.bimi_grade;
  const dmarcPolicy = (emailSec?.dmarc?.policy ?? '').toLowerCase();
  const hasBimi = !!brand?.bimi_record;
  const vmcValid = !!brand?.bimi_vmc_valid;
  if (!dmarcPolicy) return 'F';
  if (dmarcPolicy === 'none') return 'D';
  if (dmarcPolicy === 'quarantine') return 'C';
  if (dmarcPolicy === 'reject') {
    if (hasBimi && vmcValid) return 'A+';
    if (hasBimi) return 'A';
    return 'B';
  }
  return null;
}

export function EmailPostureCard({ emailSec, grade, brand, onViewDetails }: { emailSec: any; grade: string | null; brand: any; onViewDetails?: () => void }) {
  const gradeClass = getGradeClass(grade);
  const bimiGrade = deriveBimiGrade(brand, emailSec);

  const protocolResults = EMAIL_PROTOCOLS.map(proto => getEmailStatus(proto, emailSec));
  const bimiPass = brand?.bimi_record ? 1 : 0;
  const vmcPass = brand?.bimi_vmc_valid ? 1 : 0;
  const totalChecks = 6;
  const passing = protocolResults.filter(r => r.status === 'PASS' || r.status === 'FOUND').length + bimiPass + vmcPass;

  const gradeBarColor =
    grade === 'A+' || grade === 'A' ? 'bg-green-500' :
    grade === 'B' ? 'bg-blue-400' :
    grade === 'C' ? 'bg-amber-400' :
    'bg-red-400';

  return (
    <StatCard
      title={
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span>Email Security</span>
        </div>
      }
      metricLabel="GRADE"
      metric={
        <span className={`font-display text-[32px] font-extrabold leading-none ${gradeClass}`}>
          {grade || '—'}
        </span>
      }
    >
      <div className="space-y-1">
        <div className="mb-3">
          <div className="flex justify-between text-[10px] font-mono text-white/30 mb-1">
            <span>{passing} of {totalChecks} protocols passing</span>
          </div>
          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${gradeBarColor}`}
              style={{ width: `${(passing / totalChecks) * 100}%` }}
            />
          </div>
        </div>

        {EMAIL_PROTOCOLS.map(proto => {
          const { status, hint } = getEmailStatus(proto, emailSec);
          const cls = EMAIL_STATUS_CLASSES[status] || EMAIL_STATUS_CLASSES.MISSING;
          return (
            <div key={proto} className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-[var(--text-tertiary)] w-10 flex-shrink-0">{proto}</span>
              <span className={`font-mono text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded border leading-tight ${cls}`}>
                {status}
              </span>
              {hint && (
                <span className="font-mono text-[9px] text-white/40 truncate">{hint}</span>
              )}
            </div>
          );
        })}

        <div className="border-t border-white/[0.06] mt-2 pt-2">
          <BIMIStatusRow
            label="BIMI"
            status={brand?.bimi_record ? 'pass' : 'missing'}
            detail={brand?.bimi_svg_url
              ? (() => { try { return new URL(brand.bimi_svg_url).hostname; } catch { return undefined; } })()
              : undefined}
          />
          <BIMIStatusRow
            label="VMC"
            status={brand?.bimi_vmc_valid ? 'verified' : brand?.bimi_vmc_url ? 'fail' : 'none'}
            detail={brand?.bimi_vmc_expiry
              ? `Expires ${new Date(brand.bimi_vmc_expiry).toLocaleDateString()}`
              : undefined}
          />
        </div>

        <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between">
          <span className="text-white/40 text-[10px] font-mono uppercase tracking-wider">
            BIMI/VMC sub-grade
          </span>
          <BIMIGradeBadge grade={bimiGrade} size="sm" tooltip />
        </div>

        {brand?.bimi_svg_url && (
          <div className="mt-3 pt-3 border-t border-white/[0.06]">
            <p className="text-white/30 text-[10px] font-mono mb-2">BIMI LOGO</p>
            <div className="flex items-center gap-3">
              <img
                src={brand.bimi_svg_url}
                alt="BIMI Logo"
                className="w-8 h-8 rounded"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
              <p className="text-white/30 text-[10px] font-mono truncate">
                {brand.bimi_svg_url}
              </p>
            </div>
          </div>
        )}

        {bimiGrade && ['B', 'C', 'D', 'F'].includes(bimiGrade) && (
          <div className="mt-3 pt-3 border-t border-white/[0.06]">
            <p className="text-white/40 text-[10px]">
              {bimiGrade === 'B'
                ? '→ Publish a BIMI record to reach grade A'
                : bimiGrade === 'C'
                ? '→ Upgrade DMARC to enforce to reach grade B'
                : '→ Implement DMARC enforcement to protect email'}
            </p>
          </div>
        )}

        {onViewDetails && (
          <button
            onClick={onViewDetails}
            className="mt-3 w-full text-center text-[10px] text-white/30 transition-colors font-mono py-1 hover:[color:var(--amber)]"
          >
            View DNS Details &rarr;
          </button>
        )}
      </div>
    </StatCard>
  );
}

// ── Card 4: Social Risk ─────────────────────────────────────────────

export function SocialRiskCard({
  socialProfiles,
  lastScan,
  onScan,
  onDiscover,
  scanPending,
  discoverPending,
}: {
  socialProfiles: any[];
  lastScan: string | null;
  onScan: () => void;
  onDiscover: () => void;
  scanPending: boolean;
  discoverPending: boolean;
}) {
  const impersonation = socialProfiles.filter((p: any) => p.classification === 'impersonation').length;
  const suspicious = socialProfiles.filter((p: any) => p.classification === 'suspicious').length;
  const official = socialProfiles.filter((p: any) => p.classification === 'official' || p.classification === 'safe').length;
  const total = socialProfiles.length;

  const totalClass = impersonation > 0
    ? 'text-[#f87171]'
    : suspicious > 0
      ? 'text-[#fb923c]'
      : total > 0
        ? 'text-[#4ade80]'
        : 'text-white/40';

  const scanDaysAgo = lastScan
    ? Math.max(0, Math.round((Date.now() - new Date(lastScan).getTime()) / 86400000))
    : null;

  return (
    <StatCard
      title="Social Risk"
      metricLabel="PROFILES"
      metric={
        <span className={`font-display text-[32px] font-extrabold leading-none ${totalClass}`}>
          {total}
        </span>
      }
    >
      <div>
        {([
          { label: 'Impersonation', count: impersonation, dot: 'bg-[#f87171]', text: 'text-[#f87171]' },
          { label: 'Suspicious', count: suspicious, dot: 'bg-[#fb923c]', text: 'text-[#fb923c]' },
          { label: 'Official', count: official, dot: 'bg-green-500/50', text: 'text-green-400' },
        ] as const).map(row => (
          <div key={row.label} className="flex items-center gap-2 py-1">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${row.dot}`} />
            <span className="flex-1 text-[11px] font-mono text-white/60 truncate">{row.label}</span>
            <span className={`text-[11px] font-mono flex-shrink-0 ${row.count > 0 ? row.text : 'text-white/40'}`}>
              {row.count}
            </span>
          </div>
        ))}
        <div className="border-t border-contrail/[0.08] pt-1.5 mt-1 space-y-1">
          <span className="font-mono text-[9px] text-white/50 block">
            {total} profiles tracked{scanDaysAgo !== null ? ` · scanned ${scanDaysAgo}d ago` : ''}
          </span>
          <div className="flex gap-3">
            <button
              onClick={onScan}
              disabled={scanPending}
              className="font-mono text-[10px] transition-colors disabled:opacity-40"
              style={{ color: 'var(--text-secondary)' }}
            >
              {scanPending ? 'SCANNING...' : 'SCAN'}
            </button>
            <button
              onClick={onDiscover}
              disabled={discoverPending}
              className="font-mono text-[10px] transition-colors disabled:opacity-40"
              style={{ color: 'var(--text-secondary)' }}
            >
              {discoverPending ? 'DISCOVERING...' : 'DISCOVER NEW'}
            </button>
          </div>
        </div>
      </div>
    </StatCard>
  );
}
