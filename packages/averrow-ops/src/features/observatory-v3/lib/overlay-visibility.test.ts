import { describe, it, expect } from 'vitest';
import { clearOverlayKind, type ClearOverlayInput } from './overlay-visibility';

const base: ClearOverlayInput = {
  mode: 'global', nodesReady: true, nodeCount: 0, stats: { threats_mapped: 0, threats_total: 0 },
};

describe('clearOverlayKind', () => {
  it('shows "clear" only when loaded, global, with zero nodes and zero threats', () => {
    expect(clearOverlayKind(base)).toBe('clear');
  });
  it('is hidden outside global mode', () => {
    expect(clearOverlayKind({ ...base, mode: 'heatmap' })).toBeNull();
    expect(clearOverlayKind({ ...base, mode: 'bot_density' })).toBeNull();
  });
  it('is hidden while nodes are loading / errored / showing previous-period data', () => {
    expect(clearOverlayKind({ ...base, nodesReady: false })).toBeNull();
  });
  it('is hidden when there are nodes', () => {
    expect(clearOverlayKind({ ...base, nodeCount: 3 })).toBeNull();
  });
  it('is hidden until stats are available (cannot verify "clear")', () => {
    expect(clearOverlayKind({ ...base, stats: null })).toBeNull();
  });
  it('does not claim "clear" when stats report threats the map cannot show', () => {
    expect(clearOverlayKind({ ...base, stats: { threats_mapped: 12, threats_total: 12 } })).toBeNull();
  });
  it('is honest about threats without coordinates', () => {
    expect(clearOverlayKind({ ...base, stats: { threats_mapped: 0, threats_total: 40 } })).toBe('ungeolocated');
  });
});
