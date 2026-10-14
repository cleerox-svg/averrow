import { describe, it, expect } from 'vitest';
import {
  motionPolicy, breatheAmp, isLoudSeverity, fadeProgress, lensFade, loopNeeded, splitFade, PING_COLOR,
  LENS_FADE_IN_MS, LENS_FADE_OUT_MS, COLOR_TRANSITION_MS, DRAWER_ENTER_MS,
} from './motion';
import { SEVERITY_COLORS, THREAT_TYPE_COLORS } from './map-colors';
import { pulseAmpForSeverity } from '../anim';

describe('motionPolicy', () => {
  it('full motion: the particles layer means flow, no static stand-in', () => {
    expect(motionPolicy({ reducedMotion: false, particlesLayer: true })).toEqual({ flow: true, staticBeams: false, ambient: true, instant: false });
  });
  it('reduced motion: particles become static beams instead of dead dots', () => {
    expect(motionPolicy({ reducedMotion: true, particlesLayer: true })).toEqual({ flow: false, staticBeams: true, ambient: false, instant: true });
  });
  it('no particles layer: no flow and no stand-in either way', () => {
    expect(motionPolicy({ reducedMotion: true, particlesLayer: false }).staticBeams).toBe(false);
    expect(motionPolicy({ reducedMotion: false, particlesLayer: false }).flow).toBe(false);
  });
});

describe('only critical and high nodes breathe', () => {
  const policy = { ambient: true };
  it('flags loud severities', () => {
    expect(isLoudSeverity('critical')).toBe(true);
    expect(isLoudSeverity('HIGH')).toBe(true);
    for (const s of ['medium', 'low', 'info', null, undefined, '']) expect(isLoudSeverity(s)).toBe(false);
  });
  it('amplitude is zero for the rest, and zero for everyone under reduced motion', () => {
    expect(breatheAmp('critical', pulseAmpForSeverity, policy)).toBeGreaterThan(0);
    expect(breatheAmp('high', pulseAmpForSeverity, policy)).toBeGreaterThan(0);
    expect(breatheAmp('medium', pulseAmpForSeverity, policy)).toBe(0);
    expect(breatheAmp('low', pulseAmpForSeverity, policy)).toBe(0);
    expect(breatheAmp('critical', pulseAmpForSeverity, { ambient: false })).toBe(0);
  });
});

describe('pings', () => {
  it('use a colour that is not any severity or threat-type colour', () => {
    const key = (c: number[]) => c.slice(0, 3).join(',');
    const used = new Set([...Object.values(SEVERITY_COLORS), ...Object.values(THREAT_TYPE_COLORS)].map(key));
    expect(used.has(key(PING_COLOR))).toBe(false);
  });
});

describe('lens cross-fade (clock driven)', () => {
  it('constants match the brief', () => {
    expect(LENS_FADE_IN_MS).toBe(240);
    expect(LENS_FADE_OUT_MS).toBe(200);
    expect(COLOR_TRANSITION_MS).toBe(250);
    expect(DRAWER_ENTER_MS).toBe(220);
  });
  it('eases 0 -> 1', () => {
    expect(fadeProgress(1000, 1000, 240)).toBe(0);
    expect(fadeProgress(1240, 1000, 240)).toBe(1);
    expect(fadeProgress(1120, 1000, 240)).toBeGreaterThan(0.5); // ease-out is front-loaded
    expect(fadeProgress(900, 1000, 240)).toBe(0);
    expect(fadeProgress(5, 0, 0)).toBe(1);
  });
  it('starts with the old scene fully visible and the new one hidden', () => {
    expect(lensFade(1000, 1000, false)).toEqual({ incoming: 0, outgoing: 1, active: true });
  });
  it('drops the outgoing scene after ~200ms and finishes the incoming at 240ms', () => {
    const mid = lensFade(1100, 1000, false);
    expect(mid.active).toBe(true);
    expect(mid.outgoing).toBeGreaterThan(0);
    expect(mid.outgoing).toBeLessThan(1);
    const late = lensFade(1210, 1000, false);
    expect(late.outgoing).toBe(0);
    expect(late.incoming).toBeLessThan(1);
    expect(late.active).toBe(true);
    expect(lensFade(1241, 1000, false)).toEqual({ incoming: 1, outgoing: 0, active: false });
  });
  it('is instant under reduced motion and when nothing changed', () => {
    expect(lensFade(1000, 1000, true)).toEqual({ incoming: 1, outgoing: 0, active: false });
    expect(lensFade(1000, null, false)).toEqual({ incoming: 1, outgoing: 0, active: false });
  });
});

describe('splitFade: only layers that actually change across a lens switch fade', () => {
  it('a layer in both scenes neither re-fades in nor leaves an out: twin', () => {
    const s = splitFade(['nodes-core', 'particle-trails', 'ops-bloom'], ['nodes-core', 'particle-trails', 'hosting-rings']);
    expect(s.fadeIn).toEqual(['ops-bloom']);
    expect(s.fadeOut).toEqual(['hosting-rings']);
  });
  it('identical scenes fade nothing; disjoint scenes fade everything', () => {
    expect(splitFade(['a', 'b'], ['a', 'b'])).toEqual({ fadeIn: [], fadeOut: [] });
    expect(splitFade(['a'], ['b'])).toEqual({ fadeIn: ['a'], fadeOut: ['b'] });
    expect(splitFade([], ['b'])).toEqual({ fadeIn: [], fadeOut: ['b'] });
  });
});

describe('loopNeeded: a still picture costs zero frames', () => {
  const idle = { particles: true, movementRings: false, clockPlaying: false, breathing: false, lensMotion: false, fading: false, hold: false };
  it('a paused replay with particles but nothing else moving needs no loop', () => {
    expect(loopNeeded(idle)).toBe(false);
    expect(loopNeeded({ ...idle, clockPlaying: true })).toBe(true);
  });
  it('anything with its own motion keeps it running', () => {
    expect(loopNeeded({ ...idle, breathing: true })).toBe(true);
    expect(loopNeeded({ ...idle, lensMotion: true })).toBe(true);
    expect(loopNeeded({ ...idle, fading: true })).toBe(true);
  });
  it('a live ping holds the loop open even when the replay is paused and nothing else animates', () => {
    expect(loopNeeded({ ...idle, hold: true })).toBe(true);
  });
  it('movement rings follow the replay clock', () => {
    expect(loopNeeded({ ...idle, particles: false, movementRings: true, clockPlaying: false })).toBe(false);
    expect(loopNeeded({ ...idle, particles: false, movementRings: true, clockPlaying: true })).toBe(true);
  });
});
