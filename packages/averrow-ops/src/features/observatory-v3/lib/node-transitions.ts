/**
 * Threat-node transitions: when the period (or a filter) changes, the nodes ease their radius and colour to the new
 * values instead of snapping (deck.gl attribute `transitions`, ~500 ms).
 *
 * deck.gl interpolates an attribute BY INSTANCE INDEX between the old and the new `data`. Two periods hold different node
 * sets, so the raw arrays would be matched up wrongly (a node would morph into some unrelated one). The fix is a stable id
 * per node (`nodeKey`: the grid cell, which is what the API's node IS; its country is not unique) and a SLOT per id: the
 * same id always lands at the same index. A node absent in the new period keeps its slot as a GHOST (zero count, so the
 * layer draws it fully transparent and it fades out), and a node new in this period is first placed as a ghost and then
 * filled one frame later, so it eases in instead of popping (deck.gl would otherwise start new instances at their end value).
 *
 * Pure (no React / deck.gl) apart from `useSlottedNodes`, so the slot logic is unit-tested directly. Under reduced motion
 * nothing here applies: no transitions and no ghosts, the data goes to the layer as it is.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThreatPoint } from '@/hooks/useObservatory';
import { easeOutCubic } from '../anim/shader-math';
import { nodeKey } from './url-state';

/** How long the radius / colour ease takes, ms. */
export const NODE_TRANSITION_MS = 500;

/** Slots kept before the registry starts over (a long session with a filter that keeps changing). One instant frame at the reset. */
export const MAX_NODE_SLOTS = 6000;

/** The `transitions` prop for the nodes layer: radius + colour ease; `undefined` (instant) under reduced motion. */
export function nodeTransitions(reducedMotion: boolean): { getRadius: { duration: number; easing: (t: number) => number }; getFillColor: { duration: number; easing: (t: number) => number } } | undefined {
  if (reducedMotion) return undefined;
  return {
    getRadius: { duration: NODE_TRANSITION_MS, easing: easeOutCubic },
    getFillColor: { duration: NODE_TRANSITION_MS, easing: easeOutCubic },
  };
}

/** A node that is not in the current data: kept in its slot with no threats, so the layer fades it out. */
export const isGhost = (n: { threat_count: number }): boolean => !(n.threat_count > 0);

/** `isGhost` for something deck.gl hands back as `unknown` (a picked object may be a node, an arc, a lens object ...). */
export function isGhostNode(o: unknown): boolean {
  if (typeof o !== 'object' || o === null) return false;
  const n = o as Partial<ThreatPoint>;
  return typeof n.threat_count === 'number' && 'critical' in n && 'top_threat_type' in n && !(n.threat_count > 0);
}

function ghostOf(proto: ThreatPoint): ThreatPoint {
  return { ...proto, threat_count: 0, critical: 0, high: 0, medium: 0, low: 0 };
}

export interface SlotLayout {
  /** One entry per slot, in slot order: the node when it is in this data, else its ghost. */
  data: ThreatPoint[];
  /** Slots created by this call whose real value was held back (see `deferNew`): fill them in with another call. */
  deferred: number;
}

export class NodeSlotRegistry {
  private readonly slotOf = new Map<string, number>();
  private readonly protos: ThreatPoint[] = [];

  constructor(private readonly max: number = MAX_NODE_SLOTS) {}

  get size(): number { return this.protos.length; }

  reset(): void {
    this.slotOf.clear();
    this.protos.length = 0;
  }

  /**
   * Lay `nodes` out by slot. `deferNew` places nodes that have no slot yet as ghosts (they are in the registry afterwards,
   * so the next call shows them for real and they ease in). The very first layout is never deferred: the initial load
   * should not animate every node in. A node set that would overflow the registry resets it (that frame is instant).
   */
  layout(nodes: readonly ThreatPoint[], deferNew: boolean): SlotLayout {
    const wasEmpty = this.protos.length === 0;
    const present = new Map<number, ThreatPoint>();
    const fresh = new Set<number>();
    for (const n of nodes) {
      const id = nodeKey(n);
      let slot = this.slotOf.get(id);
      if (slot === undefined) {
        if (this.protos.length >= this.max) {
          this.reset();
          return this.layout(nodes, false);
        }
        slot = this.protos.length;
        this.slotOf.set(id, slot);
        this.protos.push(n);
        fresh.add(slot);
      } else {
        this.protos[slot] = n;
      }
      present.set(slot, n);
    }
    const hold = deferNew && !wasEmpty;
    const data = this.protos.map((proto, slot) => {
      const node = present.get(slot);
      if (!node) return ghostOf(proto);
      return hold && fresh.has(slot) ? ghostOf(node) : node;
    });
    // Nothing held back and nothing missing, in the input's own order: hand the input back (identity shared with the halos).
    const same = data.length === nodes.length && data.every((d, i) => d === nodes[i]);
    return { data: same ? (nodes as ThreatPoint[]) : data, deferred: hold ? fresh.size : 0 };
  }
}

/**
 * The nodes for the layer, slotted so deck.gl can interpolate them. Identity follows the input: the same `nodes` (and
 * `enabled`) give the same array until a deferred node is filled in, which costs one extra render a frame later.
 */
export function useSlottedNodes(nodes: ThreatPoint[], enabled: boolean): ThreatPoint[] {
  const [registry] = useState(() => new NodeSlotRegistry());
  const [settled, setSettled] = useState(0);
  const deferred = useRef(0);
  const slotted = useMemo(() => {
    if (!enabled) {
      registry.reset();
      deferred.current = 0;
      return nodes;
    }
    const out = registry.layout(nodes, true);
    deferred.current = out.deferred;
    return out.data;
    // `settled` re-runs the layout once the new slots exist, so they are drawn for real.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, enabled, registry, settled]);
  useEffect(() => {
    if (deferred.current === 0) return;
    deferred.current = 0;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => setSettled(n => n + 1)) : null;
    if (raf === null) setSettled(n => n + 1);
    return () => { if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf); };
  }, [slotted]);
  return slotted;
}
