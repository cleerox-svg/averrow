interface ThreatSummary {
  type: string;
  count: number;
  label: string;
  color: string;
}

export function ThreatSummaryCards({ threats }: { threats: any[] }) {
  // Aggregate by type
  const typeCounts: Record<string, number> = {};
  threats.forEach(t => {
    const type = t.threat_type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });

  const typeConfig: Record<string, { label: string; color: string }> = {
    phishing: { label: 'Phishing', color: '#C83C3C' },
    malware_distribution: { label: 'Malware', color: '#E8923C' },
    typosquatting: { label: 'Typosquat', color: '#DCAA32' },
    credential_harvesting: { label: 'Credential', color: '#C85078' },
    impersonation: { label: 'Impersonation', color: '#7850C8' },
    c2: { label: 'C2', color: '#78A0C8' },
  };

  const cards: ThreatSummary[] = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([type, count]) => ({
      type,
      count,
      label: typeConfig[type]?.label || type.replace(/_/g, ' '),
      color: typeConfig[type]?.color || '#78A0C8',
    }));

  // Auto-size the grid to the actual number of cards so 2 cards
  // don't render in a 4-column grid leaving 50% empty (the alignment
  // bug visible on docusign.net where only phishing+malware exist).
  // Cap at 4 columns to keep the row tidy on wide screens.
  const colsClass =
    cards.length >= 4 ? 'grid-cols-2 lg:grid-cols-4'
    : cards.length === 3 ? 'grid-cols-3'
    : cards.length === 2 ? 'grid-cols-2'
    : 'grid-cols-1';

  if (cards.length === 0) {
    return (
      <div className="bg-instrument border border-white/[0.06] rounded-lg p-6 text-center">
        <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          No active threats
        </div>
      </div>
    );
  }

  return (
    <div className={`grid ${colsClass} gap-3`}>
      {cards.map(card => (
        <div key={card.type}
          className="bg-instrument border border-white/[0.06] rounded-lg p-4 transition-all hover:border-white/10"
          style={{ borderTopWidth: '3px', borderTopColor: card.color }}
        >
          <div className="font-display text-2xl font-extrabold" style={{ color: card.color }}>{card.count}</div>
          <div className="font-mono text-[10px] uppercase tracking-wider mt-1" style={{ color: 'var(--text-secondary)' }}>{card.label}</div>
        </div>
      ))}
    </div>
  );
}
