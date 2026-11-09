// Brands screen facelift: the bespoke amber tab bar is the kit Tabs, headings are sentence-case sans at >= 12px, and
// the glow decorations are gone. Source guard + behaviour.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { BrandsV3 } from './Brands';

const mocks = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));
vi.mock('./components/BrandsGrid', () => ({ BrandsGrid: () => <div>GRID PANE</div> }));
vi.mock('@/hooks/useBrands', () => ({ useBrandStats: vi.fn() }));
vi.mock('@/hooks/useBrandMovers', () => ({ useBrandMovers: vi.fn() }));
vi.mock('@/hooks/useBrandAggregates', () => ({
  useEmailSecurityAggregate: vi.fn(),
  usePressureAggregate: vi.fn(),
  useCompositionAggregate: vi.fn(),
  usePostureAggregate: vi.fn(),
}));
vi.mock('@/hooks/useBrandCandidates', () => ({
  useBrandCandidates: () => ({ data: { candidates: [], total: 0 }, isLoading: false, isError: false, refetch: vi.fn() }),
  usePromoteBrandCandidate: () => ({ mutate: vi.fn(), isPending: false }),
  useRejectBrandCandidate: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { useBrandStats } from '@/hooks/useBrands';
import { useBrandMovers } from '@/hooks/useBrandMovers';
import { useEmailSecurityAggregate, usePressureAggregate, useCompositionAggregate, usePostureAggregate } from '@/hooks/useBrandAggregates';

const hooks = [useBrandStats, useBrandMovers, useEmailSecurityAggregate, usePressureAggregate, useCompositionAggregate, usePostureAggregate] as Array<ReturnType<typeof vi.fn>>;

const src = readFileSync(resolve(__dirname, 'Brands.tsx'), 'utf8');

describe('Brands.tsx source guard', () => {
  it('has no sub-12px text, all-caps, glow, amber active state or white-alpha utilities', () => {
    expect(src).not.toMatch(/text-\[(?:8|9|10|11)px\]/);
    expect(src).not.toMatch(/fontSize: (?:8|9|10|11)\b/);
    expect(src).not.toMatch(/uppercase|tracking-(?:wide|wider|widest|\[)|letterSpacing/);
    expect(src).not.toMatch(/textShadow|radial-gradient/);
    expect(src).not.toMatch(/amber|ops-accent-/);
    expect(src).not.toMatch(/text-white\/|bg-white\/|border-white\/|from-white\/|via-white\//);
  });

  it('uses the kit Tabs and no hand-rolled tab buttons', () => {
    expect(src).toMatch(/<Tabs\b/);
    expect(src).not.toMatch(/SectionLabel/);
  });
});

describe('Brands tabs', () => {
  beforeEach(() => {
    mocks.role = 'admin';
    hooks.forEach(h => h.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }));
  });

  it('are a labelled kit tablist in sentence case with arrow-key navigation', async () => {
    renderWithProviders(<BrandsV3 />);
    const list = await screen.findByRole('tablist', { name: 'Brands views' });
    expect(list).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab', { name: /Intel|All brands|Prospects/ });
    expect(tabs.map(t => t.textContent)).toEqual(['Intel', 'All brands', 'Prospects']);
    expect(screen.getByRole('tab', { name: 'Intel' })).toHaveAttribute('aria-selected', 'true');
    screen.getByRole('tab', { name: 'Intel' }).focus();
    await userEvent.keyboard('{ArrowRight}{Enter}');
    expect(await screen.findByText('GRID PANE')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All brands' })).toHaveAttribute('aria-selected', 'true');
  });

  it('hero tiles and card headings render in sentence case', () => {
    renderWithProviders(<BrandsV3 />);
    for (const t of ['Total tracked', 'New this week', 'Fastest rising', 'Top attack']) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getByText('Defense').tagName).toBe('H2');
    expect(screen.getByText('Email security grade')).toHaveClass('text-type-label');
  });
});
