import { describe, it, expect, vi } from 'vitest';
import { canInterleave, installTransformAlias } from './maplibre-compat';

describe('canInterleave: exactly what deck.gl reads, map.transform', () => {
  it('is true for a map with its own transform', () => {
    expect(canInterleave({ transform: {} })).toBe(true);
  });
  it('is false for a map with no transform and no camera (flat -> globe cannot interleave)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = {};
    installTransformAlias(map);
    expect(canInterleave(map)).toBe(false);
    expect(canInterleave(null)).toBe(false);
  });
  it('is false until the alias is installed over a camera transform, then true', () => {
    const map = { _camera: { transform: {} } };
    expect(canInterleave(map)).toBe(false);
    expect(installTransformAlias(map)).toBe(true);
    expect(canInterleave(map)).toBe(true);
  });
});
