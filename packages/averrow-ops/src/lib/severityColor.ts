export function severityColor(score: number | null, threatCount?: number): string {
  if (score !== null && score !== undefined) {
    if (score < 40) return '#f87171';
    if (score < 60) return '#fb923c';
    if (score < 80) return '#fbbf24';
    if (score < 90) return '#78A0C8';
    return '#4ade80';
  }
  if (!threatCount || threatCount === 0) return '#4ade80';
  if (threatCount >= 200) return '#f87171';
  if (threatCount >= 100) return '#fb923c';
  if (threatCount >= 50) return '#fbbf24';
  return '#78A0C8';
}

export function severityOpacity(count: number, max: number): number {
  if (max === 0) return 0.35;
  return 0.35 + (count / max) * 0.65;
}

export function threatTypeColor(type: string): string {
  const map: Record<string, string> = {
    phishing: '#78A0C8',
    typosquat: '#fbbf24',
    malware: '#fb923c',
    c2: '#f87171',
    credential: '#f97316',
    social: '#00d4ff',
  };
  return map[type?.toLowerCase()] ?? '#78A0C8';
}
