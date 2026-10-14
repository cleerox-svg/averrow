/**
 * RingExtension — expanding, fading rings for a (stroked) ScatterplotLayer.
 *
 * Each instance carries `startTime` and `duration`. The vertex shader derives
 * `age = animTime - startTime` and, inside the closed window [0, duration],
 * eases the radius multiplier from `ringFrom` to `ringTo` (ease-out cubic) while
 * alpha runs ~1 -> 0. Outside the window the instance's quad is collapsed to a
 * point (no fragments, no discard cost) — so a fixed pool of slots can be reused
 * forever (see RingBuffer).
 *
 * `getRadius` is the FULL radius (the size at `ringTo`, normally 1). Use
 * `radiusUnits: 'pixels'` and `stroked: true, filled: false`.
 *
 * deck.gl 9.2 hooks used:
 *   - getShaders(): module `ringAnim` (uniforms animTime, r0, r1) + inject
 *       vs:#decl / vs:#main-start   attributes + age/ease/alpha, once per vertex
 *       vs:DECKGL_FILTER_SIZE       collapse / scale the quad
 *       vs:DECKGL_FILTER_COLOR      fade alpha (runs for fill and line colour)
 *       vs:#main-end                keep AA edge + stroke width in screen pixels
 *   - initializeState(): instanced attributes
 *   - draw(): pushes uniforms (extension draw runs before the layer's draw)
 *
 * The math is mirrored in shader-math.ts (ringState) and unit-tested there.
 */

import { LayerExtension } from '@deck.gl/core';
import type { Accessor, Layer } from '@deck.gl/core';
import type { AnimShaders, AnimShaderModule } from './types';
import { RING_FADE_IN, RING_MIN_DURATION } from './shader-math';

export interface RingExtensionProps<DataT = unknown> {
  /** Seconds, same clock domain as animTime. */
  getRingStart?: Accessor<DataT, number>;
  /** Seconds. */
  getRingDuration?: Accessor<DataT, number>;
  /** Radius multiplier at spawn (default 0.15). */
  ringFrom?: number;
  /** Radius multiplier at expiry (default 1). */
  ringTo?: number;
  animTime?: number;
}

const uniformBlock = `\
uniform ringAnimUniforms {
  float animTime;
  float r0;
  float r1;
} ringAnim;
`;

export const ringModule: AnimShaderModule = {
  name: 'ringAnim',
  vs: uniformBlock,
  uniformTypes: { animTime: 'f32', r0: 'f32', r1: 'f32' },
};

const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));

export const RING_INJECT: Record<string, string> = {
  'vs:#decl': `\
in float instanceRingStart;
in float instanceRingDuration;
float ringScaleLocal = 0.0;
float ringAlphaLocal = 0.0;
`,
  'vs:#main-start': `\
float ringAgeLocal = ringAnim.animTime - instanceRingStart;
float ringPLocal = ringAgeLocal / max(instanceRingDuration, ${RING_MIN_DURATION});
if (ringAgeLocal >= 0.0 && ringPLocal <= 1.0) {
  float ringQ = 1.0 - clamp(ringPLocal, 0.0, 1.0);
  float ringEase = 1.0 - ringQ * ringQ * ringQ;
  ringScaleLocal = mix(ringAnim.r0, ringAnim.r1, ringEase);
  ringAlphaLocal = clamp(ringPLocal / ${f(RING_FADE_IN)}, 0.0, 1.0) * ringQ * ringQ;
} else {
  ringScaleLocal = 0.0;
  ringAlphaLocal = 0.0;
}
`,
  'vs:DECKGL_FILTER_SIZE': `\
size *= ringScaleLocal;
`,
  'vs:DECKGL_FILTER_COLOR': `\
color.a *= ringAlphaLocal;
`,
  'vs:#main-end': `\
outerRadiusPixels *= ringScaleLocal;
innerUnitRadius = clamp(1.0 - (1.0 - innerUnitRadius) / max(ringScaleLocal, 0.0001), 0.0, 1.0);
`,
};

export class RingExtension extends LayerExtension {
  static extensionName = 'RingExtension';
  static defaultProps = {
    getRingStart: { type: 'accessor', value: -1e9 },
    getRingDuration: { type: 'accessor', value: 1 },
    ringFrom: { type: 'number', value: 0.15 },
    ringTo: { type: 'number', value: 1 },
    animTime: { type: 'number', value: 0 },
  };

  getShaders(this: Layer): AnimShaders {
    return { modules: [ringModule], inject: RING_INJECT };
  }

  initializeState(this: Layer): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    attributeManager.addInstanced({
      instanceRingStart: { size: 1, accessor: 'getRingStart', defaultValue: -1e9 },
      instanceRingDuration: { size: 1, accessor: 'getRingDuration', defaultValue: 1 },
    });
  }

  draw(this: Layer): void {
    const { animTime = 0, ringFrom = 0.15, ringTo = 1 } = this.props as unknown as RingExtensionProps;
    this.setShaderModuleProps({ ringAnim: { animTime, r0: ringFrom, r1: ringTo } });
  }
}
