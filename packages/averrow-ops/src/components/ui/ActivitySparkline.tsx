interface Props {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}

export function ActivitySparkline({ data, color, width = 120, height = 24 }: Props) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data, 1);
  const barWidth = width / data.length;

  return (
    <svg width={width} height={height} className="overflow-visible">
      {data.map((val, i) => {
        const barHeight = (val / max) * height;
        return (
          <rect
            key={i}
            x={i * barWidth}
            y={height - barHeight}
            width={Math.max(barWidth - 1, 1)}
            height={barHeight}
            fill={val > 0 ? color : 'rgba(255,255,255,0.05)'}
            rx={1}
            opacity={val > 0 ? 0.8 : 0.3}
          />
        );
      })}
    </svg>
  );
}
