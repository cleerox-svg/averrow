import { Globe } from 'lucide-react';

interface ObservatoryOverlayProps {
  historicalThreats: number;
  historicalCountries: number;
  timeWindow: string;
}

export function ObservatoryOverlay({
  historicalThreats,
  historicalCountries,
  timeWindow,
}: ObservatoryOverlayProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="bg-slate-900/80 backdrop-blur-xl border border-white/10
        rounded-2xl px-8 py-6 text-center max-w-xs
        shadow-[0_20px_60px_rgba(0,0,0,0.6)]">

        {/* Pulsing globe icon */}
        <div className="relative mx-auto w-10 h-10 mb-4">
          <div className="absolute inset-0 rounded-full bg-amber-500/20 animate-ping" />
          <div className="relative flex items-center justify-center w-10 h-10
            rounded-full bg-amber-500/10">
            <Globe className="w-5 h-5 text-amber-400" />
          </div>
        </div>

        <h3 className="text-white font-semibold text-sm mb-1">
          Threat Landscape Clear
        </h3>
        <p className="text-white/40 text-xs mb-5">
          No active threats in the {timeWindow} window
        </p>

        {/* Historical stats */}
        <div className="flex items-center gap-6 border-t border-white/10 pt-4">
          <div className="text-center">
            <p className="text-amber-400 font-mono font-bold text-lg tabular-nums">
              {historicalThreats.toLocaleString()}
            </p>
            <p className="text-white/30 text-[10px] uppercase tracking-wider mt-0.5">
              Historical
            </p>
          </div>
          <div className="w-px h-8 bg-white/10" />
          <div className="text-center">
            <p className="text-amber-400 font-mono font-bold text-lg tabular-nums">
              {historicalCountries}
            </p>
            <p className="text-white/30 text-[10px] uppercase tracking-wider mt-0.5">
              Countries
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
