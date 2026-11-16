// Replay transport: play/pause, speed, back to live. Shown only in replay.

import { Pause, Play } from 'lucide-react';
import { REPLAY_SPEEDS, type ReplaySpeed } from './replay';

export interface ReplayControlsProps {
  playing: boolean;
  speed: ReplaySpeed;
  atEnd: boolean;
  /** Play is unavailable under reduced motion or Pause. */
  playDisabled: boolean;
  onPlayPause: () => void;
  onSpeed: (s: ReplaySpeed) => void;
  onBack: () => void;
}

const btn: React.CSSProperties = {
  background: 'var(--bg-card-deep)', border: '1px solid var(--border-base)', color: 'var(--text-secondary)',
};

export function ReplayControls({ playing, speed, atEnd, playDisabled, onPlayPause, onSpeed, onBack }: ReplayControlsProps) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Replay controls" data-testid="replay-controls">
      <button
        type="button"
        className="agn-btn w-8 h-8 rounded grid place-items-center"
        style={btn}
        aria-label={playing ? 'Pause replay' : atEnd ? 'Replay from start' : 'Play replay'}
        aria-disabled={playDisabled ? true : undefined}
        title={playDisabled ? 'Motion is off: scrub or step with the arrow keys' : undefined}
        onClick={() => { if (!playDisabled) onPlayPause(); }}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <div className="flex gap-1" role="group" aria-label="Replay speed">
        {REPLAY_SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className="agn-btn h-8 px-2 rounded font-mono text-[11px]"
            style={{
              ...btn,
              ...(speed === s ? { color: 'var(--text-primary)', border: '1px solid var(--primary-text)' } : null),
            }}
            aria-pressed={speed === s}
            onClick={() => onSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      {atEnd && (
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>End of data</span>
      )}
      <button
        type="button"
        className="agn-btn h-8 px-2.5 rounded font-mono text-[11px]"
        style={{ ...btn, color: 'var(--text-primary)' }}
        onClick={onBack}
      >
        Back to live
      </button>
    </div>
  );
}
