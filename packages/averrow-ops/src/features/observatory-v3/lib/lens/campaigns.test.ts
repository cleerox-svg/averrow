import { describe, it, expect } from 'vitest';
import type { CampaignGeo } from '@/hooks/useObservatoryLenses';
import { buildCampaignsModel, MAX_ARCS, MAX_ADVERSARIES, ACTIVE_COLOR, HISTORIC_COLOR } from './campaigns';

const camp = (o: Partial<CampaignGeo> & { id: string }): CampaignGeo => ({
  name: o.id, slug: o.id, status: 'active', conflict: null, adversary_countries: ['RU'], target_countries: ['UA'],
  threat_actors: [], start_date: null, curated: true, ...o,
});

describe('buildCampaignsModel', () => {
  it('draws one arc per adversary × target pair, curated style by status', () => {
    const m = buildCampaignsModel([
      camp({ id: 'a', adversary_countries: ['RU', 'BY'], target_countries: ['UA', 'PL', 'LT'] }),
      camp({ id: 'h', status: 'historical' }),
    ]);
    expect(m.arcs.filter(a => a.campaignId === 'a')).toHaveLength(6);
    expect(m.arcs.find(a => a.campaignId === 'a')!.color).toEqual(ACTIVE_COLOR);
    expect(m.arcs.find(a => a.campaignId === 'h')!.color).toEqual(HISTORIC_COLOR);
    expect(m.drawn.has('a')).toBe(true);
  });
  it('skips same-country pairs and unplaceable countries (counted)', () => {
    const m = buildCampaignsModel([camp({ id: 'x', adversary_countries: ['RU', 'ZZ'], target_countries: ['RU', 'UA'] })]);
    expect(m.arcs.map(a => `${a.from}-${a.to}`)).toEqual(['RU-UA']);
    expect(m.unplaced).toBe(1);
  });
  it('a campaign with no placeable pair is not drawn', () => {
    const m = buildCampaignsModel([camp({ id: 'e', adversary_countries: [], target_countries: ['UA'] })]);
    expect(m.arcs).toHaveLength(0);
    expect(m.drawn.has('e')).toBe(false);
    expect(m.byId.has('e')).toBe(true);
  });
  it('caps adversaries and total arcs, keeping active campaigns first', () => {
    const many = Array.from({ length: 20 }, (_, i) => camp({
      id: `c${i}`, status: i === 19 ? 'active' : 'historical',
      adversary_countries: ['RU', 'CN', 'IR', 'KP', 'BY', 'SY'], target_countries: ['US', 'GB', 'DE', 'FR', 'JP', 'AU', 'CA', 'IT'],
    }));
    const m = buildCampaignsModel(many);
    expect(m.arcs.length).toBeLessThanOrEqual(MAX_ARCS);
    expect(m.drawn.has('c19')).toBe(true);
    expect(m.arcs.filter(a => a.campaignId === 'c19')).toHaveLength(MAX_ADVERSARIES * 8);
    expect(m.truncated).toBeGreaterThan(0);
  });
  it('arc distances start at 0 and match the path', () => {
    const a = buildCampaignsModel([camp({ id: 'a' })]).arcs[0];
    expect(a.distances[0]).toBe(0);
    expect(a.distances).toHaveLength(a.path.length);
  });
});
