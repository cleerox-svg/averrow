/**
 * RingMaskExtension — angular masks for a STROKED ScatterplotLayer ring.
 *
 * Two looks from one extension, driven per instance:
 *   - dashed, spinning ring (a bulletproof-host halo): `dashes` > 0, `spin` rev/s,
 *   - partial arc (a takedown share): `fraction` < 1 draws only that share of the
 *     circle, clockwise from 12 o'clock.
 *
 * The fragment shader derives the angle from `geometry.uv` (the unit-circle
 * position scatterplot already passes through) and discards outside the mask, so
 * per-frame cost is one float uniform (`animTime`, seconds).
 *
 * deck.gl 9.2 hooks used:
 *   - getShaders(): module `ringMask` + inject
 *       vs:#decl / vs:#main-end   per-instance attributes -> varyings
 *       fs:#decl / fs:DECKGL_FILTER_COLOR   mask (this hook is where `geometry.uv` is set)
 *   - initializeState(): instanced attributes
 *   - draw(): pushes `animTime`
 *
 * The mask math is mirrored in shader-math.ts (`ringMaskVisible`) and unit-tested.
 */

import { LayerExtension } from '@deck.gl/core';
import type { Accessor, Layer } from '@deck.gl/core';
import type { AnimShaders, AnimShaderModule } from './types';
import { RING_MASK_DASH_DUTY } from './shader-math';

export interface RingMaskExtensionProps<DataT = unknown> {
  /** Visible share of the circle, 0..1 (default 1 = full ring). */
  getMaskFraction?: Accessor<DataT, number>;
  /** Number of dashes around the circle; 0 = solid (default 0). */
  getMaskDashes?: Accessor<DataT, number>;
  /** Dash rotation, revolutions per second (default 0). */
  getMaskSpin?: Accessor<DataT, number>;
  /** Seconds. */
  animTime?: number;
}

const uniformBlock = `\
uniform ringMaskUniforms {
  float animTime;
} ringMask;
`;

export const ringMaskModule: AnimShaderModule = {
  name: 'ringMask',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: { animTime: 'f32' },
};

const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));

export const RING_MASK_INJECT: Record<string, string> = {
  'vs:#decl': `\
in float instanceMaskFraction;
in float instanceMaskDashes;
in float instanceMaskSpin;
out float vMaskFraction;
out float vMaskDashes;
out float vMaskSpin;
`,
  'vs:#main-end': `\
vMaskFraction = instanceMaskFraction;
vMaskDashes = instanceMaskDashes;
vMaskSpin = instanceMaskSpin;
`,
  'fs:#decl': `\
in float vMaskFraction;
in float vMaskDashes;
in float vMaskSpin;
`,
  'fs:DECKGL_FILTER_COLOR': `\
float maskTurn = fract(atan(geometry.uv.x, geometry.uv.y) / 6.28318530718);
if (maskTurn > vMaskFraction) {
  discard;
}
if (vMaskDashes > 0.5) {
  float maskDash = fract(maskTurn * vMaskDashes - ringMask.animTime * vMaskSpin);
  if (maskDash > ${f(RING_MASK_DASH_DUTY)}) {
    discard;
  }
}
`,
};

export class RingMaskExtension extends LayerExtension {
  static extensionName = 'RingMaskExtension';
  static defaultProps = {
    getMaskFraction: { type: 'accessor', value: 1 },
    getMaskDashes: { type: 'accessor', value: 0 },
    getMaskSpin: { type: 'accessor', value: 0 },
    animTime: { type: 'number', value: 0 },
  };

  getShaders(this: Layer): AnimShaders {
    return { modules: [ringMaskModule], inject: RING_MASK_INJECT };
  }

  initializeState(this: Layer): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    attributeManager.addInstanced({
      instanceMaskFraction: { size: 1, accessor: 'getMaskFraction', defaultValue: 1 },
      instanceMaskDashes: { size: 1, accessor: 'getMaskDashes', defaultValue: 0 },
      instanceMaskSpin: { size: 1, accessor: 'getMaskSpin', defaultValue: 0 },
    });
  }

  draw(this: Layer): void {
    const { animTime = 0 } = this.props as unknown as RingMaskExtensionProps;
    this.setShaderModuleProps({ ringMask: { animTime } });
  }
}
