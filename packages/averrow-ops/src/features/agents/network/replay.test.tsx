import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FRAME_MS, advancePlayhead, chipModel, clampPlayhead, formatAge, stepPlayhead, type ChipInput,
} from './replay';
import { LiveChip } from './LiveChip';
import { EDGES } from './model';
import { activeMembers, edgeActivity, indexTimeline, laneActivity } from './activity';
import { FEEDS_FIXTURE, FIXTURE_NOW, TIMELINE_FIXTURE } from './fixtures';

const NOW = Date.parse(FIXTURE_NOW);
const MIN = 60_000;

const base: ChipInput = {
  replay: null, hasPayload: true, fetchFailed: false, osReduced: false, paused: false,
  receivedAt: 1_000_000, generatedAt: FIXTURE_NOW, now: 1_020_000,
};

describe('chip model', () => {
  it('is live and ages with the clock', () => {
    const m = chipModel(base);
    expect(m.state).toBe('live');
    expect(m.label).toBe('Live · updated 20s ago');
    expect(m.title).toBe('Data as of 06:12:30 UTC');
    expect(chipModel({ ...base, now: 1_000_000 + 125_000 }).label).toBe('Live · updated 2m 05s ago');
  });

  it('says Paused for the control and Motion off for the OS preference', () => {
    expect(chipModel({ ...base, paused: true })).toMatchObject({ state: 'paused', label: 'Paused · updated 20s ago' });
    expect(chipModel({ ...base, osReduced: true })).toMatchObject({ state: 'motion-off', label: 'Motion off · updated 20s ago' });
    // the OS case wins when both are on
    expect(chipModel({ ...base, osReduced: true, paused: true }).state).toBe('motion-off');
  });

  it('is Reconnecting with the age while a refetch fails behind an older payload', () => {
    const m = chipModel({ ...base, fetchFailed: true, now: 1_000_000 + 95_000 });
    expect(m.state).toBe('reconnecting');
    expect(m.label).toBe('Reconnecting… · 1m 35s old');
    expect(m.announce).toMatch(/older data/);
  });

  it('is Offline with no payload and a failed fetch, Connecting while loading', () => {
    expect(chipModel({ ...base, hasPayload: false, fetchFailed: true, generatedAt: undefined })).toMatchObject({ state: 'offline', label: 'Offline' });
    expect(chipModel({ ...base, hasPayload: false, generatedAt: undefined }).state).toBe('connecting');
  });

  it('shows the playhead in replay, plus end of data and new data', () => {
    const r = { playhead: Date.parse('2026-11-15T05:42:30Z'), atEnd: false, newData: false };
    expect(chipModel({ ...base, replay: r })).toMatchObject({ state: 'replay', label: 'Replay · 05:42 UTC' });
    const both = chipModel({ ...base, replay: { ...r, atEnd: true, newData: true } });
    expect(both.label).toBe('Replay · 05:42 UTC · end of data · new data available');
    // replay beats every live state
    expect(chipModel({ ...base, replay: r, fetchFailed: true, paused: true }).state).toBe('replay');
  });

  it('keeps the screen-reader text independent of the age tick', () => {
    const a = chipModel({ ...base, now: 1_020_000 });
    const b = chipModel({ ...base, now: 1_300_000 });
    expect(a.label).not.toBe(b.label);
    expect(a.announce).toBe(b.announce);
  });

  it('formats ages without jumping digits', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(59_999)).toBe('59s');
    expect(formatAge(61_000)).toBe('1m 01s');
    expect(formatAge(3_700_000)).toBe('1h 01m');
    expect(formatAge(-5)).toBe('0s');
  });
});

describe('LiveChip announcements', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('re-renders the age every second but never changes the live-region text', () => {
    render(<LiveChip replay={null} hasPayload fetchFailed={false} osReduced={false} paused={false}
      receivedAt={Date.now()} generatedAt={FIXTURE_NOW} />);
    const status = screen.getByTestId('live-chip-status');
    const chip = screen.getByTestId('live-chip');
    expect(status).toHaveTextContent('Live');
    const first = chip.textContent;
    const mutations: string[] = [];
    const mo = new MutationObserver((rs) => rs.forEach((r) => mutations.push(r.target.nodeName)));
    mo.observe(status, { childList: true, characterData: true, subtree: true });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(chip.textContent).not.toBe(first); // the visible age ticked
    expect(status).toHaveTextContent('Live');
    expect(status).toHaveAttribute('aria-live', 'polite');
    return Promise.resolve().then(() => { mo.disconnect(); expect(mutations).toHaveLength(0); });
  });

  it('announces when the state changes', () => {
    const { rerender } = render(<LiveChip replay={null} hasPayload fetchFailed={false} osReduced={false} paused={false}
      receivedAt={Date.now()} generatedAt={FIXTURE_NOW} />);
    rerender(<LiveChip replay={null} hasPayload fetchFailed osReduced={false} paused={false}
      receivedAt={Date.now()} generatedAt={FIXTURE_NOW} />);
    expect(screen.getByTestId('live-chip-status')).toHaveTextContent('Reconnecting');
    expect(screen.getByTestId('live-chip')).toHaveAttribute('data-state', 'reconnecting');
  });
});

describe('playhead maths', () => {
  const start = NOW - 60 * MIN;

  it('speed only scales how fast the clock advances', () => {
    expect(advancePlayhead(start, 100, 1, start, NOW).playhead).toBe(start + 100);
    expect(advancePlayhead(start, 100, 10, start, NOW).playhead).toBe(start + 1_000);
    expect(advancePlayhead(start, 100, 60, start, NOW).playhead).toBe(start + 6_000);
  });

  it('caps one frame so a hidden tab cannot jump the playhead', () => {
    expect(advancePlayhead(start, 60_000, 1, start, NOW).playhead).toBe(start + MAX_FRAME_MS);
    expect(advancePlayhead(start, -50, 10, start, NOW).playhead).toBe(start);
  });

  it('stops at the end of the data and reports it', () => {
    const r = advancePlayhead(NOW - 100, 200, 60, start, NOW);
    expect(r).toEqual({ playhead: NOW, atEnd: true });
    expect(clampPlayhead(NOW + 5 * MIN, start, NOW)).toBe(NOW);
    expect(clampPlayhead(start - 5 * MIN, start, NOW)).toBe(start);
  });

  it('steps a minute, or ten seconds with Shift, and clamps', () => {
    expect(stepPlayhead(start + 5 * MIN, 1, false, start, NOW)).toBe(start + 6 * MIN);
    expect(stepPlayhead(start + 5 * MIN, -1, true, start, NOW)).toBe(start + 5 * MIN - 10_000);
    expect(stepPlayhead(start + 5_000, -1, false, start, NOW)).toBe(start);
    expect(stepPlayhead(NOW - 5_000, 1, false, start, NOW)).toBe(NOW);
  });
});

describe('activity at the playhead', () => {
  const live = indexTimeline(TIMELINE_FIXTURE, FEEDS_FIXTURE);
  // Replay ignores the live freshness cap.
  const replayIndex = { ...live, capMs: Infinity };

  it('a run that ended before the playhead is not running; one spanning it is', () => {
    // analyst: started 5.4 min before the snapshot, ran 95 s (ended ~3.8 min before).
    const during = NOW - 5 * MIN;
    const after = NOW - 2 * MIN;
    expect(laneActivity(replayIndex, 'analyst', during).running).toBe(true);
    expect(laneActivity(replayIndex, 'analyst', after).running).toBe(false);
    const p = laneActivity(replayIndex, 'analyst', during).progress;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it('a run that has not started yet does not exist at the playhead', () => {
    const a = laneActivity(replayIndex, 'cartographer', NOW - 10 * MIN);
    expect(a.running).toBe(false);
    expect(a.lastStartMs).toBeNull();
    expect(laneActivity(replayIndex, 'cartographer', NOW - 60_000).running).toBe(true);
  });

  it('drives feed members the same way', () => {
    // phishtank pulled 5.5 min before the snapshot for 12 s
    const m = activeMembers(replayIndex, 'feeds:ingest', NOW - 5.5 * MIN + 5_000).get('phishtank');
    expect(m?.running).toBe(true);
    expect(activeMembers(replayIndex, 'feeds:ingest', NOW - 4 * MIN).get('phishtank')?.running).toBe(false);
  });

  it('the EVENT edge follows the event at the playhead', () => {
    const e = EDGES.find((x) => x.mechanism === 'EVENT')!;
    expect(edgeActivity(replayIndex, e, NOW - 5 * MIN).emitting).toBe(false);
    expect(edgeActivity(replayIndex, e, NOW - 20_000).emitting).toBe(true);
  });

  it('an open run is not capped in replay but is capped live', () => {
    const late = NOW + 5 * 60_000; // far past generated_at + 90 s
    expect(laneActivity(replayIndex, 'cartographer', late).running).toBe(true);
    expect(laneActivity(live, 'cartographer', late).running).toBe(false);
  });
});
