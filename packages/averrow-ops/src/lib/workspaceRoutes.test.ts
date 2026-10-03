import { describe, it, expect } from 'vitest';
import {
  LEGACY_TAB_PATHS, WORKSPACE_TABS, buildTabUrl, tabUrl,
} from './workspaceRoutes';

describe('buildTabUrl / tabUrl', () => {
  it('puts tab first and appends extra params', () => {
    expect(tabUrl('threats', { q: 'a&b c', ip: '1.2.3.4' })).toBe('/console?tab=threats&q=a%26b%20c&ip=1.2.3.4');
  });
  it('skips null/undefined params', () => {
    expect(tabUrl('brands', { q: undefined, focus: null })).toBe('/explore?tab=brands');
  });
  it('lets the tab param win over an incoming tab', () => {
    expect(buildTabUrl(WORKSPACE_TABS.alerts, new URLSearchParams('tab=threats&status=new')))
      .toBe('/console?tab=alerts&status=new');
  });
  it('keeps repeated params and the hash', () => {
    expect(buildTabUrl(WORKSPACE_TABS.feeds, new URLSearchParams('s=a&s=b'), '#row-3'))
      .toBe('/admin/operations?tab=feeds&s=a&s=b#row-3');
  });
});

describe('LEGACY_TAB_PATHS', () => {
  it('maps every legacy path to a defined workspace tab', () => {
    for (const key of Object.values(LEGACY_TAB_PATHS)) expect(WORKSPACE_TABS[key]).toBeDefined();
  });
  it('encodes ids placed in extra params', () => {
    expect(tabUrl('actors', { focus: 'a&b#c' })).toBe('/explore?tab=actors&focus=a%26b%23c');
  });
});
