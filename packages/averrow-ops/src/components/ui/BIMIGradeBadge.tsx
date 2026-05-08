type BimiGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F' | null;

interface BIMIGradeBadgeProps {
  grade: BimiGrade | string | undefined;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  tooltip?: boolean;
}

const gradeConfig: Record<NonNullable<BimiGrade>, {
  bg: string;
  border: string;
  text: string;
  glow: string;
  label: string;
}> = {
  'A+': {
    bg: 'bg-emerald-500/15',
    border: 'border-emerald-500/40',
    text: 'text-emerald-300',
    glow: 'shadow-[0_0_8px_rgba(16,185,129,0.2)]',
    label: 'DMARC enforced + BIMI published + VMC verified',
  },
  'A': {
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    text: 'text-emerald-400',
    glow: 'shadow-[0_0_6px_rgba(16,185,129,0.15)]',
    label: 'DMARC enforced + BIMI published',
  },
  'B': {
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/25',
    text: 'text-blue-300',
    glow: '',
    label: 'DMARC enforced, no BIMI',
  },
  'C': {
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/25',
    text: 'text-amber-400',
    glow: '',
    label: 'DMARC quarantine, no enforcement',
  },
  'D': {
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/25',
    text: 'text-orange-400',
    glow: '',
    label: 'DMARC reporting only',
  },
  'F': {
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    text: 'text-red-400',
    glow: 'shadow-[0_0_6px_rgba(239,68,68,0.15)]',
    label: 'No DMARC protection',
  },
};

const sizeClasses = {
  sm: 'text-[10px] px-1.5 py-0.5 rounded',
  md: 'text-xs px-2 py-0.5 rounded-md',
  lg: 'text-sm px-3 py-1 rounded-lg',
};

export function BIMIGradeBadge({
  grade,
  size = 'md',
  showLabel = false,
  tooltip = false,
}: BIMIGradeBadgeProps) {
  if (!grade) {
    return (
      <span className={`inline-flex items-center font-mono font-bold
        bg-white/5 border border-white/10 text-white/30
        ${sizeClasses[size]}`}>
        {showLabel && <span className="mr-1 font-normal opacity-60">EMAIL</span>}
        &mdash;
      </span>
    );
  }

  const config = gradeConfig[grade as NonNullable<BimiGrade>] ?? gradeConfig['F'];

  const badge = (
    <span className={`inline-flex items-center font-mono font-bold
      ${config.bg} ${config.border} ${config.text} ${config.glow}
      border ${sizeClasses[size]}`}>
      {showLabel && (
        <span className="mr-1 font-normal opacity-60 text-[9px] tracking-wider">
          EMAIL
        </span>
      )}
      {grade}
    </span>
  );

  if (!tooltip) return badge;

  return (
    <div className="relative group inline-flex">
      {badge}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2
        hidden group-hover:block z-50 pointer-events-none">
        <div className="bg-slate-800 border border-white/10 rounded-lg px-3 py-2
          text-[11px] text-white/70 whitespace-nowrap
          shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
          <span className={`font-bold font-mono ${config.text} mr-1.5`}>{grade}</span>
          {config.label}
        </div>
      </div>
    </div>
  );
}
