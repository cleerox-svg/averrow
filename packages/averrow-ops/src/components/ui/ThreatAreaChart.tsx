// Averrow — ThreatAreaChart
// Full-size area chart for page-level threat visualizations.
// Uses recharts. Gradient fill, glowing line, amber/red theme.
// Replaces flat charts in: CampaignDetail, Providers, IRGC timeline.

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';

export interface ThreatDataPoint {
  label:    string;          // x-axis label (date, time, etc.)
  value:    number;          // primary metric
  value2?:  number;          // optional second series
}

export interface ThreatAreaChartProps {
  data:        ThreatDataPoint[];
  height?:     number;        // default 260
  color?:      string;        // primary color, default amber
  color2?:     string;        // second series color
  label?:      string;        // y-axis label
  label2?:     string;
  showGrid?:   boolean;       // default true
  showTooltip?: boolean;      // default true
  showXAxis?:  boolean;       // default true
  showYAxis?:  boolean;       // default false
  className?:  string;
}

const AMBER  = '#E5A832';
const RED    = '#C83C3C';

interface TooltipEntry {
  color: string;
  value: number;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background:   'linear-gradient(160deg, rgba(22,30,48,0.97), rgba(12,18,32,0.99))',
      border:       '1px solid var(--border-strong)',
      borderRadius: 10,
      padding:      '10px 14px',
      boxShadow:    '0 8px 32px rgba(0,0,0,0.70), inset 0 1px 0 rgba(255,255,255,0.09)',
    }}>
      <div style={{
        fontSize: 10, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.14em', color: 'var(--text-muted)',
        marginBottom: 6, textTransform: 'uppercase',
      }}>
        {label}
      </div>
      {payload.map((entry, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 14, fontWeight: 800,
          fontFamily: 'var(--font-mono)',
          color: entry.color,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: entry.color,
            boxShadow: `0 0 8px ${entry.color}`,
          }} />
          {entry.value.toLocaleString()}
        </div>
      ))}
    </div>
  );
}

export function ThreatAreaChart({
  data,
  height       = 260,
  color        = AMBER,
  color2       = RED,
  label,
  label2,
  showGrid     = true,
  showTooltip  = true,
  showXAxis    = true,
  showYAxis    = false,
  className,
}: ThreatAreaChartProps) {
  const hasSecondSeries = data.some(d => d.value2 !== undefined);
  const gradId1 = 'ta-grad-1';
  const gradId2 = 'ta-grad-2';

  return (
    <div className={className} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: showYAxis ? 0 : -20 }}>
          <defs>
            <linearGradient id={gradId1} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.40} />
              <stop offset="95%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
            {hasSecondSeries && (
              <linearGradient id={gradId2} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={color2} stopOpacity={0.30} />
                <stop offset="95%" stopColor={color2} stopOpacity={0.02} />
              </linearGradient>
            )}
          </defs>

          {showGrid && (
            <CartesianGrid
              strokeDasharray="3 6"
              stroke="rgba(255,255,255,0.05)"
              horizontal={true}
              vertical={false}
            />
          )}

          {showXAxis && (
            <XAxis
              dataKey="label"
              tick={{
                fontSize: 9,
                fontFamily: 'var(--font-mono)',
                fill: 'rgba(255,255,255,0.30)',
                letterSpacing: '0.05em',
              }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
          )}

          {showYAxis && (
            <YAxis
              tick={{
                fontSize: 9,
                fontFamily: 'var(--font-mono)',
                fill: 'rgba(255,255,255,0.25)',
              }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)}
            />
          )}

          {showTooltip && <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.10)', strokeWidth: 1 }} />}

          {/* Second series (rendered behind) */}
          {hasSecondSeries && (
            <Area
              type="monotone"
              dataKey="value2"
              name={label2}
              stroke={color2}
              strokeWidth={1.5}
              fill={`url(#${gradId2})`}
              dot={false}
              activeDot={{ r: 4, fill: color2, stroke: 'rgba(0,0,0,0.5)', strokeWidth: 2 }}
            />
          )}

          {/* Primary series */}
          <Area
            type="monotone"
            dataKey="value"
            name={label}
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradId1})`}
            dot={false}
            activeDot={{
              r: 5,
              fill: color,
              stroke: 'rgba(0,0,0,0.6)',
              strokeWidth: 2,
              filter: `drop-shadow(0 0 6px ${color})`,
            }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
