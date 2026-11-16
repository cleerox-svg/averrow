// Replay group: one bordered unit in the control row. Live it is a single
// "Replay last hour" button; in replay it is the transport (play / pause /
// restart, speed, back to live).

import { History, Pause, Play, RotateCcw } from 'lucide-react';
import { REPLAY_SPEEDS, canHandleReplayKey, type ReplaySpeed } from './replay';

export interface ReplayControlsProps {
  /** In replay mode. */
  active: boolean;
  /** Live: a payload exists to replay. */
  canStart: boolean;
  /** Why Start is unavailable, when it is. */
  startHint?: string;
  playing: boolean;
  speed: ReplaySpeed;
  atEnd: boolean;
  /** Play is unavailable while animation is off. */
  playDisabled: boolean;
  onStart: () => void;
  onPlayPause: () => void;
  onSpeed: (s: ReplaySpeed) => void;
  onBack: () => void;
  /** ←/→ on the transport steps the playhead (Shift: 10 s). */
  onStep: (direction: -1 | 1, fine: boolean) => void;
  startRef?: React.Ref<HTMLButtonElement>;
  playRef?: React.Ref<HTMLButtonElement>;
}

const btn: React.CSSProperties = { color: 'var(--text-secondary)' };

export function ReplayControls({
  active, canStart, startHint, playing, speed, atEnd, playDisabled,
  onStart, onPlayPause, onSpeed, onBack, onStep, startRef, playRef,
}: ReplayControlsProps) {
  const playLabel = playing ? 'Pause' : atEnd ? 'Restart' : 'Play';
  return (
    <div
      className="flex flex-wrap items-center gap-1 p-1 rounded"
      role="group"
      aria-label="Replay"
      data-testid="replay-controls"
      style={{ background: 'var(--bg-card-deep)', border: '1px solid var(--border-base)' }}
      onKeyDown={(e) => {
        if (!active || !canHandleReplayKey(e)) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onStep(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey);
        }
      }}
    >
      {!active ? (
        <button
          ref={startRef}
          type="button"
          className="agn-btn h-7 px-2.5 rounded font-mono text-[11px] inline-flex items-center gap-1.5"
          style={btn}
          aria-disabled={!canStart ? true : undefined}
          title={startHint ?? "Replay the last hour. You can also click or drag the run tape's time scale."}
          onClick={() => { if (canStart) onStart(); }}
        >
          <History size={14} aria-hidden="true" />
          Replay last hour
        </button>
      ) : (
        <>
          <button
            ref={playRef}
            type="button"
            className="agn-btn h-7 min-w-[5.5rem] px-2.5 rounded font-mono text-[11px] inline-flex items-center justify-center gap-1.5"
            style={btn}
            aria-label={`${playLabel} replay`}
            aria-disabled={playDisabled ? true : undefined}
            onClick={() => { if (!playDisabled) onPlayPause(); }}
          >
            {playing ? <Pause size={14} aria-hidden="true" /> : atEnd ? <RotateCcw size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            {playLabel}
          </button>
          <div className="flex gap-1" role="group" aria-label="Replay speed">
            {REPLAY_SPEEDS.map((s) => {
              const on = speed === s;
              return (
                <button
                  key={s}
                  type="button"
                  className="agn-btn h-7 px-2 rounded font-mono text-[11px]"
                  style={{
                    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: on ? 'var(--primary-tint)' : 'transparent',
                    border: `1px solid ${on ? 'var(--primary-border)' : 'transparent'}`,
                    fontWeight: on ? 600 : 400,
                  }}
                  aria-label={`${s} times speed`}
                  aria-pressed={on}
                  onClick={() => onSpeed(s)}
                >
                  {s}×
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="agn-btn h-7 px-2.5 rounded font-mono text-[11px]"
            style={{ color: 'var(--text-primary)' }}
            onClick={onBack}
          >
            Back to live
          </button>
          {atEnd && (
            <span role="status" className="font-mono text-[11px] px-1" style={{ color: 'var(--text-tertiary)' }}>
              End of data
            </span>
          )}
          {playDisabled && (
            <span className="font-mono text-[11px] px-1" style={{ color: 'var(--text-tertiary)' }}>
              Animation is off. Drag or step with ← →.
            </span>
          )}
        </>
      )}
    </div>
  );
}
