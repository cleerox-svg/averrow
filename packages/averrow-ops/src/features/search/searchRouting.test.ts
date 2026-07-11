// Tests for the shared search routing table (features/search/searchRouting.ts).
//
// This is the DRY-contract lock: both the ⌘K command palette
// (components/layout/CommandPalette.tsx) and the persistent /search
// results page (features/search/SearchResults.tsx) resolve every result
// row and "view all" link through SEARCH_GROUPS / searchPageUrl. If this
// table drifts, the two surfaces silently disagree on where a given
// result type navigates.

import { describe, it, expect } from 'vitest';
import { SEARCH_GROUPS, searchPageUrl } from './searchRouting';
import type { SearchResultType } from '@/hooks/useGlobalSearch';

function groupFor(type: SearchResultType) {
  const group = SEARCH_GROUPS.find(g => g.type === type);
  if (!group) throw new Error(`no SEARCH_GROUPS entry for type: ${type}`);
  return group;
}

describe('SEARCH_GROUPS — fixed render order', () => {
  it('is BRANDS -> THREAT ACTORS -> PROVIDERS -> CAMPAIGNS -> APPS, shared by both surfaces', () => {
    expect(SEARCH_GROUPS.map(g => g.type)).toEqual([
      'brand',
      'threat_actor',
      'provider',
      'campaign',
      'app_store',
    ]);
    expect(SEARCH_GROUPS.map(g => g.heading)).toEqual([
      'BRANDS',
      'THREAT ACTORS',
      'PROVIDERS',
      'CAMPAIGNS',
      'APPS',
    ]);
  });
});

describe('SEARCH_GROUPS — routeFor(id)', () => {
  it('brand routes to /brands/:id', () => {
    expect(groupFor('brand').routeFor('b1')).toBe('/brands/b1');
  });

  it('threat_actor routes to /threat-actors?focus=:id', () => {
    expect(groupFor('threat_actor').routeFor('t1')).toBe('/threat-actors?focus=t1');
  });

  it('provider routes to /providers?focus=:id', () => {
    expect(groupFor('provider').routeFor('p1')).toBe('/providers?focus=p1');
  });

  it('campaign routes to /campaigns/:id', () => {
    expect(groupFor('campaign').routeFor('c1')).toBe('/campaigns/c1');
  });

  it('app_store routes to the cross-brand /apps overview regardless of id (no per-listing destination yet)', () => {
    expect(groupFor('app_store').routeFor('b42')).toBe('/apps');
    expect(groupFor('app_store').routeFor('anything-else')).toBe('/apps');
  });
});

describe('SEARCH_GROUPS — viewAllTo(q)', () => {
  it('brand carries the query to /brands?q=', () => {
    expect(groupFor('brand').viewAllTo('acme')).toBe('/brands?q=acme');
  });

  it('threat_actor carries the query to /threat-actors?q=', () => {
    expect(groupFor('threat_actor').viewAllTo('acme')).toBe('/threat-actors?q=acme');
  });

  it('provider carries the query to /providers?q=', () => {
    expect(groupFor('provider').viewAllTo('acme')).toBe('/providers?q=acme');
  });

  it('campaign carries the query to /campaigns?q=', () => {
    expect(groupFor('campaign').viewAllTo('acme')).toBe('/campaigns?q=acme');
  });

  it('app_store ignores the query and always lands on /apps (no ?q= reader there)', () => {
    expect(groupFor('app_store').viewAllTo('acme')).toBe('/apps');
    expect(groupFor('app_store').viewAllTo('')).toBe('/apps');
  });

  it('URL-encodes special characters for every query-carrying group', () => {
    expect(groupFor('brand').viewAllTo('a&b c')).toBe('/brands?q=a%26b%20c');
    expect(groupFor('threat_actor').viewAllTo('a&b c')).toBe('/threat-actors?q=a%26b%20c');
    expect(groupFor('provider').viewAllTo('a&b c')).toBe('/providers?q=a%26b%20c');
    expect(groupFor('campaign').viewAllTo('a&b c')).toBe('/campaigns?q=a%26b%20c');
  });
});

describe('searchPageUrl', () => {
  it('builds /search?q=<encoded query>', () => {
    expect(searchPageUrl('acme')).toBe('/search?q=acme');
  });

  it('URL-encodes special characters, including & and spaces', () => {
    expect(searchPageUrl('a&b c')).toBe('/search?q=a%26b%20c');
  });

  it('round-trips an empty string', () => {
    expect(searchPageUrl('')).toBe('/search?q=');
  });
});
