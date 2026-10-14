/**
 * Contract tests for the three LayerExtensions.
 *
 * jsdom has no WebGL, so these can't compile the shaders. Instead they pin the
 * contract deck.gl 9.2 relies on:
 *   - the extension merges its default props into real ScatterplotLayer /
 *     PathLayer instances (layers deck accepts),
 *   - getShaders() returns a uniform-block module whose name matches the block's
 *     instance name, and inject keys that are real 9.2 hook points,
 *   - every `in` attribute the shader declares is registered by initializeState,
 *   - draw() pushes the right uniforms through setShaderModuleProps.
 */

import { describe, it, expect, vi } from 'vitest';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { PulseExtension, PULSE_INJECT, pulseModule } from './pulse-extension';
import { RingExtension, RING_INJECT, ringModule } from './ring-extension';
import { RingMaskExtension, RING_MASK_INJECT, ringMaskModule } from './ring-mask-extension';
import { DashFlowExtension, DASH_FLOW_INJECT, dashFlowModule, cumulativeDistances } from './dash-flow-extension';
import type { AnimShaderModule, AnimShaders } from './types';

/** Hook points that exist in deck.gl 9.2 / luma shadertools 9.2 injection. */
const VALID_INJECT_KEYS = new Set([
  'vs:#decl', 'vs:#main-start', 'vs:#main-end',
  'fs:#decl', 'fs:#main-start', 'fs:#main-end',
  'vs:DECKGL_FILTER_SIZE', 'vs:DECKGL_FILTER_GL_POSITION', 'vs:DECKGL_FILTER_COLOR', 'fs:DECKGL_FILTER_COLOR',
]);

interface FakeLayerThis {
  props: Record<string, unknown>;
  getAttributeManager: () => { addInstanced: (spec: Record<string, unknown>) => void } | null;
  setShaderModuleProps: (props: Record<string, unknown>) => void;
}

function fakeLayer(props: Record<string, unknown> = {}) {
  const addInstanced = vi.fn();
  const setShaderModuleProps = vi.fn();
  const self: FakeLayerThis = {
    props,
    getAttributeManager: () => ({ addInstanced }),
    setShaderModuleProps,
  };
  return { self: self as unknown as Layer, addInstanced, setShaderModuleProps };
}

function uniformsInBlock(block: string): string[] {
  return [...block.matchAll(/^\s*(?:float|int|bool|vec\d)\s+(\w+);/gm)].map(m => m[1]!);
}

function checkModule(mod: AnimShaderModule) {
  const block = mod.vs ?? mod.fs ?? '';
  // `uniform fooUniforms { ... } foo;` — instance name must equal the module name.
  expect(block).toMatch(new RegExp(`\\}\\s*${mod.name};`));
  expect(block).toMatch(/^uniform \w+Uniforms \{/m);
  // Every uniform in the block has a declared type, and vice versa.
  expect(uniformsInBlock(block).sort()).toEqual(Object.keys(mod.uniformTypes).sort());
  // If a stage is declared it carries the same block.
  if (mod.vs && mod.fs) expect(mod.vs).toBe(mod.fs);
}

function checkInject(shaders: AnimShaders) {
  for (const key of Object.keys(shaders.inject)) expect(VALID_INJECT_KEYS.has(key), key).toBe(true);
  for (const code of Object.values(shaders.inject)) {
    expect(code.trim().length).toBeGreaterThan(0);
    expect(code.endsWith('\n')).toBe(true); // injected snippets must end a line
  }
}

/** Names of `in <type> name;` attribute declarations in vs:#decl. */
function declaredAttributes(inject: Record<string, string>): string[] {
  return [...(inject['vs:#decl'] ?? '').matchAll(/^in\s+\w+\s+(\w+);/gm)].map(m => m[1]!);
}

describe('PulseExtension', () => {
  const ext = new PulseExtension();

  it('merges its defaults into a real ScatterplotLayer', () => {
    const layer = new ScatterplotLayer<{ p: [number, number] }>({
      id: 'pulse-test', data: [{ p: [0, 0] }], getPosition: d => d.p, extensions: [ext],
    });
    const props = layer.props as unknown as Record<string, unknown>;
    expect(props.animTime).toBe(0);
    expect(props.getPulseAmp).toBe(0.15);
    expect(props.getPulseRate).toBe(1);
    expect(props.getPulsePhase).toBe(0);
    expect(layer.props.extensions).toHaveLength(1);
  });

  it('accepts overrides (accessor + animTime)', () => {
    const layer = new ScatterplotLayer<number>({
      id: 'pulse-test-2', data: [1, 2], getPosition: () => [0, 0],
      getPulseAmp: (d: number) => d * 0.1, animTime: 12.5, extensions: [ext],
    } as ConstructorParameters<typeof ScatterplotLayer<number>>[0]);
    const props = layer.props as unknown as Record<string, unknown>;
    expect(props.animTime).toBe(12.5);
    expect(typeof props.getPulseAmp).toBe('function');
  });

  it('getShaders: module + inject match the 9.2 contract', () => {
    const { self } = fakeLayer();
    const shaders = ext.getShaders.call(self);
    expect(shaders.modules).toEqual([pulseModule]);
    checkModule(pulseModule);
    checkInject(shaders);
    expect(shaders.inject).toBe(PULSE_INJECT);
    // radius is scaled through the size hook, and AA radius is kept in sync
    expect(shaders.inject['vs:DECKGL_FILTER_SIZE']).toContain('size *=');
    expect(shaders.inject['vs:#main-end']).toContain('outerRadiusPixels');
    expect(shaders.inject['vs:#main-start']).toContain('sin(pulseAnim.animTime');
  });

  it('initializeState registers exactly the attributes the shader declares', () => {
    const { self, addInstanced } = fakeLayer();
    ext.initializeState.call(self);
    const spec = addInstanced.mock.calls[0]![0] as Record<string, { size: number; accessor: string }>;
    expect(Object.keys(spec).sort()).toEqual(declaredAttributes(PULSE_INJECT).sort());
    expect(spec.instancePulsePhase!.accessor).toBe('getPulsePhase');
    expect(spec.instancePulseRate!.accessor).toBe('getPulseRate');
    expect(spec.instancePulseAmp!.accessor).toBe('getPulseAmp');
  });

  it('draw pushes animTime as the pulseAnim uniform', () => {
    const { self, setShaderModuleProps } = fakeLayer({ animTime: 3.25 });
    ext.draw.call(self);
    expect(setShaderModuleProps).toHaveBeenCalledWith({ pulseAnim: { animTime: 3.25 } });
  });

  it('is a no-op (no throw) when the layer has no attribute manager yet', () => {
    const self = { getAttributeManager: () => null } as unknown as Layer;
    expect(() => ext.initializeState.call(self)).not.toThrow();
  });
});

describe('RingExtension', () => {
  const ext = new RingExtension();

  it('merges its defaults into a real ScatterplotLayer', () => {
    const layer = new ScatterplotLayer<number>({
      id: 'ring-test', data: [0], getPosition: () => [0, 0], stroked: true, filled: false, extensions: [ext],
    });
    const props = layer.props as unknown as Record<string, unknown>;
    expect(props.ringFrom).toBe(0.15);
    expect(props.ringTo).toBe(1);
    expect(props.animTime).toBe(0);
    expect(props.getRingDuration).toBe(1);
    // default start is far in the past => unset slots are collapsed
    expect(props.getRingStart as number).toBeLessThan(-1e6);
  });

  it('getShaders: module + inject match the 9.2 contract', () => {
    const { self } = fakeLayer();
    const shaders = ext.getShaders.call(self);
    expect(shaders.modules).toEqual([ringModule]);
    checkModule(ringModule);
    checkInject(shaders);
    expect(shaders.inject).toBe(RING_INJECT);
    // collapse via size, fade via colour hook, AA/stroke kept in px in main-end
    expect(shaders.inject['vs:DECKGL_FILTER_SIZE']).toContain('size *=');
    expect(shaders.inject['vs:DECKGL_FILTER_COLOR']).toContain('color.a *=');
    expect(shaders.inject['vs:#main-end']).toContain('innerUnitRadius');
    // window test mirrors ringActive(): age >= 0 && p <= 1
    expect(shaders.inject['vs:#main-start']).toContain('ringAgeLocal >= 0.0 && ringPLocal <= 1.0');
  });

  it('shader constants match the TS mirror', async () => {
    const { RING_FADE_IN, RING_MIN_DURATION } = await import('./shader-math');
    expect(RING_INJECT['vs:#main-start']).toContain(`max(instanceRingDuration, ${RING_MIN_DURATION})`);
    expect(RING_INJECT['vs:#main-start']).toContain(`ringPLocal / ${RING_FADE_IN}`);
  });

  it('initializeState registers exactly the attributes the shader declares', () => {
    const { self, addInstanced } = fakeLayer();
    ext.initializeState.call(self);
    const spec = addInstanced.mock.calls[0]![0] as Record<string, { accessor: string }>;
    expect(Object.keys(spec).sort()).toEqual(declaredAttributes(RING_INJECT).sort());
    expect(spec.instanceRingStart!.accessor).toBe('getRingStart');
    expect(spec.instanceRingDuration!.accessor).toBe('getRingDuration');
  });

  it('draw pushes animTime + r0/r1', () => {
    const { self, setShaderModuleProps } = fakeLayer({ animTime: 9, ringFrom: 0.3, ringTo: 1.2 });
    ext.draw.call(self);
    expect(setShaderModuleProps).toHaveBeenCalledWith({ ringAnim: { animTime: 9, r0: 0.3, r1: 1.2 } });
  });
});

describe('DashFlowExtension', () => {
  const ext = new DashFlowExtension();

  it('merges its defaults into a real PathLayer', () => {
    const layer = new PathLayer<{ path: [number, number][] }>({
      id: 'dash-test', data: [{ path: [[0, 0], [1, 1]] }], getPath: d => d.path, extensions: [ext],
    });
    const props = layer.props as unknown as Record<string, unknown>;
    expect(props.dash).toBe(0.6);
    expect(props.gap).toBe(0.9);
    expect(props.speed).toBe(1.5);
    expect(props.animTime).toBe(0);
    expect(typeof props.getDashDistances).toBe('function');
  });

  it('getShaders: module + inject match the 9.2 contract', () => {
    const { self } = fakeLayer();
    const shaders = ext.getShaders.call(self);
    expect(shaders.modules).toEqual([dashFlowModule]);
    checkModule(dashFlowModule);
    checkInject(shaders);
    expect(shaders.inject).toBe(DASH_FLOW_INJECT);
    expect(shaders.inject['fs:#main-start']).toContain('discard');
    // varying declared on both sides
    expect(shaders.inject['vs:#decl']).toContain('out float vDashDist;');
    expect(shaders.inject['fs:#decl']).toContain('in float vDashDist;');
  });

  it('initializeState uses start/next shaderAttributes like TripsLayer', () => {
    const { self, addInstanced } = fakeLayer();
    ext.initializeState.call(self);
    const spec = addInstanced.mock.calls[0]![0] as Record<string, { accessor: string; shaderAttributes: Record<string, { vertexOffset: number }> }>;
    const attr = spec.dashDistances!;
    expect(attr.accessor).toBe('getDashDistances');
    expect(Object.keys(attr.shaderAttributes).sort()).toEqual(['instanceDashDist', 'instanceNextDashDist']);
    expect(attr.shaderAttributes.instanceDashDist!.vertexOffset).toBe(0);
    expect(attr.shaderAttributes.instanceNextDashDist!.vertexOffset).toBe(1);
    expect(declaredAttributes(DASH_FLOW_INJECT).sort()).toEqual(['instanceDashDist', 'instanceNextDashDist']);
  });

  it('draw pushes dash/gap/speed/animTime', () => {
    const { self, setShaderModuleProps } = fakeLayer({ dash: 1, gap: 2, speed: -3, animTime: 4 });
    ext.draw.call(self);
    expect(setShaderModuleProps).toHaveBeenCalledWith({ dashFlow: { dash: 1, gap: 2, speed: -3, animTime: 4 } });
  });
});

describe('cumulativeDistances', () => {
  it('returns one cumulative planar distance per vertex, starting at 0', () => {
    expect(cumulativeDistances([[0, 0], [3, 4], [3, 10]])).toEqual([0, 5, 11]);
    expect(cumulativeDistances([])).toEqual([]);
    expect(cumulativeDistances([[1, 1]])).toEqual([0]);
  });
});

describe('extensions equality (no spurious extensionsChanged per frame)', () => {
  it('separate instances of the same extension are equal', () => {
    expect(new PulseExtension().equals(new PulseExtension())).toBe(true);
    expect(new RingExtension().equals(new RingExtension())).toBe(true);
    expect(new DashFlowExtension().equals(new DashFlowExtension())).toBe(true);
  });

  it('distinct extension classes have distinct names', () => {
    const names = [PulseExtension, RingExtension, DashFlowExtension].map(c => c.extensionName);
    expect(new Set(names).size).toBe(3);
  });
});

describe('RingMaskExtension', () => {
  const ext = new RingMaskExtension();

  it('merges its defaults into a real stroked ScatterplotLayer', () => {
    const layer = new ScatterplotLayer<{ p: [number, number] }>({
      id: 'mask-test', data: [{ p: [0, 0] }], getPosition: d => d.p, stroked: true, filled: false, extensions: [ext],
    });
    const props = layer.props as unknown as Record<string, unknown>;
    expect(props.animTime).toBe(0);
    expect(props.getMaskFraction).toBe(1);
    expect(props.getMaskDashes).toBe(0);
  });

  it('declares a well-formed uniform module and real injection hook points', () => {
    const shaders = ext.getShaders.call(fakeLayer().self);
    expect(shaders.modules).toEqual([ringMaskModule]);
    checkModule(ringMaskModule);
    checkInject(shaders);
    expect(shaders.inject).toBe(RING_MASK_INJECT);
  });

  it('masks in the fragment stage and forwards per-instance values through varyings', () => {
    expect(RING_MASK_INJECT['fs:DECKGL_FILTER_COLOR']).toContain('geometry.uv');
    expect(RING_MASK_INJECT['fs:DECKGL_FILTER_COLOR']).toContain('discard');
    for (const v of ['vMaskFraction', 'vMaskDashes', 'vMaskSpin']) {
      expect(RING_MASK_INJECT['vs:#decl']).toContain(`out float ${v};`);
      expect(RING_MASK_INJECT['fs:#decl']).toContain(`in float ${v};`);
    }
  });

  it('registers every attribute the vertex shader reads', () => {
    const { self, addInstanced } = fakeLayer();
    ext.initializeState.call(self);
    const spec = addInstanced.mock.calls[0]![0] as Record<string, { accessor: string }>;
    expect(Object.keys(spec).sort()).toEqual(declaredAttributes(RING_MASK_INJECT).sort());
    expect(spec.instanceMaskFraction!.accessor).toBe('getMaskFraction');
  });

  it('pushes animTime each draw', () => {
    const { self, setShaderModuleProps } = fakeLayer({ animTime: 4.5 });
    ext.draw.call(self);
    expect(setShaderModuleProps).toHaveBeenCalledWith({ ringMask: { animTime: 4.5 } });
  });
});
