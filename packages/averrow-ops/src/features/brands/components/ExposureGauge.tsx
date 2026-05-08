interface ExposureGaugeProps {
  score: number | null;
  size?: number;
}

export function ExposureGauge({ score, size = 160 }: ExposureGaugeProps) {

  if (score == null) return null;

  const center = size / 2;
  const radius = (size - 14) / 2;
  const circumference = 2 * Math.PI * radius;

  // Three severity zone arcs (each covers 1/3 of the ring)
  const zoneLength = circumference / 3;

  // Score position
  const scoreAngle = (score / 100) * 360 - 90; // -90 to start from top
  const scoreRad = (scoreAngle * Math.PI) / 180;
  const dotX = center + radius * Math.cos(scoreRad);
  const dotY = center + radius * Math.sin(scoreRad);

  // Active color based on score
  const activeColor = score >= 70 ? '#C83C3C' : score >= 40 ? '#E8923C' : '#28A050';
  const grade = score >= 70 ? 'HIGH' : score >= 40 ? 'MODERATE' : 'LOW';

  // Score fill arc
  const fillOffset = circumference * (1 - score / 100);

  // Ambient glow color based on score
  const glowColor =
    score >= 80 ? 'rgba(239, 68, 68, 0.6)' :
    score >= 60 ? 'rgba(249, 115, 22, 0.5)' :
    score >= 40 ? 'rgba(229, 168, 50, 0.4)' :
                  'rgba(59, 130, 246, 0.3)';

  const pulseClass = score >= 80 ? 'gauge-critical' : score >= 60 ? 'gauge-high' : '';

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
        {/* Ambient glow — blur behind the gauge */}
        <div
          className="absolute inset-0 rounded-full blur-xl opacity-30 pointer-events-none"
          style={{ background: glowColor }}
        />
        {/* Gauge SVG — with pulse class */}
        <div className={`relative ${pulseClass}`}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="drop-shadow-lg">
            {/* Background track */}
            <circle cx={center} cy={center} r={radius} fill="none"
              stroke="rgba(255,255,255,0.04)" strokeWidth="8" />

            {/* Green zone (0-33%) */}
            <circle cx={center} cy={center} r={radius} fill="none"
              stroke="#28A050" strokeWidth="8" opacity="0.15"
              strokeDasharray={`${zoneLength} ${circumference - zoneLength}`}
              strokeDashoffset={circumference * 0.25}
              transform={`rotate(-90 ${center} ${center})`} />

            {/* Amber zone (33-66%) */}
            <circle cx={center} cy={center} r={radius} fill="none"
              stroke="#E8923C" strokeWidth="8" opacity="0.15"
              strokeDasharray={`${zoneLength} ${circumference - zoneLength}`}
              strokeDashoffset={circumference * 0.25 - zoneLength}
              transform={`rotate(-90 ${center} ${center})`} />

            {/* Red zone (66-100%) */}
            <circle cx={center} cy={center} r={radius} fill="none"
              stroke="#C83C3C" strokeWidth="8" opacity="0.15"
              strokeDasharray={`${zoneLength} ${circumference - zoneLength}`}
              strokeDashoffset={circumference * 0.25 - zoneLength * 2}
              transform={`rotate(-90 ${center} ${center})`} />

            {/* Score fill arc — animated on mount via CSS transition */}
            <circle
              cx={center} cy={center} r={radius} fill="none"
              stroke={activeColor} strokeWidth="8" strokeLinecap="round"
              strokeDasharray={circumference} strokeDashoffset={fillOffset}
              transform={`rotate(-90 ${center} ${center})`}
              className="gauge-arc-animate"
            />

            {/* Score position dot — pulsing */}
            <circle cx={dotX} cy={dotY} r="6" fill={activeColor}>
              <animate attributeName="r" values="5;7;5" dur="2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="1;0.6;1" dur="2s" repeatCount="indefinite" />
            </circle>
            <circle cx={dotX} cy={dotY} r="3" fill="white" />
          </svg>

          {/* Center content */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-display text-4xl font-extrabold" style={{ color: activeColor }}>{score}</span>
          </div>
        </div>
      </div>
      <div className="font-mono text-[10px] font-bold tracking-wider uppercase" style={{ color: activeColor }}>
        Exposure: {grade}
      </div>
    </div>
  );
}
