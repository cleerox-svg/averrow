/**
 * Minimal structural types for the shader pieces our LayerExtensions return.
 * (@luma.gl/shadertools is a transitive dependency; we don't import it directly.)
 */

export interface AnimShaderModule {
  /** Also the instance name of the uniform block (`pulseAnim.animTime`) and the shaderInputs key. */
  name: string;
  vs?: string;
  fs?: string;
  uniformTypes: Record<string, 'f32' | 'i32'>;
}

export interface AnimShaders {
  modules: AnimShaderModule[];
  inject: Record<string, string>;
}
