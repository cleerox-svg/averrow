/**
 * Layer classes that draw (and pick) in the PRIMARY world copy only: the flat Operations arcs and their labels.
 * See lib/world-copies.ts for why this is a layer override and not a deck `layerFilter`.
 */

import { PathLayer, TextLayer } from '@deck.gl/layers';
import type { Layer, _ConstructorOf as ConstructorOf } from '@deck.gl/core';
import { isOffsetCopy } from '../lib/world-copies';

type DrawArgs = Parameters<Layer['_drawLayer']>[0];

export class PrimaryPathLayer<D = unknown, P extends object = object> extends PathLayer<D, P> {
  static override layerName = 'PrimaryPathLayer';
  override _drawLayer(args: DrawArgs): void {
    if (isOffsetCopy(args)) return;
    super._drawLayer(args);
  }
}

/** The one method of a deck layer the wrapper touches (a concrete shape: `Layer` itself is abstract). */
interface Drawable { _drawLayer(args: DrawArgs): void }
type DrawableCtor = new (props: unknown) => Drawable;
const wrapped = new WeakMap<object, DrawableCtor>();

/** A sublayer class (the text's glyph / background layers) that skips the offset copies. */
function primaryOnly(Base: DrawableCtor): DrawableCtor {
  let hit = wrapped.get(Base);
  if (!hit) {
    hit = class PrimarySub extends Base {
      override _drawLayer(args: DrawArgs): void {
        if (isOffsetCopy(args)) return;
        super._drawLayer(args);
      }
    };
    wrapped.set(Base, hit);
  }
  return hit;
}

export class PrimaryTextLayer<D = unknown, P extends object = object> extends TextLayer<D, P> {
  static override layerName = 'PrimaryTextLayer';
  override getSubLayerClass<T extends Layer>(id: string, Default: ConstructorOf<T>): ConstructorOf<T> {
    return primaryOnly(super.getSubLayerClass(id, Default) as unknown as DrawableCtor) as unknown as ConstructorOf<T>;
  }
}
