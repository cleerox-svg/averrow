import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLatRange, resetLatRangeWarning } from './camera';

// MapLibre 5 turned `transform.latRange` into a read-only getter over `transform._helper._latRange`.
describe('setLatRange (the phone latitude-range hack, MapLibre 5 shape)', () => {
  it('writes the range to the transform helper and reports it applied', () => {
    const transform = { _helper: { _latRange: [-85.051129, 85.051129] as [number, number] } };
    expect(setLatRange(transform, 89.5)).toBe(true);
    expect(transform._helper._latRange).toEqual([-89.5, 89.5]);
    expect(setLatRange(transform, 85.051129)).toBe(true);
    expect(transform._helper._latRange).toEqual([-85.051129, 85.051129]);
  });

  it('does nothing (and says so) when the shape is not there: a stub, a missing transform, a future major', () => {
    expect(setLatRange(undefined, 89.5)).toBe(false);
    expect(setLatRange(null, 89.5)).toBe(false);
    expect(setLatRange({}, 89.5)).toBe(false);
    expect(setLatRange({ latRange: [-85, 85] }, 89.5)).toBe(false);
    expect(setLatRange({ _helper: {} }, 89.5)).toBe(false);
  });

  it('a helper whose range is null (no max bounds) is still writable', () => {
    const transform = { _helper: { _latRange: null as [number, number] | null } };
    expect(setLatRange(transform, 89.5)).toBe(true);
    expect(transform._helper._latRange).toEqual([-89.5, 89.5]);
  });
});

describe('setLatRange: a no-op says so in development (a MapLibre upgrade must not silently disable it)', () => {
  beforeEach(() => { resetLatRangeWarning(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('warns once when the shape is not there, and never when it is applied', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(setLatRange({ _helper: { _latRange: null } }, 89.5)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(setLatRange({}, 89.5)).toBe(false);
    expect(setLatRange(undefined, 89.5)).toBe(false);
    expect(setLatRange({ latRange: [-85, 85] }, 89.5)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('_helper._latRange');
  });

  it('is silent in a production build', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(setLatRange({}, 89.5)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
