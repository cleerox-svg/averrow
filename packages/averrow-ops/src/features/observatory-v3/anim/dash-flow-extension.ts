/**
 * DashFlowExtension — animated, flowing dashes for PathLayer.
 *
 * deck.gl 9.2's PathStyleExtension (in @deck.gl/extensions, not installed here)
 * has no animatable dash-phase uniform: its dash offset is a per-path attribute,
 * so flowing dashes would need an attribute rewrite every frame. This extension
 * instead gives each path vertex its cumulative distance (attribute) and makes
 * the phase a uniform: the fragment shader discards where
 *
 *     mod(pathDistance - animTime * speed, dash + gap) > dash
 *
 * so per-frame cost is one float uniform. Positive `speed` flows toward the end
 * of the path (source -> target).
 *
 * Distances come from `getDashDistances(path)` -> number[] (one per vertex, same
 * length as the path), exactly like TripsLayer's `getTimestamps`. Use
 * `cumulativeDistances(path)` to build them (memoise per path). `dash`, `gap`
 * and `speed` share the units of those distances (per second for `speed`).
 *
 * deck.gl 9.2 hooks used:
 *   - getShaders(): module `dashFlow` (dash, gap, speed, animTime) + inject
 *       vs:#decl / vs:#main-end  interpolate cumulative distance to `vDashDist`
 *                                (same trick as the vendored TripsLayer)
 *       fs:#decl / fs:#main-start discard outside the moving dashes
 *   - initializeState(): instanced attribute with two shaderAttributes
 *     (start vertex / next vertex), vertexOffset 0 and 1
 *   - draw(): pushes uniforms
 */

import { LayerExtension } from '@deck.gl/core';
import type { Accessor, Layer } from '@deck.gl/core';
import type { AnimShaders, AnimShaderModule } from './types';

export interface DashFlowExtensionProps<DataT = unknown> {
  getDashDistances?: Accessor<DataT, number[]>;
  /** Visible length of one dash (distance units). Default 0.6. */
  dash?: number;
  /** Gap length (distance units). Default 0.9. */
  gap?: number;
  /** Distance units per second; negative reverses. Default 1.5. */
  speed?: number;
  /** Seconds. */
  animTime?: number;
}

const uniformBlock = `\
uniform dashFlowUniforms {
  float dash;
  float gap;
  float speed;
  float animTime;
} dashFlow;
`;

export const dashFlowModule: AnimShaderModule = {
  name: 'dashFlow',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: { dash: 'f32', gap: 'f32', speed: 'f32', animTime: 'f32' },
};

export const DASH_FLOW_INJECT: Record<string, string> = {
  'vs:#decl': `\
in float instanceDashDist;
in float instanceNextDashDist;
out float vDashDist;
`,
  'vs:#main-end': `\
vDashDist = instanceDashDist + (instanceNextDashDist - instanceDashDist) * vPathPosition.y / vPathLength;
`,
  'fs:#decl': `\
in float vDashDist;
`,
  'fs:#main-start': `\
float dashCycle = max(dashFlow.dash + dashFlow.gap, 0.000001);
if (mod(vDashDist - dashFlow.animTime * dashFlow.speed, dashCycle) > dashFlow.dash) {
  discard;
}
`,
};

export class DashFlowExtension extends LayerExtension {
  static extensionName = 'DashFlowExtension';
  static defaultProps = {
    getDashDistances: { type: 'accessor', value: (d: { distances?: number[] }) => d.distances },
    dash: { type: 'number', value: 0.6 },
    gap: { type: 'number', value: 0.9 },
    speed: { type: 'number', value: 1.5 },
    animTime: { type: 'number', value: 0 },
  };

  getShaders(this: Layer): AnimShaders {
    return { modules: [dashFlowModule], inject: DASH_FLOW_INJECT };
  }

  initializeState(this: Layer): void {
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    attributeManager.addInstanced({
      dashDistances: {
        size: 1,
        accessor: 'getDashDistances',
        shaderAttributes: {
          instanceDashDist: { vertexOffset: 0 },
          instanceNextDashDist: { vertexOffset: 1 },
        },
      },
    });
  }

  draw(this: Layer): void {
    const { dash = 0.6, gap = 0.9, speed = 1.5, animTime = 0 } = this.props as unknown as DashFlowExtensionProps;
    this.setShaderModuleProps({ dashFlow: { dash, gap, speed, animTime } });
  }
}

/**
 * Cumulative planar distance (in degrees) at each vertex of a lng/lat polyline:
 * the per-vertex input for `getDashDistances`. Planar degrees match what a
 * Mercator viewer perceives well enough for dash spacing.
 */
export function cumulativeDistances(path: ReadonlyArray<readonly [number, number]>): number[] {
  const out: number[] = new Array<number>(path.length);
  let acc = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const a = path[i - 1]!;
      const b = path[i]!;
      acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    out[i] = acc;
  }
  return out;
}
