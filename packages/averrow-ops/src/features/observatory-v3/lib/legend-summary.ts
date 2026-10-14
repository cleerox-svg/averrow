/**
 * The one line the closed legend chip shows. It carries state, not just a title:
 * loading, failed, empty (a lens that drew nothing must not look like "all clear"),
 * or a count of what is drawn.
 */

import type { LensId } from './lenses';

export interface QueryLike { isLoading: boolean; error: Error | null }

export interface SummaryInput {
  lens: LensId;
  view: 'points' | 'heat';
  measure: 'index' | 'raw' | 'bot';
  /** Nodes drawn on the Threats lens (null = not loaded). */
  nodes: number | null;
  threats: QueryLike;
  operations: QueryLike & { count: number | null };
  movement: QueryLike & { count: number | null; events: number };
  hosting: QueryLike & { count: number | null };
  baseline: QueryLike & { count: number | null };
  bot: QueryLike & { count: number | null };
  campaigns: QueryLike & { count: number | null };
  actors: QueryLike & { selected: boolean; countries: number | null; empty: boolean };
}

export type SummaryTone = 'ok' | 'loading' | 'error' | 'empty';
export interface Summary { text: string; tone: SummaryTone }

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function from(q: QueryLike, count: number | null, noun: [string, string?], emptyText: string): Summary {
  if (q.error && count === null) return { text: 'failed to load', tone: 'error' };
  if (q.isLoading && count === null) return { text: 'loading…', tone: 'loading' };
  if (count === null) return { text: 'no data', tone: 'empty' };
  if (count === 0) return { text: emptyText, tone: 'empty' };
  return { text: plural(count, noun[0], noun[1]), tone: 'ok' };
}

export function legendSummary(i: SummaryInput): Summary {
  switch (i.lens) {
    case 'threats':
      if (i.view === 'heat') return { text: 'density', tone: 'ok' };
      return from(i.threats, i.nodes, ['node'], 'nothing mapped');
    case 'operations': return from(i.operations, i.operations.count, ['operation'], 'none placeable');
    case 'movement': {
      const s = from(i.movement, i.movement.count, ['hop'], i.movement.events === 0 ? 'no moves' : 'none placeable');
      return s;
    }
    case 'hosting': return from(i.hosting, i.hosting.count, ['provider'], 'none to show');
    case 'baseline':
      return i.measure === 'bot'
        ? from(i.bot, i.bot.count, ['country', 'countries'], 'no data')
        : from(i.baseline, i.baseline.count, ['country', 'countries'], 'no data');
    case 'campaigns': return from(i.campaigns, i.campaigns.count, ['campaign'], 'none placeable');
    case 'actors': {
      if (!i.actors.selected) return { text: 'pick an actor', tone: 'empty' };
      if (i.actors.error && i.actors.countries === null) return { text: 'failed to load', tone: 'error' };
      if (i.actors.isLoading && i.actors.countries === null) return { text: 'loading…', tone: 'loading' };
      if (i.actors.empty) return { text: 'no attributed infra', tone: 'empty' };
      return { text: plural(i.actors.countries ?? 0, 'country', 'countries'), tone: 'ok' };
    }
  }
}
