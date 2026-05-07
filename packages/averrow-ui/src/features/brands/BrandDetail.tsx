import { useState, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  useBrandFullDetail,
  useBrandTimeline,
  useTriggerAnalysis,
  useAddSafeDomain,
  useDeleteSafeDomain,
  useCleanFalsePositives,
  useClassifySocialProfile,
  useScanSocialProfiles,
  useDiscoverSocialProfiles,
} from '@/hooks/useBrandDetail';
import { useBrandThreats, type BrandThreatRow } from '@/hooks/useBrands';
import {
  useAppStoreMonitor,
  useScanAppStore,
  useClassifyAppStoreListing,
  type AppClassification,
  type AppStoreListing,
} from '@/hooks/useAppStoreMonitor';
import {
  useDarkWebMentions,
  useScanDarkWeb,
  useClassifyDarkWebMention,
  type DarkWebClassification,
  type DarkWebMention,
} from '@/hooks/useDarkWebMonitor';
import { DeepCard } from '@/components/ui/DeepCard';
import { DimensionalAvatar } from '@/components/ui/DimensionalAvatar';
import { DimensionalButton } from '@/components/ui/DimensionalButton';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Tabs } from '@/components/ui/Tabs';
import { PageLoader } from '@/components/ui/PageLoader';
import { CheckCircle } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { SeverityChip } from '@/components/ui/SeverityChip';
import { ThreatSummaryCards } from './components/ThreatSummaryCards';
import { ProviderBars } from './components/ProviderBars';
import { StatCard } from '@/components/ui/StatCard';
import { BIMIGradeBadge } from '@/components/ui/BIMIGradeBadge';
import { BIMIStatusRow } from '@/components/ui/BIMIStatusRow';
import { relativeTime, timeAgo } from '@/lib/time';
import { AgentAttribution } from '@/components/ui/AgentAttribution';

// ── Constants ──────────────────────────────────────────────────────────
const PLATFORM_ICONS: Record<string, string> = {
  tiktok: '\u266A', github: '<>', linkedin: 'in', twitter: '\uD835\uDD4F',
  instagram: '\uD83D\uDCF7', youtube: '\u25B6', facebook: 'f', reddit: 'r',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#C83C3C', high: '#E8923C', medium: '#DCAA32', low: '#78A0C8', info: '#5A80A8',
};

const TIMELINE_PERIODS = ['24h', '7d', '30d', '90d'] as const;

const BRAND_TABS = [
  { id: 'overview',      label: 'Overview' },
  { id: 'threats',       label: 'Threats' },
  { id: 'typosquats',    label: 'Typosquats' },
  { id: 'email',         label: 'Email Security' },
  { id: 'social',        label: 'Social' },
  { id: 'apps',          label: 'Apps' },
  { id: 'dark-web',      label: 'Dark Web' },
  { id: 'intelligence',  label: 'Intelligence' },
] as const;

type BrandTab = typeof BRAND_TABS[number]['id'];

function classificationVariant(c: string): 'critical' | 'success' | 'high' | 'default' {
  if (c === 'impersonation') return 'critical';
  if (c === 'official') return 'success';
  if (c === 'suspicious') return 'high';
  return 'default';
}

// ── ASTRA Analysis Parser ─────────────────────────────────────────────
interface AstraAnalysis {
  summary: string | null;
  riskLevel: 'critical' | 'high' | 'medium' | 'low' | null;
  keyFindings: string[];
  attackTypes: string[];
  recommendation: string | null;
}

function parseAstraAnalysis(raw: string | object | null | undefined): AstraAnalysis | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      summary: parsed.analysis ?? null,
      riskLevel: parsed.risk_level ?? null,
      keyFindings: parsed.key_findings ?? [],
      attackTypes: parsed.attack_types ?? [],
      recommendation: parsed.recommendation ?? null,
    };
  } catch {
    return {
      summary: typeof raw === 'string' ? raw : null,
      riskLevel: null,
      keyFindings: [],
      attackTypes: [],
      recommendation: null,
    };
  }
}

const RISK_BADGE_VARIANT: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

const RISK_BADGE_CLASSES: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/30',
  high: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  medium: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
};

function toTitleCase(str: string): string {
  return str
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── Derive a friendly vector label from threat fields ────────────────
//
// The `threats` schema doesn't carry an explicit `vector` column. We
// derive one from threat_type + source_feed for the Threats-tab table.
// Returns null when there's nothing meaningful to surface — caller
// renders an em-dash.
function deriveVectorLabel(t: { threat_type?: string; source_feed?: string }): string | null {
  const feed = (t.source_feed ?? '').toLowerCase();
  if (feed.includes('certstream')) return 'CT';
  if (feed.includes('phishtank')) return 'Phishing';
  if (feed.includes('openphish')) return 'Phishing';
  if (feed.includes('urlhaus')) return 'Malware';
  if (feed.includes('abuse')) return 'Abuse.ch';
  if (feed.includes('threatfox')) return 'ThreatFox';
  if (feed.includes('alienvault') || feed.includes('otx')) return 'OTX';
  if (feed.includes('cins')) return 'CINS';
  if (feed.includes('spam_trap')) return 'Spam Trap';
  if (feed.includes('lookalike')) return 'Lookalike';
  if (feed.includes('certstream')) return 'CT';
  if (feed.includes('typosquat')) return 'Typosquat';
  if (feed.includes('darkweb') || feed.includes('dark_web')) return 'Dark Web';
  if (feed.includes('social')) return 'Social';
  return null;
}

// ── Timeline Tooltip ───────────────────────────────────────────────────
function TimelineTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="border border-white/10 rounded-lg px-3 py-2 text-xs backdrop-blur-sm" style={{ background: 'var(--bg-page)' }}>
      <div className="font-mono text-[rgba(255,255,255,0.36)] mb-1">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Severity helpers ─────────────────────────────────────────────────
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SEVERITY_TW: Record<string, { dot: string; text: string; hex: string }> = {
  critical: { dot: 'bg-[#f87171]', text: 'text-[#f87171]', hex: '#f87171' },
  high:     { dot: 'bg-[#fb923c]', text: 'text-[#fb923c]', hex: '#fb923c' },
  medium:   { dot: 'bg-[#fbbf24]', text: 'text-[#fbbf24]', hex: '#fbbf24' },
  low:      { dot: 'bg-contrail/50', text: 'text-[rgba(255,255,255,0.30)]', hex: '#78A0C8' },
  info:     { dot: 'bg-contrail/50', text: 'text-[rgba(255,255,255,0.30)]', hex: '#78A0C8' },
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
function ExposureIndexCard({ brand, threats }: { brand: any; threats: any[] }) {
  const score = brand?.exposure_score ?? brand?.email_security_score ?? brand?.domain_risk_score ?? null;
  const tier = getExposureTier(score);
  const s = score ?? 0;
  const circumference = 2 * Math.PI * 23;
  const offset = circumference * (1 - s / 100);

  // Aggregate top 3 threat types
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
              {score ?? '\u2014'}
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
                <span className="font-mono text-[10px] text-[rgba(255,255,255,0.36)] truncate">
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
function ActiveThreatsCard({ threats }: { threats: any[] }) {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  threats.forEach(t => {
    const sev = t.severity || 'low';
    if (sev in counts) counts[sev]++;
    else counts.low++;
  });

  const total = threats.length;
  const highestActive = SEVERITY_ORDER.find(s => counts[s] > 0) || 'low';
  const totalTextClass = SEVERITY_TW[highestActive]?.text || 'text-[rgba(255,255,255,0.30)]';

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
              <span className="font-mono text-[10px] text-[rgba(255,255,255,0.30)] flex-1 capitalize">{sev}</span>
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
  if (!grade) return 'text-[rgba(255,255,255,0.30)]';
  const g = grade.toUpperCase();
  if (g === 'A+' || g === 'A') return 'text-[#4ade80]';
  if (g.startsWith('B')) return 'text-[#78A0C8]';
  if (g.startsWith('C')) return 'text-[#fbbf24]';
  if (g.startsWith('D')) return 'text-[#fb923c]';
  return 'text-[#f87171]';
}

// Derive a BIMI grade client-side when brand.bimi_grade is null.
// Mirrors the server-side scanBIMI scoring (email-security.ts:404):
//   A+ = DMARC enforce + BIMI record + VMC verified
//   A  = DMARC enforce + BIMI record (no VMC)
//   B  = DMARC enforce, no BIMI
//   C  = DMARC quarantine, no BIMI
//   D  = DMARC none / reporting only
//   F  = no DMARC
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

function EmailPostureCard({ emailSec, grade, brand, onViewDetails }: { emailSec: any; grade: string | null; brand: any; onViewDetails?: () => void }) {
  const gradeClass = getGradeClass(grade);
  const bimiGrade = deriveBimiGrade(brand, emailSec);

  // Count passing protocols for progress bar
  const protocolResults = EMAIL_PROTOCOLS.map(proto => getEmailStatus(proto, emailSec));
  const bimiPass = brand?.bimi_record ? 1 : 0;
  const vmcPass = brand?.bimi_vmc_valid ? 1 : 0;
  const totalChecks = 6; // SPF, DKIM, DMARC, MX, BIMI, VMC
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
          {grade || '\u2014'}
        </span>
      }
    >
      <div className="space-y-1">
        {/* Protocol progress bar */}
        <div className="mb-3">
          <div className="flex justify-between text-[10px] font-mono text-white/30 mb-1">
            <span>{passing} of {totalChecks} protocols</span>
            <span className={gradeClass}>{grade || '\u2014'}</span>
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
              <span className="font-mono text-[10px] text-[rgba(255,255,255,0.42)] w-10 flex-shrink-0">{proto}</span>
              <span className={`font-mono text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded border leading-tight ${cls}`}>
                {status}
              </span>
              {hint && (
                <span className="font-mono text-[9px] text-white/40 truncate">{hint}</span>
              )}
            </div>
          );
        })}

        {/* BIMI / VMC rows */}
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

        {/* BIMI Grade — distinct from the overall Email Grade in the
            card header. The header grade scores SPF/DKIM/DMARC/MX
            enforcement; this one scores BIMI + VMC adoption on top.
            See email-security.ts:404 for the BIMI scoring scheme. */}
        <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between">
          <span className="text-white/40 text-[10px] font-mono uppercase tracking-wider">
            BIMI Grade
          </span>
          <BIMIGradeBadge grade={bimiGrade} size="lg" tooltip />
        </div>

        {/* BIMI SVG preview */}
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

        {/* Grade improvement hint */}
        {bimiGrade && ['B', 'C', 'D', 'F'].includes(bimiGrade) && (
          <div className="mt-3 pt-3 border-t border-white/[0.06]">
            <p className="text-white/40 text-[10px]">
              {bimiGrade === 'B'
                ? '\u2192 Publish a BIMI record to reach grade A'
                : bimiGrade === 'C'
                ? '\u2192 Upgrade DMARC to enforce to reach grade B'
                : '\u2192 Implement DMARC enforcement to protect email'}
            </p>
          </div>
        )}

        {/* View DNS Details button */}
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
function SocialRiskCard({
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
            {total} profiles tracked{scanDaysAgo !== null ? ` \u00b7 scanned ${scanDaysAgo}d ago` : ''}
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

// ── Main Page ──────────────────────────────────────────────────────────
export function BrandDetail() {
  const { brandId } = useParams<{ brandId: string }>();
  const navigate = useNavigate();
  const id = brandId || '';

  // Deep-link tab via ?tab=apps (or any other valid id) — falls back to 'overview'.
  const [searchParams] = useSearchParams();
  const initialTab = (() => {
    const raw = searchParams.get('tab');
    const match = BRAND_TABS.find(t => t.id === raw);
    return (match?.id ?? 'overview') as BrandTab;
  })();

  // State
  const [activeTab, setActiveTab] = useState<BrandTab>(initialTab);
  const [socialFilter, setSocialFilter] = useState('all');
  const [timelinePeriod, setTimelinePeriod] = useState<string>('7d');
  const [threatSort, setThreatSort] = useState<{ key: string; asc: boolean }>({ key: 'severity', asc: false });
  const [safeDomainInput, setSafeDomainInput] = useState('');
  const [expandedThreats, setExpandedThreats] = useState(false);
  const [expandedSummary, setExpandedSummary] = useState(false);

  // Data
  const { data, isLoading } = useBrandFullDetail(id);
  const { data: timelineData } = useBrandTimeline(id, timelinePeriod);

  // Mutations
  const triggerAnalysis = useTriggerAnalysis();
  const addSafeDomain = useAddSafeDomain();
  const deleteSafeDomain = useDeleteSafeDomain();
  const cleanFP = useCleanFalsePositives();
  const classifyProfile = useClassifySocialProfile();
  const scanProfiles = useScanSocialProfiles();
  const discoverProfiles = useDiscoverSocialProfiles();

  // Derived
  const brand = data?.brand;
  const threats = data?.threats || [];
  const providers = data?.providers || [];
  const safeDomains = data?.safeDomains || [];
  const emailSec = data?.emailSecurity;
  const socialProfiles = data?.socialProfiles || [];
  const analysis = data?.analysis;

  const suspiciousCount = socialProfiles.filter(
    (p: any) => p.classification === 'suspicious' || p.classification === 'impersonation'
  ).length;

  const filteredProfiles = socialProfiles.filter((p: any) => {
    if (socialFilter === 'all') return true;
    if (socialFilter === 'official') return p.classification === 'official';
    if (socialFilter === 'suspicious') return p.classification === 'suspicious' || p.classification === 'impersonation';
    if (socialFilter === 'safe') return p.classification === 'safe' || p.classification === 'official';
    return true;
  });

  const socialTabs = [
    { id: 'all', label: 'All', count: socialProfiles.length },
    { id: 'official', label: 'Official' },
    { id: 'suspicious', label: 'Suspicious', count: suspiciousCount },
    { id: 'safe', label: 'Safe' },
  ];

  // Sort threats
  const sortedThreats = useMemo(() => {
    const severityOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    return [...threats].sort((a: any, b: any) => {
      if (threatSort.key === 'severity') {
        const diff = (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0);
        return threatSort.asc ? -diff : diff;
      }
      if (threatSort.key === 'date') {
        const diff = new Date(b.detected_at || 0).getTime() - new Date(a.detected_at || 0).getTime();
        return threatSort.asc ? -diff : diff;
      }
      return 0;
    });
  }, [threats, threatSort]);

  const visibleThreats = expandedThreats ? sortedThreats : sortedThreats.slice(0, 10);

  // Timeline chart data
  const chartData = useMemo(() => {
    if (!timelineData) return [];
    if (Array.isArray(timelineData)) return timelineData;
    if (timelineData.labels) {
      return timelineData.labels.map((label: string, i: number) => ({
        date: label,
        total: timelineData.values?.[i] ?? 0,
        high_sev: timelineData.high_sev?.[i] ?? 0,
        active: timelineData.active?.[i] ?? 0,
      }));
    }
    return [];
  }, [timelineData]);

  // ── Loading / Not Found ────────────────────────────────────────────
  if (isLoading) return <PageLoader />;

  if (!brand) {
    return (
      <div className="animate-fade-in">
        <button onClick={() => navigate('/brands')} className="font-mono text-xs text-[rgba(255,255,255,0.30)] hover:text-accent transition-colors mb-4">
          &larr; Back to Brands
        </button>
        <Card hover={false}><p className="text-sm text-[rgba(255,255,255,0.36)]">Brand not found</p></Card>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-in space-y-6">
      {/* ── Nav ── */}
      <button onClick={() => navigate('/brands')} className="font-mono text-xs text-[rgba(255,255,255,0.30)] hover:text-accent transition-colors">
        &larr; Back to Brands
      </button>

      {/* ── Brand Header ── */}
      <DeepCard variant="base" style={{ padding: '20px 24px', position: 'relative', overflow: 'hidden' }}>
        {/* Ambient glow behind the header — matches brand severity */}
        <div style={{
          position: 'absolute', top: -40, left: '30%',
          width: 300, height: 200, borderRadius: '50%',
          background: `radial-gradient(ellipse, ${SEVERITY_COLORS[brand.top_severity] || '#E5A832'}14, transparent 70%)`,
          pointerEvents: 'none',
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, position: 'relative' }}>
          <DimensionalAvatar
            name={brand.name}
            color={SEVERITY_COLORS[brand.top_severity] || '#E5A832'}
            size={52}
            radius={14}
            faviconUrl={`https://www.google.com/s2/favicons?domain=${brand.canonical_domain}&sz=64`}
            severity={brand.top_severity}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{
              fontSize: 22, fontWeight: 900, color: 'rgba(255,255,255,0.95)',
              letterSpacing: -0.5, lineHeight: 1.1,
            }}>
              {brand.name}
            </h1>
            <div style={{
              fontSize: 12, fontFamily: 'monospace',
              color: 'rgba(255,255,255,0.40)', marginTop: 3,
            }}>
              {brand.canonical_domain}
              {timeAgo(brand.first_seen) && (
                <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.28)' }}>
                  &middot; tracked {timeAgo(brand.first_seen)}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {brand.sector && <Badge variant="info">{brand.sector}</Badge>}
              <Badge variant={brand.monitoring_status === 'active' ? 'success' : 'default'}>
                {brand.monitoring_status}
              </Badge>
            </div>
          </div>
        </div>
      </DeepCard>

      {/* ════════════════════════════════════════════════════════════════
           Sticky Tab Bar
           ════════════════════════════════════════════════════════════════ */}
      <div className="sticky top-0 z-10 bg-slate-950/90 backdrop-blur-lg
        border-b border-white/[0.06] -mx-6 px-6">
        <div className="flex gap-1 overflow-x-auto scrollbar-none">
          {BRAND_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-shrink-0 px-4 py-3 text-xs font-bold transition-all
                border-b-2 ${activeTab === tab.id
                  ? 'border-amber-500 text-amber-400'
                  : 'border-transparent text-white/40 hover:text-white/70'
                }`}
              style={activeTab === tab.id ? { textShadow: '0 0 10px rgba(229,168,50,0.60)' } : undefined}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════
           Tab Content
           ════════════════════════════════════════════════════════════════ */}

      {/* ── OVERVIEW TAB ── */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Hero: Exposure + 3 stat cards */}
          <div className="relative grid grid-cols-1 min-[400px]:grid-cols-2 lg:grid-cols-4 gap-3" style={{
            background: 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(229,168,50,0.06) 0%, transparent 70%)'
          }}>
            <ExposureIndexCard brand={brand} threats={threats} />
            <ActiveThreatsCard threats={threats} />
            <EmailPostureCard emailSec={emailSec} grade={brand.email_security_grade} brand={brand} onViewDetails={() => setActiveTab('email')} />
            <SocialRiskCard
              socialProfiles={socialProfiles}
              lastScan={brand.last_social_scan}
              onScan={() => scanProfiles.mutate(id)}
              onDiscover={() => discoverProfiles.mutate(id)}
              scanPending={scanProfiles.isPending}
              discoverPending={discoverProfiles.isPending}
            />
          </div>

          {/* AI Deep Scan CTA */}
          <div style={{ display: 'flex', gap: 10 }}>
            <DimensionalButton variant="primary" size="md"
              onClick={() => triggerAnalysis.mutate(id)}
              disabled={triggerAnalysis.isPending}>
              {triggerAnalysis.isPending ? 'ANALYZING...' : 'AI DEEP SCAN'}
            </DimensionalButton>
            <DimensionalButton variant="secondary" size="md"
              onClick={() => cleanFP.mutate(id)}
              disabled={cleanFP.isPending}>
              CLEAN FALSE POSITIVES
            </DimensionalButton>
          </div>

          {/* Threat Breakdown + Providers */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-4">
              <SectionLabel label="Threat Breakdown" accent="#C83C3C" />
              <ThreatSummaryCards threats={threats} />
            </div>
            <Card hover={false}>
              <SectionLabel label="Top Providers" accent="#0A8AB5" />
              <ProviderBars providers={providers} />
            </Card>
          </div>

          {/* Latest 5 threats preview */}
          <Card hover={false}>
            <SectionLabel
              label="Recent Threats"
              accent="#C83C3C"
              action={threats.length > 5 ? `View all ${threats.length}` : undefined}
              onAction={() => setActiveTab('threats')}
            />
            {threats.length === 0 ? (
              <EmptyState
                icon={<CheckCircle />}
                title="No active threats for this brand"
                subtitle="Run AI Deep Scan for the latest analysis"
                variant="clean"
                compact
              />
            ) : (
              <div className="space-y-0">
                {sortedThreats.slice(0, 5).map((t: any) => (
                  <div key={t.id}
                    className="data-row flex items-center gap-3 py-2.5 border-b border-white/[0.03] transition-colors"
                    data-severity={t.severity}>
                    <span className="w-[7px] h-[7px] rounded-full flex-shrink-0"
                      style={{ backgroundColor: SEVERITY_COLORS[t.severity] || '#5A80A8' }} />
                    <div className="flex-1 min-w-0">
                      <span className="font-mono text-xs text-white/90">
                        {toTitleCase(t.threat_type || 'unknown')}
                      </span>
                      <span className="font-mono text-[10px] text-white/40 ml-2">
                        {t.malicious_domain || t.malicious_url || t.ip_address || ''}
                      </span>
                    </div>
                    <span className="font-mono text-[10px] text-white/30 flex-shrink-0">
                      {relativeTime(t.detected_at || t.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── THREATS TAB ── */}
      {activeTab === 'threats' && (
        <div className="space-y-6">
          {/* Timeline Chart */}
          <Card hover={false}>
            <div className="flex items-center justify-between mb-4">
              <SectionLabel>Threat Timeline</SectionLabel>
              <div className="flex gap-1.5">
                {TIMELINE_PERIODS.map(p => (
                  <button key={p} onClick={() => setTimelinePeriod(p)}
                    className={`font-mono text-[11px] font-semibold px-3 py-1 rounded transition-all ${
                      timelinePeriod === p
                        ? 'bg-accent/10 text-accent border border-accent/25'
                        : 'text-white/55 hover:bg-white/5 hover:[color:var(--text-primary)] border border-transparent'
                    }`}>
                    {p.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#C83C3C" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#C83C3C" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradHighSev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#E8923C" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#E8923C" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradActive" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#28A050" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#28A050" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date"
                    tick={{ fill: '#78A0C8', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }} tickLine={false} />
                  <YAxis tick={{ fill: '#78A0C8', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                    axisLine={false} tickLine={false} />
                  <Tooltip content={<TimelineTooltip />} />
                  <Area type="monotone" dataKey="total" stroke="#C83C3C" fill="url(#gradTotal)" strokeWidth={2} name="Total" />
                  <Area type="monotone" dataKey="high_sev" stroke="#E8923C" fill="url(#gradHighSev)" strokeWidth={1.5} name="High Severity" />
                  <Area type="monotone" dataKey="active" stroke="#28A050" fill="url(#gradActive)" strokeWidth={1.5} name="Active" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-60 flex items-center justify-center text-white/40 font-mono text-xs">
                No timeline data available
              </div>
            )}
          </Card>

          {/* Threats Table + Safe Domains */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <Card hover={false}>
                <div className="flex items-center justify-between mb-4">
                  <SectionLabel>Active Threats</SectionLabel>
                  <span className="font-mono text-[10px] text-white/40">{threats.length} total</span>
                </div>

                {threats.length === 0 ? (
                  <EmptyState
                    icon={<CheckCircle />}
                    title="No active threats for this brand"
                    subtitle="Run AI Deep Scan for the latest analysis"
                    action={{ label: 'Run AI Deep Scan', onClick: () => triggerAnalysis.mutate(id) }}
                    variant="clean"
                    compact
                  />
                ) : (
                  <>
                    {/* Table header */}
                    <div className="grid grid-cols-[3px_minmax(0,1fr)_minmax(0,1fr)_80px_80px] gap-3 items-center
                      pb-2 border-b border-white/[0.06] mb-2">
                      <div />
                      <button onClick={() => setThreatSort({ key: 'severity', asc: threatSort.key === 'severity' ? !threatSort.asc : false })}
                        className="font-mono text-[9px] text-[rgba(255,255,255,0.30)] uppercase tracking-wider text-left hover:[color:var(--text-primary)] transition-colors">
                        Type / Severity {threatSort.key === 'severity' && (threatSort.asc ? '\u25B2' : '\u25BC')}
                      </button>
                      <div className="font-mono text-[9px] text-[rgba(255,255,255,0.30)] uppercase tracking-wider">Target</div>
                      <div className="font-mono text-[9px] text-[rgba(255,255,255,0.30)] uppercase tracking-wider">Vector</div>
                      <button onClick={() => setThreatSort({ key: 'date', asc: threatSort.key === 'date' ? !threatSort.asc : false })}
                        className="font-mono text-[9px] text-[rgba(255,255,255,0.30)] uppercase tracking-wider text-right hover:[color:var(--text-primary)] transition-colors">
                        Age {threatSort.key === 'date' && (threatSort.asc ? '\u25B2' : '\u25BC')}
                      </button>
                    </div>

                    {/* Threat rows */}
                    {visibleThreats.map((t: any) => {
                      // API field names: malicious_domain / malicious_url
                      // (handlers/brands.ts:619). The legacy field names
                      // target_url / domain were never populated.
                      const secondaryLabel = t.malicious_url || t.malicious_domain || t.ip_address || t.source_feed || null;
                      // Derive a "vector" label from source_feed when the
                      // schema doesn't carry one explicitly.
                      const derivedVector = deriveVectorLabel(t);
                      return (
                        <div key={t.id}
                          data-severity={t.severity}
                          className="data-row grid grid-cols-[3px_minmax(0,1fr)_minmax(0,1fr)_80px_100px] gap-3 items-center py-2.5
                          border-b border-white/[0.03] transition-colors group">
                          <div className="h-full rounded-full" style={{ backgroundColor: SEVERITY_COLORS[t.severity] || '#5A80A8' }} />
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-[7px] h-[7px] rounded-full flex-shrink-0"
                              style={{
                                backgroundColor: SEVERITY_COLORS[t.severity] || '#5A80A8',
                                boxShadow: t.severity === 'critical' ? `0 0 8px ${SEVERITY_COLORS.critical}` : 'none',
                              }} />
                            <div className="min-w-0">
                              <div className="font-mono text-xs font-semibold text-white/90 truncate">
                                {toTitleCase(t.threat_type || 'unknown')}
                              </div>
                              {secondaryLabel && (
                                <div className="font-mono text-[9px] text-white/55 truncate">{secondaryLabel}</div>
                              )}
                            </div>
                          </div>
                          <div className="font-display text-xs font-semibold text-white/80 truncate">
                            {t.malicious_domain || t.malicious_url || t.ip_address || '\u2014'}
                          </div>
                          {derivedVector ? (
                            <Badge variant="info" className="text-[8px] justify-center">{derivedVector}</Badge>
                          ) : (
                            <span className="text-white/40 text-[10px]">{'\u2014'}</span>
                          )}
                          <div className="flex items-center justify-end gap-2 min-w-0">
                            <span className="font-mono text-[10px] text-white/40">
                              {relativeTime(t.detected_at || t.created_at)}
                            </span>
                            {t.score != null && (
                              <span className="font-mono text-[9px] text-white/50">{t.score}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {sortedThreats.length > 10 && (
                      <button onClick={() => setExpandedThreats(!expandedThreats)}
                        className="w-full mt-3 py-2 font-mono text-[10px] hover:text-white
                        border border-white/[0.04] rounded-lg hover:border-accent/20 transition-all"
                        style={{ color: 'var(--text-secondary)' }}>
                        {expandedThreats ? 'SHOW LESS' : `SHOW ALL ${sortedThreats.length} THREATS`}
                      </button>
                    )}
                  </>
                )}
              </Card>
            </div>

            {/* Safe Domains Panel */}
            <Card hover={false}>
              <SectionLabel className="mb-4">Safe Domains</SectionLabel>
              <div className="space-y-2 mb-4">
                {safeDomains.length === 0 ? (
                  <div className="text-white/40 font-mono text-xs py-2">No safe domains configured</div>
                ) : (
                  safeDomains.map((d: any) => (
                    <div key={d.id || d.domain} className="flex items-center justify-between py-1.5 border-b border-white/[0.03]">
                      <span className="font-mono text-xs text-[rgba(255,255,255,0.74)]">{d.domain}</span>
                      <button onClick={() => deleteSafeDomain.mutate({ brandId: id, domainId: d.id })}
                        className="font-mono text-[9px] text-white/50 hover:text-accent transition-colors">
                        REMOVE
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                <input
                  value={safeDomainInput}
                  onChange={e => setSafeDomainInput(e.target.value)}
                  placeholder="Add domain..."
                  className="flex-1 border border-white/[0.06] rounded-md px-3 py-1.5 font-mono text-xs
                    placeholder:text-white/30 focus:border-accent/30 focus:outline-none transition-colors"
                  style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && safeDomainInput.trim()) {
                      addSafeDomain.mutate({ brandId: id, domain: safeDomainInput.trim() });
                      setSafeDomainInput('');
                    }
                  }}
                />
                <Button variant="secondary" size="sm"
                  onClick={() => { if (safeDomainInput.trim()) { addSafeDomain.mutate({ brandId: id, domain: safeDomainInput.trim() }); setSafeDomainInput(''); } }}
                  disabled={!safeDomainInput.trim() || addSafeDomain.isPending}>
                  ADD
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ── TYPOSQUATS TAB ── */}
      {activeTab === 'typosquats' && (
        <TyposquatsTab brandId={id} />
      )}

      {/* ── EMAIL SECURITY TAB ── */}
      {activeTab === 'email' && (
        <div className="space-y-6">
          {/* Email Grade Hero */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card hover={false} className="lg:col-span-1">
              <div className="flex flex-col items-center justify-center py-6">
                <BIMIGradeBadge grade={brand.bimi_grade} size="lg" tooltip />
                <div className="mt-4 text-center">
                  <div className={`font-display text-4xl font-extrabold ${getGradeClass(brand.email_security_grade)}`}>
                    {brand.email_security_grade || '\u2014'}
                  </div>
                  <div className="font-mono text-[10px] text-white/40 uppercase tracking-widest mt-1">
                    Overall Email Grade
                  </div>
                </div>
              </div>
            </Card>

            {/* Protocol Status */}
            <Card hover={false} className="lg:col-span-2">
              <SectionLabel className="mb-4">Protocol Status</SectionLabel>
              <div className="space-y-3">
                {EMAIL_PROTOCOLS.map(proto => {
                  const { status, hint } = getEmailStatus(proto, emailSec);
                  const cls = EMAIL_STATUS_CLASSES[status] || EMAIL_STATUS_CLASSES.MISSING;
                  return (
                    <div key={proto} className="flex items-center gap-3 py-2 border-b border-white/[0.04]">
                      <span className="font-mono text-sm font-bold text-white/70 w-14 flex-shrink-0">{proto}</span>
                      <span className={`font-mono text-[10px] font-semibold uppercase px-2 py-0.5 rounded border leading-tight ${cls}`}>
                        {status}
                      </span>
                      {hint && (
                        <span className="font-mono text-xs text-white/40">{hint}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>

          {/* BIMI Details */}
          <Card hover={false}>
            <SectionLabel className="mb-4">BIMI &amp; VMC Details</SectionLabel>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <BIMIStatusRow
                  label="BIMI Record"
                  status={brand.bimi_record ? 'pass' : 'missing'}
                  detail={brand.bimi_record || undefined}
                />
                <BIMIStatusRow
                  label="BIMI SVG Logo"
                  status={brand.bimi_svg_url ? 'pass' : 'missing'}
                  detail={brand.bimi_svg_url
                    ? (() => { try { return new URL(brand.bimi_svg_url).hostname; } catch { return undefined; } })()
                    : undefined}
                />
                <BIMIStatusRow
                  label="VMC Certificate"
                  status={brand.bimi_vmc_valid ? 'verified' : brand.bimi_vmc_url ? 'fail' : 'none'}
                  detail={brand.bimi_vmc_expiry
                    ? `Expires ${new Date(brand.bimi_vmc_expiry).toLocaleDateString()}`
                    : undefined}
                />
              </div>

              {/* SVG Preview */}
              <div className="flex flex-col items-center justify-center">
                {brand.bimi_svg_url ? (
                  <div className="text-center">
                    <img
                      src={brand.bimi_svg_url}
                      alt="BIMI Logo"
                      className="w-20 h-20 rounded-lg mx-auto"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                    <p className="text-white/30 text-[10px] font-mono mt-2 truncate max-w-[200px]">
                      {brand.bimi_svg_url}
                    </p>
                  </div>
                ) : (
                  <div className="text-center text-white/30">
                    <div className="w-20 h-20 rounded-lg bg-white/[0.03] border border-white/[0.06]
                      flex items-center justify-center mx-auto">
                      <span className="font-mono text-[10px]">NO LOGO</span>
                    </div>
                    <p className="text-[10px] font-mono mt-2">Publish a BIMI record to display your logo</p>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Raw DNS Records */}
          {emailSec && (
            <Card hover={false}>
              <SectionLabel className="mb-4">Raw DNS Records</SectionLabel>
              <div className="space-y-3">
                {emailSec.spf_raw && (
                  <div>
                    <div className="font-mono text-[10px] text-white/40 uppercase tracking-wider mb-1">SPF</div>
                    <div className="font-mono text-xs text-white/70 bg-white/[0.03] rounded-lg p-3 break-all">
                      {emailSec.spf_raw}
                    </div>
                  </div>
                )}
                {emailSec.dmarc_raw && (
                  <div>
                    <div className="font-mono text-[10px] text-white/40 uppercase tracking-wider mb-1">DMARC</div>
                    <div className="font-mono text-xs text-white/70 bg-white/[0.03] rounded-lg p-3 break-all">
                      {emailSec.dmarc_raw}
                    </div>
                  </div>
                )}
                {brand.bimi_record && (
                  <div>
                    <div className="font-mono text-[10px] text-white/40 uppercase tracking-wider mb-1">BIMI</div>
                    <div className="font-mono text-xs text-white/70 bg-white/[0.03] rounded-lg p-3 break-all">
                      {brand.bimi_record}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Grade Improvement */}
          {brand.bimi_grade && ['B', 'C', 'D', 'F'].includes(brand.bimi_grade) && (
            <Card hover={false} className="border-l-[3px] border-amber-500/40">
              <SectionLabel className="mb-3">Improvement Path</SectionLabel>
              <div className="space-y-2 text-sm text-white/70">
                {brand.bimi_grade === 'B' && (
                  <p>&rarr; Publish a BIMI record with a valid SVG logo to reach grade A</p>
                )}
                {brand.bimi_grade === 'C' && (
                  <p>&rarr; Upgrade DMARC policy to &ldquo;quarantine&rdquo; or &ldquo;reject&rdquo; to reach grade B</p>
                )}
                {(brand.bimi_grade === 'D' || brand.bimi_grade === 'F') && (
                  <p>&rarr; Implement SPF, DKIM, and DMARC enforcement to protect email delivery</p>
                )}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ── SOCIAL TAB ── */}
      {activeTab === 'social' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <SectionLabel>Social Profiles</SectionLabel>
              <Badge variant="info">{socialProfiles.length}</Badge>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => scanProfiles.mutate(id)} disabled={scanProfiles.isPending}>
                RESCAN
              </Button>
              <Button variant="ghost" size="sm" onClick={() => discoverProfiles.mutate(id)} disabled={discoverProfiles.isPending}>
                DISCOVER NEW
              </Button>
            </div>
          </div>
          <Tabs tabs={socialTabs} activeTab={socialFilter} onChange={setSocialFilter} />

          {filteredProfiles.length === 0 ? (
            <Card hover={false}>
              <div className="py-6 text-center text-white/40 font-mono text-xs">No profiles match this filter</div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredProfiles.map((profile: any) => (
                <Card key={profile.id} hover={false} className="space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-white/[0.04] border border-white/[0.06]
                        flex items-center justify-center font-mono text-xs text-[rgba(255,255,255,0.36)] font-bold">
                        {PLATFORM_ICONS[(profile.platform ?? '').toLowerCase()] ?? '\u25CF'}
                      </div>
                      <div>
                        <div className="font-mono font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>@{profile.handle}</div>
                        {profile.display_name && (
                          <div className="text-[10px] text-white/55">{profile.display_name}</div>
                        )}
                      </div>
                    </div>
                    <Badge variant={classificationVariant(profile.classification)}>
                      {profile.classification}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-4 font-mono text-[10px] text-white/55">
                    {profile.followers_count != null && (
                      <span>{Number(profile.followers_count).toLocaleString()} followers</span>
                    )}
                    {profile.verified === 1 && (
                      <span className="text-positive font-bold uppercase">Verified</span>
                    )}
                    {profile.platform && (
                      <span className="uppercase">{profile.platform}</span>
                    )}
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] text-[rgba(255,255,255,0.30)]">Impersonation Score</span>
                      <span className="font-mono text-xs font-bold" style={{
                        color: profile.impersonation_score >= 0.70 ? '#C83C3C' : profile.impersonation_score >= 0.40 ? '#E8923C' : '#28A050'
                      }}>{Math.round(profile.impersonation_score * 100)}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-white/5 rounded overflow-hidden">
                      <div className="h-full rounded transition-all duration-500" style={{
                        width: `${Math.min(Math.round(profile.impersonation_score * 100), 100)}%`,
                        background: profile.impersonation_score >= 0.70 ? '#C83C3C' : profile.impersonation_score >= 0.40 ? '#E8923C' : '#28A050',
                      }} />
                    </div>
                  </div>

                  {profile.ai_assessment && (
                    <p className="text-xs text-[rgba(255,255,255,0.36)] line-clamp-3 leading-relaxed">{profile.ai_assessment}</p>
                  )}

                  <div className="flex gap-2 pt-1">
                    <Button variant="ghost" size="sm"
                      onClick={() => classifyProfile.mutate({ brandId: id, profileId: profile.id, classification: 'official' })}>
                      Confirm Safe
                    </Button>
                    <Button variant="danger" size="sm"
                      onClick={() => classifyProfile.mutate({ brandId: id, profileId: profile.id, classification: 'impersonation' })}>
                      Impersonation
                    </Button>
                    <Button variant="ghost" size="sm"
                      onClick={() => classifyProfile.mutate({ brandId: id, profileId: profile.id, classification: 'safe' })}>
                      False Positive
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── APPS TAB ── */}
      {activeTab === 'apps' && <AppsTab brandId={id} />}

      {/* ── DARK WEB TAB ── */}
      {activeTab === 'dark-web' && <DarkWebTab brandId={id} />}

      {/* ── INTELLIGENCE TAB ── */}
      {activeTab === 'intelligence' && (
        <div className="space-y-6">
          {/* AI Threat Analysis — Executive Briefing */}
          {(brand.threat_analysis || analysis) && (() => {
            const astra = parseAstraAnalysis(analysis?.summary || analysis || brand.threat_analysis);
            if (!astra) return null;
            const summaryText = astra.summary || '';
            const needsTruncation = summaryText.length > 300;
            const displaySummary = needsTruncation && !expandedSummary
              ? summaryText.slice(0, 300) + '...'
              : summaryText;
            return (
              <Card hover={false} className="border-l-[3px] border-accent">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <SectionLabel>AI Threat Analysis</SectionLabel>
                    <AgentAttribution agent="Analyst" lastRun={brand.analysis_updated_at || analysis?.updated_at} />
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="critical">CURRENT</Badge>
                      {astra.riskLevel && (
                        <span className={`inline-flex items-center font-mono text-[10px] font-bold tracking-wide uppercase px-2.5 py-0.5 rounded border ${RISK_BADGE_CLASSES[astra.riskLevel] || 'bg-white/5 text-white/60 border-white/10'}`}>
                          {astra.riskLevel} &#9650;
                        </span>
                      )}
                    </div>
                  </div>

                  {summaryText && (
                    <div>
                      <h4 className="font-mono text-[10px] font-semibold text-white/40 uppercase tracking-widest mb-1.5">
                        Summary
                      </h4>
                      <p className="text-sm text-white/80 leading-relaxed">
                        {displaySummary}
                        {needsTruncation && (
                          <button
                            onClick={() => setExpandedSummary(!expandedSummary)}
                            className="ml-1.5 font-mono text-[10px] font-semibold hover:text-white transition-colors"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {expandedSummary ? 'Show less' : 'Show more'}
                          </button>
                        )}
                      </p>
                    </div>
                  )}

                  {astra.keyFindings.length > 0 && (
                    <div>
                      <h4 className="font-mono text-[10px] font-semibold text-white/40 uppercase tracking-widest mb-2">
                        Key Findings
                      </h4>
                      <ul className="space-y-1.5">
                        {astra.keyFindings.map((finding, i) => (
                          <li key={i} className="flex items-start gap-2.5 text-sm text-white/70">
                            <span className="mt-[5px] text-accent text-[8px] flex-shrink-0">&#9670;</span>
                            {finding}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm"
                        onClick={() => triggerAnalysis.mutate(id)}
                        disabled={triggerAnalysis.isPending}>
                        {triggerAnalysis.isPending ? 'ANALYZING...' : 'AI DEEP SCAN'}
                      </Button>
                      <Button variant="ghost" size="sm"
                        onClick={() => cleanFP.mutate(id)}
                        disabled={cleanFP.isPending}>
                        CLEAN FALSE POSITIVES
                      </Button>
                    </div>
                    {(brand.analysis_updated_at || analysis?.updated_at) && (
                      <span className="font-mono text-xs text-white/40">
                        Updated {relativeTime(brand.analysis_updated_at || analysis?.updated_at)}
                      </span>
                    )}
                  </div>
                </div>
              </Card>
            );
          })()}

          {!brand.threat_analysis && !analysis && (
            <EmptyState
              title="No intelligence analysis available"
              subtitle="Run an AI deep scan to generate threat intelligence for this brand"
              variant="scanning"
              action={{
                label: triggerAnalysis.isPending ? 'Analyzing...' : 'Initiate AI Deep Scan',
                onClick: () => triggerAnalysis.mutate(id),
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── TYPOSQUATS TAB ──────────────────────────────────────────────
function TyposquatsTab({ brandId }: { brandId: string }) {
  const [filter, setFilter] = useState<'ALL' | 'CRITICAL_HIGH' | 'AUTO'>('ALL');

  const query = useBrandThreats(brandId, { threat_type: 'typosquatting', limit: 100 });

  const allRows: BrandThreatRow[] = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;

  const critHighCount = allRows.filter(
    (r) => r.severity === 'critical' || r.severity === 'high',
  ).length;
  const autoCount = allRows.filter((r) => r.source_feed === 'typosquat_scanner').length;

  const rows = allRows.filter((r) => {
    if (filter === 'CRITICAL_HIGH') return r.severity === 'critical' || r.severity === 'high';
    if (filter === 'AUTO') return r.source_feed === 'typosquat_scanner';
    return true;
  });

  if (query.isLoading) {
    return <div className="text-center text-white/40 font-mono text-xs py-12">Loading typosquats...</div>;
  }

  if (total === 0) {
    return (
      <EmptyState
        title="No typosquats detected yet"
        subtitle="Scanned automatically by Sentinel · next scan: ~7 days"
        variant="scanning"
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* STAT ROW */}
      <DeepCard variant="active" accent="#C83C3C">
        <div className="grid grid-cols-3 gap-6 p-2">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Total Typosquats</div>
            <div className="text-3xl font-bold text-instrument-white mt-1">{total}</div>
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Critical / High</div>
            <div className="text-3xl font-bold text-[#f87171] mt-1">{critHighCount}</div>
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Auto-detected</div>
            <div className="text-3xl font-bold text-[#fb923c] mt-1">{autoCount}</div>
          </div>
        </div>
      </DeepCard>

      {/* FILTER PILLS + STATUS */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2">
          {(['ALL', 'CRITICAL_HIGH', 'AUTO'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-widest border transition-colors ${
                filter === f
                  ? 'bg-afterburner/20 text-[#E5A832] border-afterburner/40'
                  : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'
              }`}
            >
              {f === 'CRITICAL_HIGH' ? 'Critical / High' : f === 'AUTO' ? 'Auto-detected' : 'All'}
            </button>
          ))}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-white/40">
          Scanned automatically by Sentinel · next scan: ~7 days
        </div>
      </div>

      {/* DOMAIN LIST */}
      <DeepCard variant="base" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="text-center text-white/40 font-mono text-xs py-10">
            No domains match this filter.
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {rows.map((d) => {
              const sev = (d.severity || 'low').toLowerCase() as 'critical' | 'high' | 'medium' | 'low';
              const isAuto = d.source_feed === 'typosquat_scanner';
              const domain = d.malicious_domain || d.malicious_url || '—';
              return (
                <div
                  key={d.id}
                  className="data-row flex items-center gap-4 px-4 py-3"
                  data-severity={sev}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm text-instrument-white truncate">{domain}</div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-white/50 font-mono">
                      {d.ip_address && <span>{d.ip_address}</span>}
                      <span>{isAuto ? 'Auto-detected' : d.source_feed || 'manual'}</span>
                      <span>{relativeTime(d.first_seen || d.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <SeverityChip severity={sev} size="sm" />
                    <span className="px-2 py-0.5 rounded font-mono text-[9px] uppercase tracking-widest bg-[#C83C3C]/20 text-[#f87171] border border-[#C83C3C]/40">
                      Registered
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DeepCard>
    </div>
  );
}

// ─── APPS TAB (app-store impersonation monitoring) ───────────────

type AppsFilter = 'all' | 'impersonation' | 'suspicious' | 'legitimate' | 'official';

const APP_CLASSIFICATION_BADGE: Record<AppClassification, 'critical' | 'high' | 'success' | 'default'> = {
  impersonation: 'critical',
  suspicious: 'high',
  legitimate: 'success',
  official: 'success',
  unknown: 'default',
};

const APP_CLASSIFICATION_LABEL: Record<AppClassification, string> = {
  impersonation: 'Impersonation',
  suspicious: 'Suspicious',
  legitimate: 'Legitimate',
  official: 'Official',
  unknown: 'Unknown',
};

function AppsTab({ brandId }: { brandId: string }) {
  const [filter, setFilter] = useState<AppsFilter>('all');
  const query = useAppStoreMonitor(brandId, { status: 'active', limit: 100 });
  const scan = useScanAppStore();
  const classify = useClassifyAppStoreListing();

  const all = query.data?.results ?? [];
  const total = query.data?.total ?? 0;
  const schedule = query.data?.schedule?.[0];

  const counts = useMemo(() => {
    const c = { all: all.length, impersonation: 0, suspicious: 0, legitimate: 0, official: 0 };
    for (const l of all) {
      if (l.classification === 'impersonation') c.impersonation++;
      else if (l.classification === 'suspicious') c.suspicious++;
      else if (l.classification === 'legitimate') c.legitimate++;
      else if (l.classification === 'official') c.official++;
    }
    return c;
  }, [all]);

  const rows = filter === 'all'
    ? all
    : all.filter((l) => l.classification === filter);

  if (query.isLoading) {
    return <div className="text-center text-white/40 font-mono text-xs py-12">Loading app-store listings...</div>;
  }

  if (total === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => scan.mutate(brandId)}
            disabled={scan.isPending}
          >
            {scan.isPending ? 'Scanning…' : 'Scan iOS Now'}
          </Button>
        </div>
        <EmptyState
          title="No app-store listings scanned yet"
          subtitle={schedule?.next_check
            ? `Next automated scan: ${relativeTime(schedule.next_check)}`
            : 'Click "Scan iOS Now" to search the App Store for impersonations of this brand.'}
          variant="scanning"
        />
      </div>
    );
  }

  const filterPills: Array<{ id: AppsFilter; label: string; count: number }> = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'impersonation', label: 'Impersonation', count: counts.impersonation },
    { id: 'suspicious', label: 'Suspicious', count: counts.suspicious },
    { id: 'legitimate', label: 'Legitimate', count: counts.legitimate },
    { id: 'official', label: 'Official', count: counts.official },
  ];

  return (
    <div className="space-y-6">
      {/* STATS + RESCAN */}
      <DeepCard variant="active" accent="#0A8AB5">
        <div className="grid grid-cols-4 gap-6 p-2">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Total Apps</div>
            <div className="text-3xl font-bold text-instrument-white mt-1">{total}</div>
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Impersonation</div>
            <div className="text-3xl font-bold text-[#f87171] mt-1">{counts.impersonation}</div>
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Suspicious</div>
            <div className="text-3xl font-bold text-[#fb923c] mt-1">{counts.suspicious}</div>
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Legit / Official</div>
            <div className="text-3xl font-bold text-[#3CB878] mt-1">{counts.legitimate + counts.official}</div>
          </div>
        </div>
      </DeepCard>

      {/* FILTER + SCAN */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap">
          {filterPills.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-widest border transition-colors ${
                filter === f.id
                  ? 'bg-afterburner/20 text-[#E5A832] border-afterburner/40'
                  : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'
              }`}
            >
              {f.label} <span className="opacity-60">({f.count})</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-white/40">
            {schedule?.last_checked ? `Last scan: ${relativeTime(schedule.last_checked)}` : 'Never scanned'}
          </div>
          <Button
            variant="secondary"
            onClick={() => scan.mutate(brandId)}
            disabled={scan.isPending}
          >
            {scan.isPending ? 'Scanning…' : 'Rescan'}
          </Button>
        </div>
      </div>

      {/* LISTINGS */}
      {rows.length === 0 ? (
        <DeepCard variant="base">
          <div className="text-center text-white/40 font-mono text-xs py-10">
            No apps match this filter.
          </div>
        </DeepCard>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rows.map((listing) => (
            <AppListingCard
              key={listing.id}
              listing={listing}
              brandId={brandId}
              onClassify={(classification) =>
                classify.mutate({ listingId: listing.id, brandId, classification })
              }
              onResolve={(status) =>
                classify.mutate({ listingId: listing.id, brandId, status })
              }
              disabled={classify.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AppListingCard({
  listing,
  onClassify,
  onResolve,
  disabled,
}: {
  listing: AppStoreListing;
  brandId: string;
  onClassify: (classification: AppClassification) => void;
  onResolve: (status: 'resolved' | 'false_positive') => void;
  disabled: boolean;
}) {
  const sev = (listing.severity || 'LOW').toLowerCase() as 'critical' | 'high' | 'medium' | 'low';
  const badgeVariant = APP_CLASSIFICATION_BADGE[listing.classification];
  const score = Math.round(listing.impersonation_score * 100);

  return (
    <Card>
      <div className="flex items-start gap-3">
        {listing.icon_url ? (
          <img
            src={listing.icon_url}
            alt=""
            className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
          />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-white/5 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-sm text-instrument-white truncate">{listing.app_name}</div>
              <div className="font-mono text-[10px] text-white/50 truncate">
                {listing.developer_name ?? 'unknown developer'}
              </div>
            </div>
            <Badge variant={badgeVariant}>{APP_CLASSIFICATION_LABEL[listing.classification]}</Badge>
          </div>

          <div className="flex items-center gap-3 mt-2 text-[10px] text-white/50 font-mono">
            <span className="uppercase tracking-widest">{listing.store}</span>
            {listing.bundle_id && <span className="truncate">{listing.bundle_id}</span>}
            <span>{relativeTime(listing.last_checked ?? listing.created_at)}</span>
          </div>

          <div className="flex items-center gap-2 mt-2">
            <SeverityChip severity={sev} size="sm" />
            {listing.classification === 'impersonation' || listing.classification === 'suspicious' ? (
              <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full"
                  style={{
                    width: `${score}%`,
                    background:
                      score >= 70 ? '#f87171' :
                      score >= 40 ? '#fb923c' : '#fbbf24',
                  }}
                />
              </div>
            ) : null}
            {score > 0 && (
              <span className="font-mono text-[10px] text-white/60 tabular-nums">{score}%</span>
            )}
          </div>

          {listing.ai_assessment && (
            <div className="mt-2 text-[11px] text-white/70 line-clamp-3">
              {listing.ai_assessment}
            </div>
          )}

          {listing.app_url && (
            <a
              href={listing.app_url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-[10px] font-mono text-[#E5A832] hover:underline"
            >
              View on App Store →
            </a>
          )}

          <div className="flex gap-1.5 mt-3 flex-wrap">
            <button
              onClick={() => onClassify('legitimate')}
              disabled={disabled}
              className="px-2 py-1 rounded font-mono text-[9px] uppercase tracking-widest border border-[#3CB878]/40 text-[#3CB878] bg-[#3CB878]/10 hover:bg-[#3CB878]/20 disabled:opacity-50"
            >
              Confirm Safe
            </button>
            <button
              onClick={() => onClassify('impersonation')}
              disabled={disabled}
              className="px-2 py-1 rounded font-mono text-[9px] uppercase tracking-widest border border-[#C83C3C]/40 text-[#f87171] bg-[#C83C3C]/10 hover:bg-[#C83C3C]/20 disabled:opacity-50"
            >
              Impersonation
            </button>
            <button
              onClick={() => onResolve('false_positive')}
              disabled={disabled}
              className="px-2 py-1 rounded font-mono text-[9px] uppercase tracking-widest border border-white/10 text-white/60 bg-white/5 hover:bg-white/10 disabled:opacity-50"
            >
              False Positive
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── DARK WEB TAB (paste-archive mention monitoring) ─────────────

type DarkWebFilter = 'all' | 'confirmed' | 'suspicious';

const DARK_WEB_BADGE: Record<DarkWebClassification, 'critical' | 'high' | 'default' | 'success'> = {
  confirmed: 'critical',
  suspicious: 'high',
  false_positive: 'default',
  resolved: 'success',
  unknown: 'default',
};

const DARK_WEB_LABEL: Record<DarkWebClassification, string> = {
  confirmed: 'Confirmed',
  suspicious: 'Suspicious',
  false_positive: 'False Positive',
  resolved: 'Resolved',
  unknown: 'Unknown',
};

function DarkWebTab({ brandId }: { brandId: string }) {
  const [filter, setFilter] = useState<DarkWebFilter>('all');
  const query = useDarkWebMentions(brandId, { status: 'active', limit: 100 });
  const scan = useScanDarkWeb();
  const classify = useClassifyDarkWebMention();

  const all = query.data?.results ?? [];
  const total = query.data?.total ?? 0;
  const schedule = query.data?.schedule?.[0];

  const counts = useMemo(() => {
    const c = { all: all.length, confirmed: 0, suspicious: 0 };
    for (const m of all) {
      if (m.classification === 'confirmed') c.confirmed++;
      else if (m.classification === 'suspicious') c.suspicious++;
    }
    return c;
  }, [all]);

  const rows = filter === 'all'
    ? all
    : all.filter((m) => m.classification === filter);

  if (query.isLoading) {
    return <div className="text-center text-white/40 font-mono text-xs py-12">Loading dark-web mentions...</div>;
  }

  if (total === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => scan.mutate(brandId)}
            disabled={scan.isPending}
          >
            {scan.isPending ? 'Scanning…' : 'Scan Pastebin Now'}
          </Button>
        </div>
        <EmptyState
          title="No dark-web mentions yet"
          subtitle={schedule?.next_check
            ? `Next automated scan: ${relativeTime(schedule.next_check)}`
            : 'Click "Scan Pastebin Now" to search paste archives for mentions of this brand.'}
          variant="scanning"
        />
      </div>
    );
  }

  const filterPills: Array<{ id: DarkWebFilter; label: string; count: number }> = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'confirmed', label: 'Confirmed', count: counts.confirmed },
    { id: 'suspicious', label: 'Suspicious', count: counts.suspicious },
  ];

  return (
    <div className="space-y-6">
      <DeepCard variant="active" accent="#C83C3C">
        <div className="grid grid-cols-3 gap-6 p-2">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Total Mentions</div>
            <div className="text-3xl font-bold text-instrument-white mt-1">{total}</div>
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Confirmed</div>
            <div className="text-3xl font-bold text-[#f87171] mt-1">{counts.confirmed}</div>
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50">Suspicious</div>
            <div className="text-3xl font-bold text-[#fb923c] mt-1">{counts.suspicious}</div>
          </div>
        </div>
      </DeepCard>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap">
          {filterPills.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-widest border transition-colors ${
                filter === f.id
                  ? 'bg-afterburner/20 text-[#E5A832] border-afterburner/40'
                  : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'
              }`}
            >
              {f.label} <span className="opacity-60">({f.count})</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-white/40">
            {schedule?.last_checked ? `Last scan: ${relativeTime(schedule.last_checked)}` : 'Never scanned'}
          </div>
          <Button
            variant="secondary"
            onClick={() => scan.mutate(brandId)}
            disabled={scan.isPending}
          >
            {scan.isPending ? 'Scanning…' : 'Rescan'}
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <DeepCard variant="base">
          <div className="text-center text-white/40 font-mono text-xs py-10">
            No mentions match this filter.
          </div>
        </DeepCard>
      ) : (
        <div className="space-y-3">
          {rows.map((mention) => (
            <MentionCard
              key={mention.id}
              mention={mention}
              onClassify={(classification) =>
                classify.mutate({ mentionId: mention.id, brandId, classification })
              }
              onResolve={(status) =>
                classify.mutate({ mentionId: mention.id, brandId, status })
              }
              disabled={classify.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MentionCard({
  mention,
  onClassify,
  onResolve,
  disabled,
}: {
  mention: DarkWebMention;
  onClassify: (classification: DarkWebClassification) => void;
  onResolve: (status: 'resolved' | 'false_positive') => void;
  disabled: boolean;
}) {
  const sev = (mention.severity || 'LOW').toLowerCase() as 'critical' | 'high' | 'medium' | 'low';
  const badgeVariant = DARK_WEB_BADGE[mention.classification];

  let matchedTerms: string[] = [];
  try {
    matchedTerms = mention.matched_terms ? JSON.parse(mention.matched_terms) : [];
  } catch { /* malformed JSON — render empty */ }

  return (
    <Card>
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[9px] uppercase tracking-widest text-white/50">
                {mention.source}
              </span>
              {mention.match_type && (
                <span className="font-mono text-[9px] uppercase tracking-widest text-white/40">
                  · {mention.match_type.replace(/_/g, ' ')}
                </span>
              )}
              <span className="font-mono text-[9px] text-white/40">
                · {relativeTime(mention.last_seen ?? mention.first_seen)}
              </span>
            </div>
            <a
              href={mention.source_url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-sm text-[#E5A832] hover:underline truncate block mt-0.5"
            >
              {mention.source_url}
            </a>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <SeverityChip severity={sev} size="sm" />
            <Badge variant={badgeVariant}>{DARK_WEB_LABEL[mention.classification]}</Badge>
          </div>
        </div>

        {matchedTerms.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {matchedTerms.map((t, i) => (
              <span
                key={`${t}-${i}`}
                className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[9px] text-white/60"
              >
                {t}
              </span>
            ))}
          </div>
        )}

        {mention.content_snippet && (
          <pre className="font-mono text-[10px] text-white/60 whitespace-pre-wrap break-all bg-black/30 rounded px-3 py-2 border border-white/5 max-h-32 overflow-y-auto">
            {mention.content_snippet}
          </pre>
        )}

        {mention.ai_assessment && (
          <div className="text-[11px] text-white/70 italic border-l-2 border-[#E5A832]/40 pl-3">
            AI: {mention.ai_assessment}
          </div>
        )}

        <div className="flex gap-1.5 flex-wrap pt-1">
          <button
            onClick={() => onClassify('confirmed')}
            disabled={disabled}
            className="px-2 py-1 rounded font-mono text-[9px] uppercase tracking-widest border border-[#C83C3C]/40 text-[#f87171] bg-[#C83C3C]/10 hover:bg-[#C83C3C]/20 disabled:opacity-50"
          >
            Confirm Threat
          </button>
          <button
            onClick={() => onResolve('false_positive')}
            disabled={disabled}
            className="px-2 py-1 rounded font-mono text-[9px] uppercase tracking-widest border border-white/10 text-white/60 bg-white/5 hover:bg-white/10 disabled:opacity-50"
          >
            False Positive
          </button>
          <button
            onClick={() => onResolve('resolved')}
            disabled={disabled}
            className="px-2 py-1 rounded font-mono text-[9px] uppercase tracking-widest border border-[#3CB878]/40 text-[#3CB878] bg-[#3CB878]/10 hover:bg-[#3CB878]/20 disabled:opacity-50"
          >
            Resolve
          </button>
        </div>
      </div>
    </Card>
  );
}
