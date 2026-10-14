/**
 * The stats bar's right-hand note about motion, in plain words (it used to say
 * "GPU layers active", which tells an analyst nothing).
 */

import type { LensId } from './lenses';

export function lensFootnote(i: { lens: LensId; reducedMotion: boolean; motionOn: boolean }): string | null {
  if (i.reducedMotion) return 'Motion reduced';
  if (!i.motionOn) return null;
  switch (i.lens) {
    case 'threats': return 'Replaying attacks';
    case 'movement': return 'Replaying moves';
    case 'operations': return 'Linked operations pulse together';
    case 'campaigns': return 'Dashes run adversary → target';
    case 'actors': return 'Brighter = higher confidence';
    default: return 'Animated';
  }
}
