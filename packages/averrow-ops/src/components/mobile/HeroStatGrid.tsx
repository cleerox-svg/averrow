interface HeroStat {
  label: string;
  value: string;
  subtitle?: string;
  color: string;
}

interface HeroStatGridProps {
  stats: HeroStat[];
  cols?: 2 | 3;
}

export function HeroStatGrid({ stats, cols = 2 }: HeroStatGridProps) {
  const gridCols = cols === 3 ? 'grid-cols-3' : 'grid-cols-2';

  return (
    <div className={`grid ${gridCols} gap-2`}>
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-[10px] border border-bulkhead/40 bg-instrument p-3"
        >
          <span className="text-[8px] font-mono uppercase tracking-widest text-white/55">
            {stat.label}
          </span>
          <div
            className="mt-1 text-2xl font-extrabold leading-none"
            style={{ color: stat.color }}
          >
            {stat.value}
          </div>
          {stat.subtitle && (
            <span className="mt-0.5 block text-[10px] text-white/55">
              {stat.subtitle}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
