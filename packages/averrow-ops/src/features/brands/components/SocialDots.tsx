import { useState } from 'react';
import { cn } from '@/lib/cn';

const PLATFORM_COLORS: Record<string, string> = {
  twitter: '#1DA1F2',
  x: '#1DA1F2',
  linkedin: '#0A66C2',
  facebook: '#1877F2',
  instagram: '#E1306C',
  youtube: '#FF0000',
  tiktok: '#00d4ff',
  reddit: '#FF4500',
};

const CLASSIFICATION_COLORS: Record<string, string> = {
  IMPERSONATION: '#f87171',
  SUSPICIOUS: '#fbbf24',
  OFFICIAL: '',
};

export interface SocialProfile {
  platform: string;
  classification?: string;
}

interface SocialDotsProps {
  profiles?: SocialProfile[] | null;
  maxDots?: number;
  className?: string;
}

function getDotColor(profile: SocialProfile): string {
  if (profile.classification && CLASSIFICATION_COLORS[profile.classification] !== undefined) {
    const override = CLASSIFICATION_COLORS[profile.classification];
    if (override) return override;
  }
  return PLATFORM_COLORS[profile.platform.toLowerCase()] ?? 'rgba(255,255,255,0.15)';
}

function getLabel(profile: SocialProfile): string {
  const name = profile.platform.charAt(0).toUpperCase() + profile.platform.slice(1);
  return profile.classification ? `${name} \u2014 ${profile.classification}` : name;
}

export function SocialDots({ profiles, maxDots = 6, className }: SocialDotsProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (!profiles || profiles.length === 0) {
    return (
      <div className={cn('flex items-center gap-1', className)}>
        {[0, 1, 2].map(i => (
          <span key={i} className="block h-2 w-2 rounded-full bg-white/10" />
        ))}
      </div>
    );
  }

  const visible = profiles.slice(0, maxDots);
  const overflow = profiles.length - maxDots;

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {visible.map((profile, i) => (
        <span
          key={i}
          className="relative block h-2 w-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: getDotColor(profile) }}
          onMouseEnter={() => setHoveredIdx(i)}
          onMouseLeave={() => setHoveredIdx(null)}
        >
          {hoveredIdx === i && (
            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 whitespace-nowrap rounded px-2 py-1 font-mono text-[10px] border border-white/10 shadow-lg z-20 pointer-events-none" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
              {getLabel(profile)}
            </span>
          )}
        </span>
      ))}
      {overflow > 0 && (
        <span className="font-mono text-[10px] text-white/40">+{overflow}</span>
      )}
    </div>
  );
}
