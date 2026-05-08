import { useParams, useNavigate } from 'react-router-dom';
import { useCampaignDetail, useCampaignTimeline } from '@/hooks/useCampaigns';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { ThreatAreaChart } from '@/components/ui/ThreatAreaChart';

export function CampaignDetail() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const { data: campaign, isLoading } = useCampaignDetail(campaignId || '');
  const { data: timeline, isLoading: timelineLoading } = useCampaignTimeline(campaignId || '', '30d');

  if (isLoading) {
    return (
      <div className="animate-fade-in space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  const chartData = timeline
    ? timeline.labels.map((label, i) => ({
        label: label.length >= 10 ? label.slice(5, 10) : label,
        value: timeline.values[i] ?? 0,
      }))
    : [];

  return (
    <div className="animate-fade-in space-y-6">
      <button onClick={() => navigate('/campaigns')} className="font-mono text-xs text-[rgba(255,255,255,0.30)] hover:text-accent transition-colors">
        &larr; Back to Operations
      </button>
      <Card hover={false}>
        <h1 className="font-display text-xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>
          {campaign?.name || 'Campaign'}
        </h1>
        <p className="text-sm text-[rgba(255,255,255,0.36)]">Detail view coming soon</p>
      </Card>

      <Card hover={false} style={{ padding: '16px' }}>
        <div style={{
          fontSize: 9,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.20em',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          marginBottom: 12,
        }}>
          Attack Timeline
        </div>
        {timelineLoading ? (
          <Skeleton className="h-[220px] w-full rounded-lg" />
        ) : chartData.length > 0 ? (
          <ThreatAreaChart
            data={chartData}
            height={220}
            color="var(--red)"
            label="Threats"
            showYAxis
          />
        ) : (
          <div className="h-[220px] flex items-center justify-center font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            No timeline data
          </div>
        )}
      </Card>
    </div>
  );
}
