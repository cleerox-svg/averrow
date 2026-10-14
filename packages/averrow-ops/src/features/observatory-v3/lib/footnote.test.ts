import { describe, it, expect } from 'vitest';
import { lensFootnote } from './footnote';
import { LENS_IDS } from './lenses';

describe('lensFootnote', () => {
  it('says "Motion reduced" under reduced motion, whatever the lens', () => {
    for (const lens of LENS_IDS) expect(lensFootnote({ lens, reducedMotion: true, motionOn: true })).toBe('Motion reduced');
  });
  it('says nothing when nothing animates', () => {
    for (const lens of LENS_IDS) expect(lensFootnote({ lens, reducedMotion: false, motionOn: false })).toBeNull();
  });
  it('never uses renderer jargon', () => {
    for (const lens of LENS_IDS) {
      const t = lensFootnote({ lens, reducedMotion: false, motionOn: true });
      expect(t).toBeTruthy();
      expect(t).not.toMatch(/GPU|WebGL|shader|layers? active/i);
    }
  });
});

describe('lensFootnote: Fast view', () => {
  it('names the pulsing instead of "Replaying attacks"', () => {
    expect(lensFootnote({ lens: 'threats', reducedMotion: false, motionOn: true, fast: true })).toBe('Very fast nodes pulse');
    expect(lensFootnote({ lens: 'threats', reducedMotion: false, motionOn: true })).toBe('Replaying attacks');
    expect(lensFootnote({ lens: 'threats', reducedMotion: true, motionOn: true, fast: true })).toBe('Motion reduced');
  });
});
