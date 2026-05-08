/**
 * TripsLayer — vendored from @deck.gl/geo-layers to avoid pulling in
 * heavy Tile3D/Terrain/GLTF dependencies that break Vite builds.
 *
 * Source: @deck.gl/geo-layers v9.1.x (MIT License, vis.gl contributors)
 * Only depends on PathLayer from @deck.gl/layers (already installed).
 */

import { PathLayer } from '@deck.gl/layers';

// ─── Shader uniforms ────────────────────────────────────────
const uniformBlock = `\
layout(std140) uniform tripsUniforms {
  bool fadeTrail;
  float trailLength;
  float currentTime;
} trips;
`;

const tripsUniforms = {
  name: 'trips',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    fadeTrail: 'f32',
    trailLength: 'f32',
    currentTime: 'f32',
  },
};

// ─── Layer ──────────────────────────────────────────────────
const defaultProps = {
  fadeTrail: true,
  trailLength: { type: 'number', value: 120, min: 0 },
  currentTime: { type: 'number', value: 0, min: 0 },
  getTimestamps: { type: 'accessor', value: (d: any) => d.timestamps },
};

class TripsLayer extends (PathLayer as any) {
  static layerName = 'TripsLayer';
  static defaultProps = defaultProps;

  getShaders() {
    const shaders = super.getShaders();
    shaders.inject = {
      'vs:#decl': `\
in float instanceTimestamps;
in float instanceNextTimestamps;
out float vTime;
`,
      'vs:#main-end': `\
vTime = instanceTimestamps + (instanceNextTimestamps - instanceTimestamps) * vPathPosition.y / vPathLength;
`,
      'fs:#decl': `\
in float vTime;
`,
      'fs:#main-start': `\
if(vTime > trips.currentTime || (trips.fadeTrail && (vTime < trips.currentTime - trips.trailLength))) {
  discard;
}
`,
      'fs:DECKGL_FILTER_COLOR': `\
if(trips.fadeTrail) {
  color.a *= 1.0 - (trips.currentTime - vTime) / trips.trailLength;
}
`,
    };
    shaders.modules = [...shaders.modules, tripsUniforms];
    return shaders;
  }

  initializeState() {
    super.initializeState();
    const attributeManager = this.getAttributeManager();
    attributeManager.addInstanced({
      timestamps: {
        size: 1,
        accessor: 'getTimestamps',
        shaderAttributes: {
          instanceTimestamps: { vertexOffset: 0 },
          instanceNextTimestamps: { vertexOffset: 1 },
        },
      },
    });
  }

  draw(params: any) {
    const { fadeTrail, trailLength, currentTime } = this.props;
    const model = this.state.model;
    model.shaderInputs.setProps({ trips: { fadeTrail, trailLength, currentTime } });
    super.draw(params);
  }
}

// Export as any to work around deck.gl v9 constructor typing issues
const TripsLayerExport = TripsLayer as any;
export { TripsLayerExport as TripsLayer };
