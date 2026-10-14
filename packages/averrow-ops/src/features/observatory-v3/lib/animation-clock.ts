/**
 * AnimationClock — a frame-rate-independent, looping timeline clock.
 *
 * Time is expressed in "timeline units" (the TripsLayer `currentTime` domain)
 * and advances by wall-clock deltas, never by frame count, so 30/60/120/144 Hz
 * displays all play the cycle at the same real speed.
 *
 * The clock is renderer-agnostic and has a small transport API
 * (play / pause / setSpeed / seek) so a replay timeline UI can drive it later.
 * It does not own a requestAnimationFrame loop — the caller feeds it
 * `tick(performance.now())` — which keeps it trivially testable.
 */

export interface AnimationClockOptions {
  /** Length of one loop, in timeline units. */
  cycleLength: number;
  /** Timeline units that elapse per real second at speed 1. */
  unitsPerSecond?: number;
  /** Initial speed multiplier (default 1). */
  speed?: number;
  /** Start paused (default false). */
  paused?: boolean;
  /**
   * Largest real delta (ms) a single tick may advance. A backgrounded tab or a
   * long GC pause would otherwise teleport the playhead; excess is dropped.
   */
  maxDeltaMs?: number;
}

export class AnimationClock {
  readonly cycleLength: number;
  readonly unitsPerSecond: number;
  private readonly maxDeltaMs: number;
  private time = 0;
  private speed: number;
  private playing: boolean;
  private lastTickMs: number | null = null;

  constructor(opts: AnimationClockOptions) {
    if (!(opts.cycleLength > 0)) throw new RangeError('cycleLength must be > 0');
    this.cycleLength = opts.cycleLength;
    this.unitsPerSecond = opts.unitsPerSecond ?? 60;
    this.speed = opts.speed ?? 1;
    this.playing = !(opts.paused ?? false);
    this.maxDeltaMs = opts.maxDeltaMs ?? 100;
  }

  /** Current playhead in [0, cycleLength). */
  get currentTime(): number {
    return this.time;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentSpeed(): number {
    return this.speed;
  }

  /**
   * Advance to `nowMs` (a monotonic timestamp such as performance.now() or the
   * rAF callback argument). The first tick after construction / resync only
   * establishes the baseline. Returns the playhead.
   */
  tick(nowMs: number): number {
    const last = this.lastTickMs;
    this.lastTickMs = nowMs;
    if (last === null || !this.playing) return this.time;
    const dt = Math.min(Math.max(0, nowMs - last), this.maxDeltaMs);
    this.advance((dt / 1000) * this.unitsPerSecond * this.speed);
    return this.time;
  }

  /** Forget the last tick so the next one doesn't count the gap (call on resume from hidden/offscreen). */
  resync(): void {
    this.lastTickMs = null;
  }

  play(): void {
    if (!this.playing) {
      this.playing = true;
      this.resync();
    }
  }

  pause(): void {
    this.playing = false;
  }

  /** Speed multiplier; negative plays backwards, 0 holds the playhead while "playing". */
  setSpeed(speed: number): void {
    if (Number.isFinite(speed)) this.speed = speed;
  }

  /** Jump to an absolute position (wrapped into the cycle). */
  seek(time: number): void {
    if (!Number.isFinite(time)) return;
    this.time = this.wrap(time);
  }

  /** Jump to a 0..1 fraction of the cycle (clamped). */
  seekFraction(fraction: number): void {
    if (!Number.isFinite(fraction)) return;
    this.seek(Math.min(1, Math.max(0, fraction)) * this.cycleLength);
  }

  private advance(units: number): void {
    this.time = this.wrap(this.time + units);
  }

  private wrap(t: number): number {
    const c = this.cycleLength;
    return ((t % c) + c) % c;
  }
}
