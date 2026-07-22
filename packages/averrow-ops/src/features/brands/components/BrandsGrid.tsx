import { useState, useMemo, useCallback, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useBrands, useBrandStats, useToggleMonitor, useAddBrand } from '@/hooks/useBrands';
import type { Brand } from '@/hooks/useBrands';
import { LiveFeedCard } from './LiveFeedCard';
import { PortfolioHealthCard } from './PortfolioHealthCard';
import { AttackVectorsCard } from './AttackVectorsCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { CardGridLoader } from '@/components/ui/PageLoader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { Search, Shield } from 'lucide-react';
import {
  DeepCard,
  GlowNumber,
  TrendSparkline,
} from '@/components/ui';

/* ─── Severity helpers (card grid) ─── */

// Severity based on threat count
function cardSeverity(count: number): 'critical' | 'high' | 'medium' | 'low' {
  if (count > 2000) return 'critical';
  if (count > 500)  return 'high';
  if (count > 100)  return 'medium';
  return 'low';
}

// Accent color per severity
function severityAccent(sev: string): string {
  switch (sev) {
    case 'critical': return '#E24B4A';
    case 'high':     return '#BA7517';
    case 'medium':   return '#E5A832';
    default:         return '#639922';
  }
}

// Email/exposure grade → color
function gradeStyle(grade: string | null): {
  bg: string; color: string; border: string;
} {
  if (!grade) return { bg: 'var(--border-base)', color: 'var(--text-tertiary)', border: 'var(--border-base)' };
  const g = grade.replace('+', '').replace('-', '');
  if (g === 'A')  return { bg: 'rgba(99,153,34,0.15)',   color: '#97C459', border: 'rgba(99,153,34,0.35)' };
  if (g === 'B')  return { bg: 'rgba(229,168,50,0.12)',  color: '#E5A832', border: 'rgba(229,168,50,0.30)' };
  if (g === 'C')  return { bg: 'rgba(186,117,23,0.12)',  color: '#EF9F27', border: 'rgba(186,117,23,0.30)' };
  if (g === 'D')  return { bg: 'rgba(226,75,74,0.12)',   color: '#F09595', border: 'rgba(226,75,74,0.30)' };
  return             { bg: 'rgba(226,75,74,0.18)',   color: '#E24B4A', border: 'rgba(226,75,74,0.40)' };
}

// Social risk score → label + color
function socialRisk(score: number | null): { label: string; color: string } | null {
  if (score == null) return null;
  if (score >= 70) return { label: 'High',   color: '#E24B4A' };
  if (score >= 40) return { label: 'Med',    color: '#BA7517' };
  return              { label: 'Low',    color: '#639922' };
}

/* ─── Constants ─── */

const SECTORS = [
  'All Sectors',
  'Technology',
  'Financial Services',
  'Healthcare',
  'Retail',
  'Cryptocurrency',
  'Government',
  'Media',
  'Other',
] as const;

const GRADE_STYLES: Record<string, string> = {
  'A+': 'bg-green-900/40 text-green-400 border-green-500/30',
  A: 'bg-green-900/40 text-green-400 border-green-500/30',
  B: 'bg-blue-900/40 text-blue-400 border-blue-500/30',
  C: 'bg-amber-900/40 text-amber-400 border-amber-500/30',
  D: 'bg-orange-900/40 text-orange-400 border-orange-500/30',
  F: 'bg-red-900/40 text-red-400 border-red-500/30',
};

const THREAT_TYPE_STYLES: Record<string, string> = {
  phishing: 'text-[var(--text-secondary)] border-contrail/30',
  typosquat: 'text-yellow-400 border-yellow-400/30',
  malware: 'text-amber-400 border-amber-400/30',
  c2: 'text-red-400 border-red-400/30',
  credential: 'text-orange-400 border-orange-400/30',
  social: 'text-[#E5A832] border-afterburner-border',
};

const PAGE_SIZE = 50;

/* ─── Helpers ─── */

function threatColor(count: number): string {
  if (count >= 200) return 'text-[#f87171]';
  if (count >= 100) return 'text-[#fb923c]';
  if (count >= 50) return 'text-[#fbbf24]';
  return 'text-[#78A0C8]';
}

function threatTypePill(type: string | null) {
  if (!type) return null;
  const key = type.toLowerCase().replace(/[_\s]/g, '');
  const style = THREAT_TYPE_STYLES[key] ?? 'text-white/50 border-white/20';
  return (
    <span className={cn('text-[10px] font-mono px-2 py-0.5 rounded border', style)}>
      {type.replace(/_/g, ' ')}
    </span>
  );
}

function gradeBadge(grade: string | null) {
  if (!grade) return <span className="text-white/20 font-mono text-[10px]">&mdash;</span>;
  const g = grade.toUpperCase();
  const style = GRADE_STYLES[g] ?? GRADE_STYLES['F'];
  return (
    <span className={cn('text-[10px] font-mono font-bold px-2 py-0.5 rounded border', style)}>
      {g}
    </span>
  );
}

function rankBadge(rank: number) {
  let style = 'border-white/10 text-white/40';
  if (rank === 1) style = 'border-yellow-400 text-yellow-400';
  else if (rank === 2) style = 'border-slate-300 text-slate-300';
  else if (rank === 3) style = 'border-amber-600 text-amber-600';
  return (
    <span className={cn('w-6 h-6 rounded-full border text-[10px] font-mono flex items-center justify-center flex-shrink-0', style)}>
      {rank}
    </span>
  );
}

function monitorStatus(brand: Brand): { label: string; style: string } {
  if (brand.threat_count > 0) {
    return { label: 'ACTIVE', style: 'bg-red-900/40 text-red-400 border-red-500/30' };
  }
  if (brand.created_at) {
    const days = Math.floor((Date.now() - new Date(brand.created_at).getTime()) / 86400000);
    if (days < 7) {
      return { label: 'NEW', style: 'bg-blue-900/40 text-blue-400 border-blue-500/30' };
    }
  }
  return { label: 'CLEAN', style: 'bg-green-900/40 text-green-400 border-green-500/30' };
}

function daysAgo(dateStr: string | null): string {
  if (!dateStr) return '—';
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function useDebounce(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/* ─── Star Toggle ─── */

function StarToggle({ brand, className }: { brand: Brand; className?: string }) {
  const toggleMonitor = useToggleMonitor();
  const isMonitored = brand.monitored ?? false;

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggleMonitor.mutate(brand.id);
      }}
      className={cn(
        'transition-colors',
        isMonitored ? 'text-yellow-400' : 'text-white/20 hover:text-yellow-400',
        className,
      )}
      aria-label={isMonitored ? 'Unmonitor brand' : 'Monitor brand'}
    >
      {isMonitored ? (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
        </svg>
      )}
    </button>
  );
}

/* ─── Add Brand Modal ─── */

function AddBrandModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { showToast } = useToast();
  const addBrand = useAddBrand();
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [sector, setSector] = useState('Auto-detect');
  const [reason, setReason] = useState('Client Brand');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = useCallback(() => {
    let cleanDomain = domain.trim();
    cleanDomain = cleanDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!cleanDomain.includes('.')) {
      setError('Domain must contain a dot (e.g. example.com)');
      return;
    }
    setError('');
    addBrand.mutate(
      {
        domain: cleanDomain,
        name: name.trim() || undefined,
        sector: sector === 'Auto-detect' ? undefined : sector,
        reason,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          showToast('Brand added for monitoring', 'success');
          onClose();
          setDomain('');
          setName('');
          setSector('Auto-detect');
          setReason('Client Brand');
          setNotes('');
        },
        onError: (err) => {
          showToast(err instanceof Error ? err.message : 'Failed to add brand', 'error');
        },
      },
    );
  }, [domain, name, sector, reason, notes, addBrand, showToast, onClose]);

  if (!open) return null;

  const inputClass = 'w-full rounded-lg px-3 py-2 font-mono text-sm';
  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-base)',
    color: 'var(--text-primary)',
    outline: 'none',
  };
  const labelClass = 'block font-mono text-[10px] uppercase tracking-widest text-[var(--text-tertiary)] mb-1.5';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl p-6 shadow-2xl" style={{ background:'var(--bg-card)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid var(--border-base)', borderRadius:'0.75rem', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)' }}>
        <h2 className="font-display text-lg font-bold mb-5" style={{ color:'var(--text-primary)' }}>Monitor Brand</h2>

        <div className="space-y-4">
          <div>
            <label className={labelClass}>Domain *</label>
            <input
              className={inputClass}
              style={inputStyle}
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
            {error && <p className="mt-1 font-mono text-[10px] text-red-400">{error}</p>}
          </div>

          <div>
            <label className={labelClass}>Brand Name</label>
            <input
              className={inputClass}
              style={inputStyle}
              placeholder="Auto-detected from domain"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className={labelClass}>Sector</label>
            <select
              className={inputClass}
              style={inputStyle}
              value={sector}
              onChange={(e) => setSector(e.target.value)}
            >
              <option>Auto-detect</option>
              {SECTORS.slice(1).map(s => <option key={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className={labelClass}>Reason</label>
            <select
              className={inputClass}
              style={inputStyle}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {['Client Brand', 'Competitor', 'Prospect', 'Partner', 'Threat Intel'].map(r => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Notes</label>
            <textarea
              className={cn(inputClass, 'resize-none h-20')}
              style={inputStyle}
              placeholder="Optional notes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="font-mono text-[11px] font-semibold uppercase tracking-wider px-4 py-2 rounded-lg border border-white/10 text-[var(--text-tertiary)] hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={addBrand.isPending}
            className="font-mono text-[11px] font-semibold uppercase tracking-wider px-4 py-2 rounded-lg border border-afterburner-border hover:bg-afterburner-muted transition-colors disabled:opacity-50"
            style={{ color: 'var(--amber)' }}
          >
            {addBrand.isPending ? 'Adding...' : 'Monitor Brand'}
          </button>
        </div>
      </div>
    </div>
  );
}


/* ─── Favicon Avatar ─── */

function FaviconAvatar({
  name,
  faviconUrl,
  size = 38,
}: {
  name:        string;
  domain?:     string | null;
  faviconUrl?: string;
  size?:       number;
}) {
  const [failed, setFailed] = useState(false);
  const radius = Math.round(size * 0.26);

  return (
    <div style={{
      width:          size,
      height:         size,
      borderRadius:   radius,
      background:     'linear-gradient(145deg, var(--bg-elevated), var(--bg-card-deep))',
      border:         '1px solid var(--border-base)',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      overflow:       'hidden',
      flexShrink:     0,
    }}>
      {faviconUrl && !failed ? (
        <img
          src={faviconUrl}
          width={Math.round(size * 0.60)}
          height={Math.round(size * 0.60)}
          alt={name}
          onError={() => setFailed(true)}
          style={{ borderRadius: 3, display: 'block' }}
        />
      ) : (
        <span style={{
          fontSize:   Math.round(size * 0.37),
          fontWeight: 900,
          color:      'var(--text-secondary)',
        }}>
          {(name[0] ?? '?').toUpperCase()}
        </span>
      )}
    </div>
  );
}

/* ─── Brand Card ─── */

function BrandCard({
  brand,
}: {
  brand: Brand;
  onToggleMonitor: (id: string) => void;
}) {
  const tc        = brand.threat_count ?? 0;
  const sev       = cardSeverity(tc);
  const accent    = severityAccent(sev);
  const emailG    = gradeStyle(brand.email_security_grade);
  const exposureG = gradeStyle(
    brand.exposure_score != null
      ? (brand.exposure_score >= 80 ? 'A'
       : brand.exposure_score >= 60 ? 'B'
       : brand.exposure_score >= 40 ? 'C'
       : brand.exposure_score >= 20 ? 'D' : 'F')
      : null
  );
  const social   = socialRisk(brand.social_risk_score ?? null);
  const faviconUrl =
    brand.logo_url ??
    (brand.canonical_domain
      ? `https://www.google.com/s2/favicons?domain=${brand.canonical_domain}&sz=32`
      : undefined);

  // Sparkline from threat_history (array of daily counts)
  const sparkData: number[] = Array.isArray(brand.threat_history)
    ? brand.threat_history.slice(-14)
    : [];

  return (
    // <Link> instead of <div onClick> — keyboard nav, middle-click new
    // tab, and screen readers all work for free. Audit H1.
    <Link
      to={`/brands/${brand.id}`}
      style={{
        background:   'linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep) 100%)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border:       `1px solid var(--border-base)`,
        borderLeft:   `3px solid ${accent}`,
        borderRadius: 'var(--card-radius)',
        padding:      '14px 16px',
        cursor:       'pointer',
        position:     'relative',
        overflow:     'hidden',
        transition:   'var(--transition-fast)',
        boxShadow:    'var(--card-shadow), inset 0 1px 0 var(--border-strong)',
        textDecoration: 'none',
        color:        'inherit',
        display:      'block',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = `${accent}60`;
        (e.currentTarget as HTMLAnchorElement).style.boxShadow =
          `var(--card-shadow), inset 0 1px 0 var(--border-strong), 0 0 20px ${accent}12`;
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--border-base)';
        (e.currentTarget as HTMLAnchorElement).style.borderLeftColor = accent;
        (e.currentTarget as HTMLAnchorElement).style.boxShadow =
          'var(--card-shadow), inset 0 1px 0 var(--border-strong)';
      }}
    >
      {/* ── HEADER: favicon + name + threat count ─────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>

        {/* Favicon with severity dot */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <FaviconAvatar
            name={brand.name}
            domain={brand.canonical_domain}
            faviconUrl={faviconUrl}
            size={38}
          />
          <div style={{
            position:     'absolute',
            bottom:       -2,
            right:        -2,
            width:        10,
            height:       10,
            borderRadius: '50%',
            background:   accent,
            border:       '2px solid var(--bg-page)',
            boxShadow:    `0 0 6px ${accent}80`,
          }} />
        </div>

        {/* Name + domain */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize:    14,
            fontWeight:  700,
            color:       'var(--text-primary)',
            whiteSpace:  'nowrap',
            overflow:    'hidden',
            textOverflow:'ellipsis',
          }}>
            {brand.name}
          </div>
          <div style={{
            fontSize:    11,
            color:       'var(--text-muted)',
            fontFamily:  'var(--font-mono)',
            marginTop:   2,
          }}>
            {brand.canonical_domain ?? '—'}
          </div>
        </div>

        {/* Threat count */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{
            fontSize:    20,
            fontWeight:  900,
            fontFamily:  'var(--font-mono)',
            color:       accent,
            lineHeight:  1,
            textShadow:  `0 0 16px ${accent}60`,
          }}>
            {tc.toLocaleString()}
          </div>
          <div style={{
            fontSize:    9,
            color:       'var(--text-muted)',
            fontFamily:  'var(--font-mono)',
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            marginTop:   2,
          }}>
            threats · all-time
          </div>
        </div>
      </div>

      {/* ── METRIC TILES ─────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 7, marginBottom: 10 }}>

        {/* Exposure */}
        <div style={{
          flex: 1,
          background: 'var(--border-base)',
          borderRadius: 8,
          padding: '7px 8px',
          textAlign: 'center',
          border: '1px solid var(--border-base)',
        }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.14em', color: 'var(--text-muted)',
            textTransform: 'uppercase', marginBottom: 5,
          }}>
            Exposure
          </div>
          {brand.exposure_score != null ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
              <div style={{
                width: 26, height: 26, borderRadius: 6, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 800, fontFamily: 'var(--font-mono)',
                background: exposureG.bg, color: exposureG.color,
                border: `1px solid ${exposureG.border}`,
              }}>
                {brand.exposure_score >= 80 ? 'A'
                : brand.exposure_score >= 60 ? 'B'
                : brand.exposure_score >= 40 ? 'C'
                : brand.exposure_score >= 20 ? 'D' : 'F'}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                {brand.exposure_score}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>—</div>
          )}
        </div>

        {/* Email grade */}
        <div style={{
          flex: 1,
          background: 'var(--border-base)',
          borderRadius: 8,
          padding: '7px 8px',
          textAlign: 'center',
          border: '1px solid var(--border-base)',
        }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.14em', color: 'var(--text-muted)',
            textTransform: 'uppercase', marginBottom: 5,
          }}>
            Email
          </div>
          {brand.email_security_grade ? (
            <div style={{
              width: 26, height: 26, borderRadius: 6, margin: '0 auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 800, fontFamily: 'var(--font-mono)',
              background: emailG.bg, color: emailG.color,
              border: `1px solid ${emailG.border}`,
            }}>
              {brand.email_security_grade}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>—</div>
          )}
        </div>

        {/* Social risk */}
        <div style={{
          flex: 1,
          background: 'var(--border-base)',
          borderRadius: 8,
          padding: '7px 8px',
          textAlign: 'center',
          border: '1px solid var(--border-base)',
        }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.14em', color: 'var(--text-muted)',
            textTransform: 'uppercase', marginBottom: 5,
          }}>
            Social
          </div>
          {social ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 4 }}>
              <div style={{
                width: 7, height: 7, borderRadius: '50%',
                background: social.color, flexShrink: 0,
                boxShadow: `0 0 6px ${social.color}`,
              }} />
              <span style={{ fontSize: 12, color: social.color, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                {social.label}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>—</div>
          )}
        </div>
      </div>

      {/* ── SPARKLINE ────────────────────────────────────────── */}
      {sparkData.length > 1 ? (
        <div style={{ position: 'relative' }}>
          <TrendSparkline
            data={sparkData}
            fill
            height={36}
            color={accent}
            animate={false}
          />
          <span style={{
            position: 'absolute', bottom: 2, right: 4,
            fontSize: 8, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)', letterSpacing: '0.10em',
            opacity: 0.6,
          }}>14d</span>
        </div>
      ) : (
        <div style={{
          height: 36,
          background: 'var(--border-base)',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            no trend data
          </span>
        </div>
      )}
    </Link>
  );
}

/* ─── Main Page ─── */


// BrandsGrid — extracted from the now-deleted v2 Brands.tsx as part
// of the v2 brands decommission. The grid itself (search + sector
// filter + monitored/all/targeted tab + paginated brand-card layout)
// stays useful for the v3 list's "All Brands" tab. This component
// has no page-level chrome (title, version toggle, hero stats) —
// the v3 list shell owns those.

export function BrandsGrid({ initialQuery = '' }: { initialQuery?: string }) {
  const navigate = useNavigate();

  /* ─── Shared filter state ─── */
  // Seeded from the v3 list's ?q= deep-link (command palette "view all" /
  // Tier-2) — see Brands.tsx. Debounced the same way manual typing is.
  const [search, setSearch] = useState(initialQuery);
  const [sector, setSector] = useState('all');
  const [activeTab, setActiveTab] = useState<'all' | 'monitored' | 'targeted'>('all');
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const debouncedSearch = useDebounce(search, 300);

  const { data: brands = [], isLoading } = useBrands({ view: 'all', timeRange: '7d', search: debouncedSearch });
  // useBrandStats hits `/api/brands/stats` (KV-cached 5 min on the
  // backend) so the catalog-wide total renders "for free" — it
  // gives users the honest "Showing X of Y in catalog" framing
  // even though the list itself is capped at 500 per request.
  const { data: brandStats } = useBrandStats();
  const toggleMonitor = useToggleMonitor();

  const filteredBrands = useMemo(() => {
    return (brands ?? []).filter(b => {
      const matchSearch = !debouncedSearch ||
        b.name?.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
        b.canonical_domain?.toLowerCase().includes(debouncedSearch.toLowerCase());
      const matchSector = sector === 'all' || b.sector === sector;
      const matchTab = activeTab === 'all' ? true
        : activeTab === 'monitored' ? b.monitored
        : (b.threat_count ?? 0) > 0;
      return matchSearch && matchSector && matchTab;
    });
  }, [brands, debouncedSearch, sector, activeTab]);

  const totalPages = Math.ceil(filteredBrands.length / PAGE_SIZE);
  const pagedBrands = filteredBrands.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const showFrom = filteredBrands.length > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const showTo = Math.min(page * PAGE_SIZE, filteredBrands.length);

  const handleToggleMonitor = useCallback((id: string) => {
    toggleMonitor.mutate(id);
  }, [toggleMonitor]);

  const pageNumbers = useMemo(() => {
    const pages: (number | 'ellipsis')[] = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push('ellipsis');
      for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
      if (page < totalPages - 2) pages.push('ellipsis');
      pages.push(totalPages);
    }
    return pages;
  }, [page, totalPages]);

  return (
    <div className="animate-fade-in">
      {/* Add Brand button alone, top-right — primary action stays
          available without competing with the v3 list shell header. */}
      <div className="flex justify-end mb-3">
        <button
          onClick={() => setModalOpen(true)}
          className="font-mono text-[11px] font-semibold uppercase tracking-wider px-3 sm:px-4 py-1.5 rounded-lg border border-afterburner-border hover:bg-afterburner-muted transition-colors whitespace-nowrap"
          style={{ color: 'var(--amber)' }}
        >
          <span className="hidden sm:inline">+ Monitor Brand</span>
          <span className="sm:hidden">+ Brand</span>
        </button>
      </div>

      {/* View content */}
      {isLoading ? (
        <CardGridLoader count={12} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4 mt-4">
          {/* Left: filter bar + brand rows */}
          <div className="min-w-0">
            {/* Filter bar */}
            <DeepCard variant="base" style={{ padding: '10px 16px', marginBottom: 12 }}>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <input
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search brands or domains..."
                className="flex-1 rounded-lg px-3 py-1.5 text-sm min-w-0"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-base)',
                  color: 'var(--text-primary)',
                  outline: 'none',
                }}
              />
              <div className="flex gap-2 overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
                <select
                  className="rounded-lg px-3 py-1.5 font-mono text-xs flex-shrink-0"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-base)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                  }}
                  value={sector}
                  onChange={(e) => { setSector(e.target.value); setPage(1); }}
                >
                  <option value="all">All Sectors</option>
                  {SECTORS.slice(1).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <div className="flex gap-1 flex-shrink-0">
                  {(['all', 'monitored', 'targeted'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => { setActiveTab(tab); setPage(1); }}
                      className={cn(
                        'px-3 py-1.5 text-[10px] font-mono tracking-wider capitalize rounded-lg border transition-colors whitespace-nowrap',
                        activeTab === tab
                          ? 'text-[#E5A832] border-afterburner-border bg-afterburner-muted'
                          : 'text-white/50 border-white/10 hover:text-white/70'
                      )}
                    >
                      {tab === 'targeted' ? 'Top Threatened' : tab}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            </DeepCard>

            {/* Brand card grid */}
            {pagedBrands.length > 0 ? (
              <div style={{
                display:             'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                gap:                 12,
              }}>
                {pagedBrands.map(brand => (
                  <BrandCard
                    key={brand.id}
                    brand={brand}
                    onToggleMonitor={handleToggleMonitor}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={(brands ?? []).length === 0 ? <Shield /> : <Search />}
                title={(brands ?? []).length === 0 ? 'No brands monitored yet' : 'No brands match your search'}
                subtitle={(brands ?? []).length === 0
                  ? 'Add your first brand to start tracking threats, typosquats, and email security posture'
                  : `Try a different name or domain — you're monitoring ${(brands ?? []).length} brands`}
                action={(brands ?? []).length === 0
                  ? { label: 'Monitor new brand', onClick: () => setModalOpen(true) }
                  : { label: 'Clear search', onClick: () => { setSearch(''); setPage(1); } }}
                variant={(brands ?? []).length === 0 ? 'scanning' : 'clean'}
                compact
              />
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pt-3">
                <span className="font-mono text-[11px] text-white/40">
                  Showing {showFrom}&ndash;{showTo} of {filteredBrands.length.toLocaleString()}
                  {brandStats?.total_tracked && brandStats.total_tracked > filteredBrands.length ? (
                    <> &middot; <span className="text-white/30">{brandStats.total_tracked.toLocaleString()} in catalog</span></>
                  ) : null}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="font-mono text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/40 hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
                  >
                    Prev
                  </button>
                  {pageNumbers.map((p, i) =>
                    p === 'ellipsis' ? (
                      <span key={`e${i}`} className="font-mono text-[11px] text-white/30 px-1">&hellip;</span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        className={cn(
                          'font-mono text-[11px] px-2.5 py-1 rounded border transition-colors',
                          page === p
                            ? 'border-afterburner text-[#E5A832]'
                            : 'border-white/10 text-white/40 hover:text-[var(--text-primary)]',
                        )}
                      >
                        {p}
                      </button>
                    ),
                  )}
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="font-mono text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/40 hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right: sticky sidebar */}
          <div className="flex flex-col gap-3 sticky top-4 self-start">
            <LiveFeedCard />
            <PortfolioHealthCard brands={filteredBrands} />
            <AttackVectorsCard brands={filteredBrands} />
          </div>
        </div>
      )}

      <AddBrandModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
