import type { Brand } from '@/hooks/useBrands';

interface PortfolioHealthCardProps {
  brands: Brand[];
}

const CIRCUMFERENCE = 2 * Math.PI * 30; // ~188.5
const GAP = 2;

interface Segment {
  label: string;
  count: number;
  color: string;
}

export function PortfolioHealthCard({ brands }: PortfolioHealthCardProps) {
  const critical = brands.filter(
    (b) => (b.exposure_score ?? 100) < 40 || (b.threat_count ?? 0) >= 200,
  ).length;
  const high = brands.filter(
    (b) =>
      !((b.exposure_score ?? 100) < 40 || (b.threat_count ?? 0) >= 200) &&
      (((b.exposure_score ?? 100) >= 40 && (b.exposure_score ?? 100) < 60) ||
        ((b.threat_count ?? 0) >= 100 && (b.threat_count ?? 0) < 200)),
  ).length;
  const medium = brands.filter(
    (b) =>
      !((b.exposure_score ?? 100) < 40 || (b.threat_count ?? 0) >= 200) &&
      !(
        ((b.exposure_score ?? 100) >= 40 && (b.exposure_score ?? 100) < 60) ||
        ((b.threat_count ?? 0) >= 100 && (b.threat_count ?? 0) < 200)
      ) &&
      (((b.exposure_score ?? 100) >= 60 && (b.exposure_score ?? 100) < 80) ||
        ((b.threat_count ?? 0) >= 50 && (b.threat_count ?? 0) < 100)),
  ).length;
  const clean = brands.filter((b) => (b.threat_count ?? 0) === 0).length;

  const total = brands.length;
  const segments: Segment[] = [
    { label: 'Critical', count: critical, color: '#f87171' },
    { label: 'High', count: high, color: '#fb923c' },
    { label: 'Medium', count: medium, color: '#fbbf24' },
    { label: 'Clean', count: clean, color: '#4ade80' },
  ];

  const activeSegments = segments.filter((s) => s.count > 0);
  const totalGap = activeSegments.length * GAP;
  const usable = CIRCUMFERENCE - totalGap;

  let offset = 0;
  const arcs = activeSegments.map((seg) => {
    const len = (seg.count / total) * usable;
    const arc = { ...seg, len, offset };
    offset += len + GAP;
    return arc;
  });

  return (
    <div className="rounded-xl glass-card glass-card-amber p-4">
      <div className="mb-3 font-mono text-[9px] uppercase tracking-widest text-contrail/70">
        Portfolio Health
      </div>

      <div className="flex items-center justify-center">
        <svg viewBox="0 0 80 80" className="h-20 w-20">
          {total === 0 ? (
            <circle
              cx={40}
              cy={40}
              r={30}
              fill="none"
              stroke="currentColor"
              strokeWidth={10}
              className="text-white/10"
            />
          ) : (
            arcs.map((arc) => (
              <circle
                key={arc.label}
                cx={40}
                cy={40}
                r={30}
                fill="none"
                stroke={arc.color}
                strokeWidth={10}
                strokeDasharray={`${arc.len} ${CIRCUMFERENCE}`}
                strokeDashoffset={-arc.offset}
                strokeLinecap="round"
                className="origin-center -rotate-90"
                style={{ transformOrigin: '40px 40px' }}
              />
            ))
          )}
          <text
            x={40}
            y={40}
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-white text-[13px] font-bold"
          >
            {total}
          </text>
        </svg>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        {segments.map((seg) => {
          const pct = total > 0 ? ((seg.count / total) * 100).toFixed(0) : '0';
          return (
            <div key={seg.label} className="flex items-center gap-2 py-0.5">
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: seg.color }}
              />
              <span className="flex-1 font-mono text-[10px] text-white/60">{seg.label}</span>
              <span
                className={`font-mono text-[10px] ${seg.count > 0 ? 'text-white/80' : 'text-white/40'}`}
              >
                {seg.count}
              </span>
              <span className="w-10 text-right font-mono text-[9px] text-white/50">({pct}%)</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
