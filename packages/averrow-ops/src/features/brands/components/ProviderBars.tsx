export function ProviderBars({ providers }: { providers: any[] }) {
  if (!providers.length) return (
    <div className="text-white/40 text-xs py-4">No provider data yet</div>
  );

  const maxCount = Math.max(...providers.map(p => p.count || p.threat_count || 0), 1);
  const colors = ['#C83C3C', '#E8923C', '#78A0C8', '#28A050', '#DCAA32', '#5A80A8'];

  return (
    <div className="space-y-2.5">
      {providers.slice(0, 6).map((p, i) => {
        const count = p.count || p.threat_count || 0;
        const pct = Math.round((count / maxCount) * 100);
        return (
          <div key={p.name || p.provider_name || i}>
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{p.name || p.provider_name}</span>
              <span className="font-mono text-xs font-bold" style={{ color: colors[i] || colors[5] }}>{count}</span>
            </div>
            <div className="w-full h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${pct}%`, background: colors[i] || colors[5] }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
