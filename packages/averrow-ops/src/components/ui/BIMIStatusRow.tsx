interface BIMIStatusRowProps {
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'missing' | 'verified' | 'none';
  detail?: string;
}

const statusConfig = {
  pass:     { dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'PASS' },
  verified: { dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'VERIFIED' },
  warn:     { dot: 'bg-amber-500',   text: 'text-amber-400',   label: 'WARN' },
  fail:     { dot: 'bg-red-500',     text: 'text-red-400',     label: 'FAIL' },
  missing:  { dot: 'bg-red-500',     text: 'text-red-400',     label: 'MISSING' },
  none:     { dot: 'bg-white/20',    text: 'text-white/40',    label: 'NONE' },
};

export function BIMIStatusRow({ label, status, detail }: BIMIStatusRowProps) {
  const config = statusConfig[status];
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
        <span className="text-white/50 text-xs font-mono">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {detail && (
          <span className="text-white/30 text-[10px] font-mono truncate max-w-[120px]">
            {detail}
          </span>
        )}
        <span className={`text-[10px] font-mono font-bold ${config.text}`}>
          {config.label}
        </span>
      </div>
    </div>
  );
}
