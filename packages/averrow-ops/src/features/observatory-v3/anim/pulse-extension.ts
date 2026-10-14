/**
 * PulseExtension — GPU heartbeat for ScatterplotLayer.
 *
 * Scales every instance's radius by `1 + amp * sin(animTime * rate + phase)` in
 * the vertex shader. The only per-frame input is one float uniform (`animTime`,
 * seconds), so animating thousands of nodes costs no attribute uploads.
 *
 * deck.gl 9.2 hooks used (see anim/README in the PR notes):
 *   - getShaders():  `modules` (uniform block `pulseAnim`) + `inject`:
 *       vs:#decl              per-instance `in` attributes + a global scale
 *       vs:#main-start        compute the scale once per vertex
 *       vs:DECKGL_FILTER_SIZE scale the billboard offset (the quad)
 *       vs:#main-end          scale `outerRadiusPixels` so the fragment shader's
 *                             anti-aliased edge matches the scaled quad
 *   - initializeState(): registers the instanced attributes
 *   - draw():            pushes `animTime` into the model's shader inputs
 *                        (extension draw runs before the layer's own draw)
 *
 * Props (all optional):
 *   getPulsePhase  radians, default 0   — share a value for a synchronised beat
 *   getPulseRate   rad/s, default 1
 *   getPulseAmp    fraction, default 0.15 — 0 disables the pulse for that node
 *   animTime       seconds, default 0
 */

import { LayerExtension } from '@deck.gl/core';
import type { Accessor, Layer } from '@deck.gl/core';
import type { AnimShaders, AnimShaderModule } from './types';

export interface PulseExtensionProps<DataT = unknown> {
  getPulsePhase?: Accessor<DataT, number>;
  getPulseRate?: Accessor<DataT, number>;
  getPulseAmp?: Accessor<DataT, number>;
  /** Seconds. Drive this per frame; it is the only thing that changes. */
  animTime?: number;
}

const uniformBlock = `\
uniform pulseAnimUniforms {
  float animTime;
} pulseAnim;
`;

export const pulseModule: AnimShaderModule = {
  name: 'pulseAnim',
  vs: uniformBlock,
  uniformTypes: { animTime: 'f32' },
};

export const PULSE_INJECT: Record<string, string> = {
  'vs:#decl': `\
in float instancePulsePhase;
in float instancePulseRate;
in float instancePulseAmp;
float pulseScaleLocal = 1.0;
`,
  'vs:#main-start': `\
pulseScaleLocal = 1.0 + instancePulseAmp * sin(pulseAnim.animTime * instancePulseRate + instancePulsePhase);
`,
  'vs:DECKGL_FILTER_SIZE': `\
size *= pulseScaleLocal;
`,
  'vs:#main-end': `\
outerRadiusPixels *= pulseScaleLocal;
`,
};

export class PulseExtension extends LayerExtension {
  static extensionName = 'PulseExtension';
  static defaultProps = {
    getPulsePhase: { type: 'accessor', value: 0 },
    getPulseRate: { type: 'accessor', value: 1 },
    getPulseAmp: { type: 'accessor', value: 0.15 },
    animTime: { type: 'number', value: 0 },
  };

  getShaders(this: Layer): AnimShaders {
    return { modules: [pulseModule], inject: PULSE_INJECT };
  }

  initializeState(this: Layer): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    attributeManager.addInstanced({
      instancePulsePhase: { size: 1, accessor: 'getPulsePhase', defaultValue: 0 },
      instancePulseRate: { size: 1, accessor: 'getPulseRate', defaultValue: 1 },
      instancePulseAmp: { size: 1, accessor: 'getPulseAmp', defaultValue: 0.15 },
    });
  }

  draw(this: Layer): void {
    const { animTime = 0 } = this.props as unknown as PulseExtensionProps;
    this.setShaderModuleProps({ pulseAnim: { animTime } });
  }
}
