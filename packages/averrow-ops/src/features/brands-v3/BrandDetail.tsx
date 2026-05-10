// Brand-health v3 detail. Per .claude/plans/v3.md §9.6 the goal is to
// collapse the v2 detail's 8 data-shape tabs into 3 outcome-shaped tabs:
//
//   • Surface  — the brand's owned-domain footprint ("what we know about you")
//   • Risk     — active threats + impersonations ("what's threatening you now")
//   • Workflow — open takedowns + alerts ("what needs your action")
//
// Stage 1 = frontend-only IA refactor. Same handlers (`/api/brands/...`)
// as v2 — only the IA changes. The individual upstream surfaces
// (threats / email / social / apps / dark-web / intelligence) are each
// scheduled for their own audit, so this scaffold deliberately AVOIDS
// re-asserting those as canonical labels — it shows counts, sparklines,
// and deep-links back to the v2 tabs for full lists. The v3 file
// concerns itself only with the outcome-shaped IA.

import { useState, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  useBrandFullDetail,
  useBrandTimeline,
  useTriggerAnalysis,
  useScanSocialProfiles,
  useDiscoverSocialProfiles,
} from '@/hooks/useBrandDetail';
import { useDarkWebMentions } from '@/hooks/useDarkWebMonitor';
import { useAppStoreMonitor } from '@/hooks/useAppStoreMonitor';
import {
  useBrandDomains, useBrandFirmographics, useBrandScoreHistory,
  type BrandDomain, type BrandFirmographics, type BrandScoreSnapshot,
} from '@/hooks/useBrandSurface';
import { useAlerts } from '@/hooks/useAlerts';
import { useAdminTakedowns } from '@/hooks/useTakedowns';
import { DeepCard } from '@/components/ui/DeepCard';
import { DimensionalAvatar } from '@/components/ui/DimensionalAvatar';
import { DimensionalButton } from '@/components/ui/DimensionalButton';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { PageLoader } from '@/components/ui/PageLoader';
import { EmptyState } from '@/components/ui/EmptyState';
import { BrandsVersionToggle } from '@/components/ui/BrandsVersionToggle';
import { timeAgo } from '@/lib/time';
import {
  ExposureIndexCard,
  ActiveThreatsCard,
  EmailPostureCard,
  SocialRiskCard,
} from '@/features/brands/BrandDetail';

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#C83C3C', high: '#E8923C', medium: '#DCAA32', low: '#78A0C8', info: '#5A80A8',
};

const V3_TABS = [
  { id: 'surface',  label: 'Surface',  hint: "What we know about you" },
  { id: 'risk',     label: 'Risk',     hint: "What's threatening you now" },
  { id: 'workflow', label: 'Workflow', hint: 'What needs your action' },
] as const;

type V3Tab = typeof V3_TABS[number]['id'];

export function BrandDetailV3() {
  const { brandId } = useParams<{ brandId: string }>();
  const navigate = useNavigate();
  const id = brandId || '';

  const [searchParams] = useSearchParams();
  const initialTab = (() => {
    const raw = searchParams.get('tab');
    const match = V3_TABS.find(t => t.id === raw);
    return (match?.id ?? 'surface') as V3Tab;
  })();

  const [activeTab, setActiveTab] = useState<V3Tab>(initialTab);

  const { data, isLoading } = useBrandFullDetail(id);
  useBrandTimeline(id, '7d'); // primes cache; not rendered in v3 yet
  const { data: darkWebData } = useDarkWebMentions(id);
  const { data: appStoreData } = useAppStoreMonitor(id);
  const { data: alertsData } = useAlerts({ brand_id: id, status: 'new' });
  const { data: takedownData } = useAdminTakedowns({ status: 'pending', limit: 200 });
  const alerts = alertsData?.alerts ?? [];
  const darkWebMentions = darkWebData?.results ?? [];
  const appListings = appStoreData?.results ?? [];

  const triggerAnalysis = useTriggerAnalysis();
  const scanProfiles = useScanSocialProfiles();
  const discoverProfiles = useDiscoverSocialProfiles();

  const brand = data?.brand;
  const threats = data?.threats || [];
  const safeDomains = data?.safeDomains || [];
  const emailSec = data?.emailSecurity;
  const socialProfiles = data?.socialProfiles || [];
  const { data: brandDomains = [] } = useBrandDomains(id);
  const { data: firmographics = null } = useBrandFirmographics(id);
  const { data: scoreHistory = [] } = useBrandScoreHistory(id, 30);

  const suspiciousSocials = useMemo(
    () => socialProfiles.filter((p: any) => p.classification === 'suspicious' || p.classification === 'impersonation'),
    [socialProfiles],
  );
  const officialSocials = useMemo(
    () => socialProfiles.filter((p: any) => p.classification === 'official'),
    [socialProfiles],
  );
  const suspiciousApps = useMemo(
    () => appListings.filter((l: any) => l.classification === 'impersonation' || l.classification === 'suspicious'),
    [appListings],
  );
  const brandTakedowns = useMemo(
    () => (takedownData?.takedowns ?? []).filter((t: any) => t.brand_id === id),
    [takedownData, id],
  );

  if (isLoading) return <PageLoader />;

  if (!brand) {
    return (
      <div className="animate-fade-in">
        <button onClick={() => navigate('/brands')} className="font-mono text-xs text-[var(--text-muted)] hover:text-accent transition-colors mb-4">
          &larr; Back to Brands
        </button>
        <Card hover={false}><p className="text-sm text-[var(--text-tertiary)]">Brand not found</p></Card>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center justify-between gap-4">
        <button onClick={() => navigate('/brands')} className="font-mono text-xs text-[var(--text-muted)] hover:text-accent transition-colors">
          &larr; Back to Brands
        </button>
        <BrandsVersionToggle brandId={id} />
      </div>

      <DeepCard variant="base" style={{ padding: '20px 24px', position: 'relative', overflow: 'hidden' }}>
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
            <h1 style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: -0.5, lineHeight: 1.1 }}>
              {brand.name}
            </h1>
            <div style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-tertiary)', marginTop: 3 }}>
              {brand.canonical_domain}
              {timeAgo(brand.first_seen) && (
                <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
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

      <div className="sticky top-0 z-10 bg-slate-950/90 backdrop-blur-lg border-b border-white/[0.06] -mx-6 px-6">
        <div className="flex gap-1 overflow-x-auto scrollbar-none">
          {V3_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-shrink-0 px-4 py-3 text-xs font-bold transition-all border-b-2 ${
                activeTab === tab.id ? 'border-amber-500 text-amber-400' : 'border-transparent text-white/40 hover:text-white/70'
              }`}
              style={activeTab === tab.id ? { textShadow: '0 0 10px rgba(229,168,50,0.60)' } : undefined}
              title={tab.hint}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'surface' && (
        <SurfaceTab
          brand={brand}
          emailSec={emailSec}
          safeDomains={safeDomains}
          officialSocials={officialSocials}
          appListings={appListings}
          brandDomains={brandDomains}
          firmographics={firmographics}
          onJumpV2={(tab: string) => navigate(`/brands/${id}?tab=${tab}`)}
        />
      )}

      {activeTab === 'risk' && (
        <RiskTab
          brand={brand}
          threats={threats}
          emailSec={emailSec}
          socialProfiles={socialProfiles}
          suspiciousSocials={suspiciousSocials}
          suspiciousApps={suspiciousApps}
          darkWebMentions={darkWebMentions}
          alerts={alerts}
          scoreHistory={scoreHistory}
          onJumpV2={(tab: string) => navigate(`/brands/${id}?tab=${tab}`)}
          onScanSocials={() => scanProfiles.mutate(id)}
          onDiscoverSocials={() => discoverProfiles.mutate(id)}
          onAiDeepScan={() => triggerAnalysis.mutate(id)}
          aiPending={triggerAnalysis.isPending}
          scanPending={scanProfiles.isPending}
          discoverPending={discoverProfiles.isPending}
        />
      )}

      {activeTab === 'workflow' && (
        <WorkflowTab
          alerts={alerts}
          takedowns={brandTakedowns}
        />
      )}
    </div>
  );
}

// ── SURFACE ──────────────────────────────────────────────────────────────
// "What we know about you." Owned-domain footprint + firmographic block
// + email posture + known-official social/app presence. PR7 wires the
// real brand_domains list (PR1 schema) and brand_firmographics sibling
// (PR4 enricher) — both rendered honestly: empty/sparse where the
// data isn't there yet rather than hidden.
function SurfaceTab({
  brand, emailSec, safeDomains, officialSocials, appListings,
  brandDomains, firmographics, onJumpV2,
}: {
  brand: any;
  emailSec: any;
  safeDomains: any[];
  officialSocials: any[];
  appListings: any[];
  brandDomains: BrandDomain[];
  firmographics: BrandFirmographics | null;
  onJumpV2: (tab: string) => void;
}) {
  const officialApps = appListings.filter((l: any) => l.classification === 'official');

  return (
    <div className="space-y-4">
      <DomainFootprintCard brandDomains={brandDomains} canonicalDomain={brand.canonical_domain} safeDomains={safeDomains} />

      <FirmographicBlock firmographics={firmographics} brand={brand} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <EmailPostureCard emailSec={emailSec} grade={brand.email_security_grade} brand={brand} onViewDetails={() => onJumpV2('email')} />

        <Card hover={false}>
          <SectionLabel>Confirmed presence</SectionLabel>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <FootprintTile
              label="Official social profiles"
              value={String(officialSocials.length)}
              sub={officialSocials.length > 0 ? 'Confirmed by AI judge' : 'None classified yet'}
              onClick={() => onJumpV2('social')}
            />
            <FootprintTile
              label="Official app listings"
              value={String(officialApps.length)}
              sub={officialApps.length > 0 ? 'Across stores' : 'No store presence detected'}
              onClick={() => onJumpV2('apps')}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── RISK ──────────────────────────────────────────────────────────────────
// "What's threatening you now." Active threat counts + impersonations
// across surfaces + dark-web mentions + email-posture grade as a single
// "what to worry about" view. Defers the per-surface drill-down to v2
// for now — those upstream surfaces (threats / social / apps / dark-web)
// are getting their own audits.
function RiskTab({
  brand, threats, emailSec, socialProfiles, suspiciousSocials, suspiciousApps,
  darkWebMentions, alerts, scoreHistory, onJumpV2, onScanSocials, onDiscoverSocials,
  onAiDeepScan, aiPending, scanPending, discoverPending,
}: any) {
  const newAlertCount = alerts.length;
  const healthScore   = brand.brand_health_score   ?? null;
  const healthGrade   = brand.brand_health_grade   ?? null;
  const exposureScore = brand.brand_exposure_score ?? null;

  return (
    <div className="space-y-4">
      {/* Two-axis split: Health (defense) vs Exposure (offense). The
          quadrant placement tells you the brand's posture at a glance. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <ScoreCard
          label="Brand Health"
          tone="ok"
          score={healthScore}
          grade={healthGrade}
          history={scoreHistory as BrandScoreSnapshot[]}
          field="brand_health_score"
          subtitle="Defensive posture"
          updatedAt={brand.brand_health_updated_at}
        />
        <ScoreCard
          label="Brand Exposure"
          tone="crit"
          score={exposureScore}
          grade={null}
          history={scoreHistory as BrandScoreSnapshot[]}
          field="brand_exposure_score"
          subtitle="Offensive pressure"
          updatedAt={brand.brand_exposure_updated_at}
        />
        <HealthExposureQuadrant healthScore={healthScore} exposureScore={exposureScore} />
      </div>

      {/* Existing 4-card hero kept below the new split — these are the
          per-category v2 cards. Kept for now since each upstream surface
          (threats / email / social) is getting its own audit; v3 doesn't
          want to lock in their data shape yet. */}
      <div className="grid grid-cols-1 min-[400px]:grid-cols-2 lg:grid-cols-4 gap-3">
        <ExposureIndexCard brand={brand} threats={threats} />
        <ActiveThreatsCard threats={threats} />
        <EmailPostureCard emailSec={emailSec} grade={brand.email_security_grade} brand={brand} onViewDetails={() => onJumpV2('email')} />
        <SocialRiskCard
          socialProfiles={socialProfiles}
          lastScan={brand.last_social_scan}
          onScan={onScanSocials}
          onDiscover={onDiscoverSocials}
          scanPending={scanPending}
          discoverPending={discoverPending}
        />
      </div>

      <Card hover={false}>
        <SectionLabel>Risk surface roll-up</SectionLabel>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <RollupTile
            label="Suspicious socials"
            count={suspiciousSocials.length}
            onClick={() => onJumpV2('social')}
            tone={suspiciousSocials.length > 0 ? 'warn' : 'neutral'}
          />
          <RollupTile
            label="Suspicious app listings"
            count={suspiciousApps.length}
            onClick={() => onJumpV2('apps')}
            tone={suspiciousApps.length > 0 ? 'warn' : 'neutral'}
          />
          <RollupTile
            label="Dark-web mentions"
            count={darkWebMentions.length}
            onClick={() => onJumpV2('dark-web')}
            tone={darkWebMentions.length > 0 ? 'warn' : 'neutral'}
          />
          <RollupTile
            label="Open alerts"
            count={newAlertCount}
            tone={newAlertCount > 0 ? 'crit' : 'neutral'}
          />
        </div>
        <div className="mt-3 text-[11px] text-[var(--text-muted)] font-mono">
          Each surface above gets its own audit. Counts here roll up the same
          handlers v2 uses; the per-surface IA may change in subsequent v3 work.
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <DimensionalButton variant="primary" size="md" onClick={onAiDeepScan} disabled={aiPending}>
          {aiPending ? 'ANALYZING…' : 'AI DEEP SCAN'}
        </DimensionalButton>
      </div>
    </div>
  );
}

// ── WORKFLOW ─────────────────────────────────────────────────────────────
// "What needs your action." Open takedowns + open alerts for this brand.
// Provider escalations are part of the takedown automation track (Phase
// C of the v3-architecture plan — `takedown_provider_apis`); for now
// surfaced through the same takedown rows.
function WorkflowTab({ alerts, takedowns }: { alerts: any[]; takedowns: any[] }) {
  return (
    <div className="space-y-4">
      <Card hover={false}>
        <SectionLabel>Open takedowns</SectionLabel>
        <div className="mt-3 text-[11px] font-mono text-[var(--text-tertiary)]">
          {takedowns.length} pending for this brand
        </div>
        <div className="mt-3 space-y-2">
          {takedowns.length === 0 && (
            <EmptyState title="No open takedowns" description="Sparrow has no drafts assembled for this brand right now." />
          )}
          {takedowns.slice(0, 8).map((t: any) => (
            <TakedownRow key={t.id} takedown={t} />
          ))}
          {takedowns.length > 8 && (
            <div className="text-[11px] font-mono text-[var(--text-muted)]">
              + {takedowns.length - 8} more in the takedowns queue
            </div>
          )}
        </div>
      </Card>

      <Card hover={false}>
        <SectionLabel>Open alerts</SectionLabel>
        <div className="mt-3 text-[11px] font-mono text-[var(--text-tertiary)]">
          {alerts.length} new for this brand
        </div>
        <div className="mt-3 space-y-2">
          {alerts.length === 0 && (
            <EmptyState title="No open alerts" description="Auto-triage has cleared everything we'd surface." />
          )}
          {alerts.slice(0, 8).map((a: any) => (
            <AlertRow key={a.id} alert={a} />
          ))}
          {alerts.length > 8 && (
            <div className="text-[11px] font-mono text-[var(--text-muted)]">
              + {alerts.length - 8} more in the alerts queue
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────
// ── Risk: ScoreCard + HealthExposureQuadrant ──────────────────────────
//
// Health (defense) and Exposure (offense) are intentionally separate
// scores per .claude/plans/v3.md §9.6 + Phase 2 research synthesis.
// No DRP vendor publishes this split — it's a Averrow differentiator.
// The ScoreCard renders one score with a 30-day sparkline from the
// brand_score_snapshots table (PR3). The Quadrant places the brand
// in the offensive-pressure × defensive-posture plane so an operator
// sees at a glance whether they're a "sitting duck" (high pressure +
// weak defense) or a "well-defended target" (high pressure + strong
// defense).

function ScoreCard({
  label, tone, score, grade, history, field, subtitle, updatedAt,
}: {
  label: string;
  tone: 'ok' | 'crit';
  score: number | null;
  grade: string | null;
  history: BrandScoreSnapshot[];
  field: 'brand_health_score' | 'brand_exposure_score';
  subtitle: string;
  updatedAt?: string | null;
}) {
  const accent = tone === 'crit' ? 'var(--sev-critical)' : 'var(--green)';
  const series = history
    .map(s => s[field])
    .filter((v): v is number => typeof v === 'number');
  const empty = score === null || score === undefined;

  return (
    <Card hover={false} variant="active" accent={accent}>
      <div className="flex items-center justify-between">
        <SectionLabel>{label}</SectionLabel>
        {grade && (
          <span style={{
            padding: '2px 8px', borderRadius: 4,
            background: 'rgba(60,184,120,0.10)', color: 'var(--green)',
            fontSize: 10, fontFamily: 'monospace', fontWeight: 700,
          }}>{grade}</span>
        )}
      </div>
      <div className="mt-1 text-[10px] text-[var(--text-muted)] font-mono">{subtitle}</div>

      <div className="mt-3 flex items-end gap-3">
        <div style={{
          fontSize: 36, fontWeight: 800, lineHeight: 1,
          color: empty ? 'var(--text-muted)' : accent,
          textShadow: empty ? 'none' : `0 0 12px ${accent}55`,
        }}>
          {empty ? '—' : score}
        </div>
        <div className="text-[10px] text-[var(--text-tertiary)] font-mono">
          / 100
        </div>
      </div>

      <div className="mt-3">
        <Sparkline series={series} accent={accent} />
        <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-[var(--text-muted)]">
          <span>{series.length > 0 ? `${series.length}d trend` : 'No trend yet'}</span>
          {updatedAt && <span>updated {timeAgo(updatedAt)}</span>}
        </div>
      </div>

      {empty && (
        <div className="mt-2 text-[11px] text-[var(--text-muted)]">
          Score will populate after the next daily snapshot.
        </div>
      )}
    </Card>
  );
}

function Sparkline({ series, accent }: { series: number[]; accent: string }) {
  if (series.length < 2) {
    return (
      <div style={{
        height: 28, borderRadius: 4,
        border: '1px dashed var(--border-base)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span className="text-[10px] font-mono text-[var(--text-muted)]">
          {series.length === 0 ? 'no history' : '1 sample'}
        </span>
      </div>
    );
  }
  const w = 240;
  const h = 28;
  const max = Math.max(...series, 1);
  const min = Math.min(...series, 0);
  const range = Math.max(1, max - min);
  const step = w / (series.length - 1);
  const points = series.map((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 28 }}>
      <polyline
        points={points}
        fill="none"
        stroke={accent}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HealthExposureQuadrant({
  healthScore, exposureScore,
}: {
  healthScore: number | null;
  exposureScore: number | null;
}) {
  const haveBoth = healthScore !== null && exposureScore !== null;

  // Quadrant labels — what each corner means
  const quadrants = [
    { x: 0.75, y: 0.25, label: 'Sitting duck',   tone: 'crit' },  // high exposure, low health
    { x: 0.25, y: 0.25, label: 'Lucky',          tone: 'warn' },  // low exposure, low health
    { x: 0.75, y: 0.75, label: 'Well defended',  tone: 'ok'   },  // high exposure, high health
    { x: 0.25, y: 0.75, label: 'Quiet & safe',   tone: 'ok'   },  // low exposure, high health
  ] as const;

  // Map 0-100 scores to 0-1 chart coords. Y-axis inverted (SVG top=0).
  const x = haveBoth ? exposureScore! / 100 : 0.5;
  const y = haveBoth ? 1 - healthScore! / 100 : 0.5;

  return (
    <Card hover={false}>
      <SectionLabel>Posture quadrant</SectionLabel>
      <div className="mt-3 relative" style={{ aspectRatio: '1', maxWidth: 220, margin: '0 auto' }}>
        <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
          {/* Background quadrants (faint) */}
          <rect x="0"  y="0"  width="50" height="50" fill="rgba(229,168,50,0.04)" />
          <rect x="50" y="0"  width="50" height="50" fill="rgba(200,60,60,0.06)" />
          <rect x="0"  y="50" width="50" height="50" fill="rgba(60,184,120,0.06)" />
          <rect x="50" y="50" width="50" height="50" fill="rgba(60,184,120,0.10)" />
          {/* Center axes */}
          <line x1="50" y1="0" x2="50" y2="100" stroke="rgba(255,255,255,0.10)" strokeWidth="0.5" />
          <line x1="0"  y1="50" x2="100" y2="50" stroke="rgba(255,255,255,0.10)" strokeWidth="0.5" />
          {/* Quadrant labels */}
          {quadrants.map(q => (
            <text key={q.label}
              x={q.x * 100} y={q.y * 100}
              fontSize="6" fontFamily="monospace"
              fill="var(--text-muted)" textAnchor="middle"
              dominantBaseline="middle"
            >{q.label}</text>
          ))}
          {/* Brand position dot */}
          {haveBoth && (
            <>
              <circle cx={x * 100} cy={y * 100} r="4" fill="var(--amber)"
                stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
              <circle cx={x * 100} cy={y * 100} r="8" fill="none"
                stroke="var(--amber)" strokeOpacity="0.4" strokeWidth="1" />
            </>
          )}
        </svg>
        {/* Axis labels */}
        <div className="absolute bottom-0 right-0 text-[9px] font-mono text-[var(--text-muted)] uppercase tracking-wider">
          → Exposure
        </div>
        <div className="absolute top-0 left-0 text-[9px] font-mono text-[var(--text-muted)] uppercase tracking-wider"
          style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}>
          ↑ Health
        </div>
      </div>
      {!haveBoth && (
        <div className="mt-2 text-[11px] text-[var(--text-muted)] font-mono text-center">
          Awaiting first daily snapshot
        </div>
      )}
    </Card>
  );
}

// ── DomainFootprintCard ──────────────────────────────────────────────
// Renders the brand_domains table (PR1 schema). Apex first, then
// type-grouped (subdomain / regional / redirect / acquired / customer-
// added). Each row shows the domain + type chip + source chip.
function DomainFootprintCard({
  brandDomains, canonicalDomain, safeDomains,
}: {
  brandDomains: BrandDomain[];
  canonicalDomain: string;
  safeDomains: any[];
}) {
  const empty = brandDomains.length === 0;
  // Group for display
  const apex = brandDomains.filter(d => d.domain_type === 'apex');
  const others = brandDomains.filter(d => d.domain_type !== 'apex');

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Owned domain footprint</SectionLabel>
        <span className="text-[11px] font-mono text-[var(--text-muted)]">
          {brandDomains.length} {brandDomains.length === 1 ? 'domain' : 'domains'} tracked
        </span>
      </div>
      {empty && (
        <div className="text-xs text-[var(--text-tertiary)] py-3">
          No domains tracked yet. The CT scanner + RDAP enricher will populate
          this as new evidence arrives.
        </div>
      )}
      {!empty && (
        <div className="space-y-1.5">
          {apex.map(d => <DomainRow key={d.id} domain={d} apex />)}
          {others.map(d => <DomainRow key={d.id} domain={d} />)}
        </div>
      )}
      {safeDomains.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/[0.04] text-[11px] text-[var(--text-muted)] font-mono">
          + {safeDomains.length} brand-safe {safeDomains.length === 1 ? 'domain' : 'domains'} (excluded from impersonation matching)
        </div>
      )}
      {empty && (
        <div className="mt-2 text-[11px] text-[var(--text-muted)] font-mono">
          Canonical: <code>{canonicalDomain}</code>
        </div>
      )}
    </Card>
  );
}

const DOMAIN_TYPE_LABEL: Record<string, string> = {
  apex:              'Apex',
  subdomain:         'Subdomain',
  regional:          'Regional',
  redirect:          'Redirect',
  acquired_property: 'Acquired',
  customer_added:    'Customer',
};

function DomainRow({ domain, apex = false }: { domain: BrandDomain; apex?: boolean }) {
  return (
    <div style={{
      padding: '6px 10px', borderRadius: 6,
      border: '1px solid var(--border-base)',
      background: apex ? 'rgba(229,168,50,0.05)' : 'var(--bg-input)',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <code className="text-xs flex-1 truncate" style={{ color: apex ? 'var(--amber)' : 'var(--text-primary)' }}>
        {domain.domain}
      </code>
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
        style={{ background: 'var(--bg-card)', color: 'var(--text-tertiary)' }}>
        {DOMAIN_TYPE_LABEL[domain.domain_type] ?? domain.domain_type}
      </span>
      <span className="text-[10px] font-mono text-[var(--text-muted)]">
        {domain.source}
      </span>
    </div>
  );
}

// ── FirmographicBlock ────────────────────────────────────────────────
// Renders the brand_firmographics sibling (PR4 enricher). When the
// row is null OR all fields are null, shows an "enrichment pending"
// state — honest about coverage gaps rather than hiding the section.
function FirmographicBlock({
  firmographics, brand,
}: {
  firmographics: BrandFirmographics | null;
  brand: any;
}) {
  const hasAny = firmographics && (
    firmographics.revenue_band ||
    firmographics.employee_band ||
    firmographics.industry_naics ||
    firmographics.industry_sic ||
    firmographics.founded_year ||
    firmographics.is_public ||
    firmographics.ticker
  );

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Who you are</SectionLabel>
        {firmographics?.source && (
          <span className="text-[10px] font-mono text-[var(--text-muted)]">
            via {firmographics.source.replace(/_/g, ' ')}
          </span>
        )}
      </div>
      {!hasAny && (
        <div className="text-xs text-[var(--text-tertiary)] py-3">
          Firmographic enrichment pending. The free-source enricher
          (SEC EDGAR + Companies House + Wikidata) sweeps daily; coverage
          is sparse for the long tail.
        </div>
      )}
      {hasAny && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <FootprintTile label="Revenue"   value={firmographics!.revenue_band  ?? '—'} />
          <FootprintTile label="Employees" value={firmographics!.employee_band ?? '—'} />
          <FootprintTile
            label="Industry"
            value={firmographics!.industry_naics ?? firmographics!.industry_sic ?? brand.sector ?? '—'}
          />
          <FootprintTile
            label={firmographics!.is_public ? 'Public' : 'Status'}
            value={firmographics!.ticker ?? (firmographics!.is_public ? 'Public' : 'Private')}
            sub={firmographics!.founded_year ? `Founded ${firmographics!.founded_year}` : undefined}
          />
        </div>
      )}
      {firmographics?.parent_company && (
        <div className="mt-3 text-[11px] text-[var(--text-tertiary)] font-mono">
          Parent: <span className="text-[var(--text-secondary)]">{firmographics.parent_company}</span>
        </div>
      )}
    </Card>
  );
}

function FootprintTile({
  label, value, sub, mono, onClick,
}: {
  label: string; value: string; sub?: string; mono?: boolean; onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={onClick ? 'cursor-pointer hover:bg-white/[0.02] transition-colors' : ''}
      style={{
        padding: 12, borderRadius: 8,
        border: '1px solid var(--border-base)',
        background: 'var(--bg-input)',
      }}
    >
      <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-[var(--text-muted)]">{label}</div>
      <div className={`mt-1 text-sm ${mono ? 'font-mono' : 'font-semibold'} text-[var(--text-primary)]`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">{sub}</div>}
    </div>
  );
}

function RollupTile({
  label, count, tone = 'neutral', onClick,
}: {
  label: string; count: number; tone?: 'neutral' | 'warn' | 'crit'; onClick?: () => void;
}) {
  const color = tone === 'crit' ? 'var(--sev-critical)' : tone === 'warn' ? 'var(--sev-medium)' : 'var(--text-secondary)';
  return (
    <div
      onClick={onClick}
      className={onClick ? 'cursor-pointer hover:bg-white/[0.02] transition-colors' : ''}
      style={{ padding: 12, borderRadius: 8, border: '1px solid var(--border-base)', background: 'var(--bg-input)' }}
    >
      <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-bold" style={{ color }}>{count}</div>
    </div>
  );
}

function TakedownRow({ takedown }: { takedown: any }) {
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 6,
      border: '1px solid var(--border-base)', background: 'var(--bg-input)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    }}>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-mono text-[var(--text-primary)] truncate">{takedown.target_value}</div>
        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
          {takedown.target_type} · {takedown.provider_name || 'no provider'} · {takedown.severity}
        </div>
      </div>
      <Badge variant={takedown.status === 'pending' ? 'medium' : 'default'}>{takedown.status}</Badge>
    </div>
  );
}

function AlertRow({ alert }: { alert: any }) {
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 6,
      border: '1px solid var(--border-base)', background: 'var(--bg-input)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    }}>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-[var(--text-primary)] truncate">{alert.title || alert.alert_type}</div>
        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
          {alert.alert_type} · {alert.severity}
        </div>
      </div>
      <Badge variant={alert.severity === 'critical' ? 'critical' : alert.severity === 'high' ? 'high' : 'default'}>
        {alert.status}
      </Badge>
    </div>
  );
}
