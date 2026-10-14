/**
 * Tiny identity-keyed memoisation for derived layer data.
 *
 * deck.gl re-reads a layer's attributes whenever its `data` prop changes
 * identity, so a `.filter()` in the frame path would re-upload buffers sixty
 * times a second. Everything derived from a model (or a model + selection) is
 * therefore computed ONCE here and handed to the layers as the same array every
 * frame; only uniforms (animTime / currentTime / opacity) change per frame.
 */

/** Memoise `compute(model)` on the model object's identity. */
export function memoByModel<M extends object, V>(compute: (model: M) => V): (model: M) => V {
  const cache = new WeakMap<M, V>();
  return model => {
    let hit = cache.get(model);
    if (hit === undefined) {
      hit = compute(model);
      cache.set(model, hit);
    }
    return hit;
  };
}

/** Memoise `compute(model, key)` on (model identity, key). Keeps the 8 most recent keys per model. */
export function memoByModelAndKey<M extends object, K, V>(compute: (model: M, key: K) => V): (model: M, key: K) => V {
  const cache = new WeakMap<M, Map<K, V>>();
  return (model, key) => {
    let inner = cache.get(model);
    if (!inner) {
      inner = new Map();
      cache.set(model, inner);
    }
    if (inner.has(key)) return inner.get(key) as V;
    if (inner.size >= 8) inner.delete(inner.keys().next().value as K);
    const value = compute(model, key);
    inner.set(key, value);
    return value;
  };
}
