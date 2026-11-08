// Phase 6 screen 2: the facelifted Overview. Labels are sentence-case sans at
// the label scale, cards are flat, controls are kit buttons, and the Overview-only
// stylesheets use tokens (no hex, no literal motion) and respect reduced motion.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, within, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { createHomeApi } from '@/test/homeApi';
import { OverviewV4 } from './OverviewV4';
import { PlatformStatusFlyout } from '@/components/PlatformStatusFlyout';
import type { PlatformStatus } from '@averrow/shared';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/useInstallPrompt', () => ({
  useInstallPrompt: () => ({ isStandalone: true, canInstall: false, isIos: false, install: vi.fn() }),
}));
vi.mock('@/hooks/usePlatformStatus', () => ({ usePlatformStatus: vi.fn() }));

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';

const get = api.get as unknown as ReturnType<typeof vi.fn>;
const auth = useAuth as unknown as ReturnType<typeof vi.fn>;
const status = usePlatformStatus as unknown as ReturnType<typeof vi.fn>;

const STATUS: PlatformStatus = {
  generated_at: '2026-11-08T00:00:00Z',
  overall: 'operational',
  overall_note: 'All good',
  window_days: 30,
  categories: [
    { category: 'feeds', realtime: 'operational', realtime_note: '', uptime_30d_pct: 99.9 },
    { category: 'agents', realtime: 'degraded', realtime_note: 'One agent slow', uptime_30d_pct: 98.2 },
    { category: 'processing', realtime: 'outage', realtime_note: '', uptime_30d_pct: 90 },
  ],
} as unknown as PlatformStatus;

const SRC = resolve(__dirname, '..', '..');
const css = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

function mount() {
  const fake = createHomeApi({
    alerts: { new_count: 4, critical_count: 1 },
    incidents: [{ severity: 'critical', created_at: new Date().toISOString() }],
  });
  get.mockImplementation(fake.handler);
  auth.mockReturnValue({ user: { name: 'Ada Lovelace', role: 'super_admin' }, isSuperAdmin: true });
  return renderWithProviders(<OverviewV4 />);
}

describe('OverviewV4 facelift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.pushState({}, '', '/');
    stubMatchMedia(true);
    status.mockReturnValue({ data: STATUS, isLoading: false, refetch: vi.fn() });
  });

  it('the hero label is sentence case sans, and the wrapper scopes the flat look', async () => {
    const { container } = mount();
    const crumb = await screen.findByText('Command center');
    expect(crumb).toHaveClass('console-crumb');
    expect(screen.queryByText('COMMAND CENTER')).not.toBeInTheDocument();
    expect(container.querySelector('.home-v4 .console-title')).not.toBeNull();
  });

  it('section headings use the sentence-case label style, never mono caps', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Platform pulse' });
    for (const name of ['Needs you now', 'Everything else', 'Platform pulse']) {
      const h = screen.getByRole('heading', { name });
      expect(h).toHaveClass('home-label');
      expect(h.className).not.toMatch(/font-mono|uppercase/);
      expect(h.textContent).toBe(name);
    }
  });

  it('queue rows: sev-text numeral, sans source chip, mono timestamp, kit buttons', async () => {
    mount();
    const region = await screen.findByRole('region', { name: 'Needs you now' });
    const row = await within(region).findAllByRole('listitem');
    const first = row[0]!;
    const rank = first.querySelector('.queue-rank') as HTMLElement;
    expect(rank.style.color).toMatch(/^var\(--sev-(critical|high|medium|low)-text\)$/);
    expect(rank.style.borderColor).toMatch(/^var\(--sev-(critical|high|medium|low)\)$/);
    expect(first.querySelector('.queue-source')).not.toBeNull();
    const btn = within(first).getByRole('button');
    expect(btn.className).toMatch(/rounded-\[10px\]/); // the shared-kit Button
    expect(btn).toHaveAccessibleName(/.+: .+/);
  });

  it('platform pulse cells are sentence case, wrap in a responsive grid, and use 12px sans badges', async () => {
    const { container } = mount();
    await screen.findByRole('heading', { name: 'Platform pulse' });
    const cells = container.querySelectorAll('[data-pulse-cell]');
    expect(cells).toHaveLength(3);
    expect(container.querySelector('.pulse-grid')).not.toBeNull();
    expect(container.querySelector('.grid-cols-3')).toBeNull();
    expect(within(cells[0] as HTMLElement).getByText('Feeds')).toHaveClass('home-label');
  });

  it('digest chips are the token-hover class, not underline-on-hover', async () => {
    mount();
    const nav = await screen.findByRole('navigation', { name: 'Everything else' });
    for (const a of within(nav).getAllByRole('link')) {
      expect(a).toHaveClass('digest-chip');
      expect(a.className).not.toMatch(/hover:underline|font-mono/);
    }
  });
});

describe('PlatformStatusFlyout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(false);
    status.mockReturnValue({ data: STATUS, isLoading: false, refetch: vi.fn() });
  });

  it('the trigger is a CSS-styled button: no JS hover handlers, no inline hover colours, no <style> tag', () => {
    const { container } = renderWithProviders(<PlatformStatusFlyout />);
    const trigger = screen.getByRole('button', { expanded: false });
    expect(trigger).toHaveClass('psf-trigger');
    expect(trigger.getAttribute('style')).toBeNull();
    fireEvent.mouseEnter(trigger);
    expect(trigger.getAttribute('style')).toBeNull();
    fireEvent.click(trigger);
    expect(container.querySelector('style')).toBeNull();
  });

  it('opens the panel with Badge-based status pills and closes on Escape', () => {
    renderWithProviders(<PlatformStatusFlyout />);
    fireEvent.click(screen.getByRole('button'));
    const dialog = screen.getByRole('dialog', { name: 'Platform availability' });
    expect(within(dialog).getByText('Operational')).toBeInTheDocument();
    expect(within(dialog).getByText('Degraded')).toBeInTheDocument();
    expect(within(dialog).getByText('Outage')).toBeInTheDocument();
    expect(within(dialog).getByText('Availability · last 30 days')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has a visible focus style on the trigger (--focus-ring; --text-primary in light)', () => {
    const src = css('components/platform-status-flyout.css');
    expect(src).toMatch(/\.psf-trigger:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
    expect(src).toMatch(/\[data-theme="light"\] \.psf-trigger:focus-visible\s*\{[^}]*var\(--text-primary\)/);
  });

  it('keeps the entrance keyframe in CSS and turns it off for reduced motion', () => {
    const src = css('components/platform-status-flyout.css');
    expect(src).toMatch(/@keyframes psf-in/);
    expect(src).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.psf-panel\s*\{\s*animation:\s*none/);
  });
});

describe('Overview stylesheets', () => {
  const FILES = [
    'features/home/home.css',
    'features/briefing/briefing.css',
    'components/platform-status-flyout.css',
    'components/install-app.css',
  ];

  it.each(FILES)('%s uses tokens: no hex or rgb colours', (f) => {
    const src = css(f).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba?\(/);
  });

  it.each(FILES)('%s has no literal durations outside a motion-token fallback', (f) => {
    const src = css(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/var\(--[a-z-]+,\s*[^)]*\)/g, '');
    expect(src).not.toMatch(/(transition|animation)[^;{}]*\b\d+(\.\d+)?m?s\b/);
  });

  it.each(FILES)('%s has no looping animation', (f) => {
    expect(css(f)).not.toMatch(/infinite/);
  });

  it('the flat card look is scoped under the accent and the Overview wrapper', () => {
    const src = css('features/home/home.css');
    const m = src.match(/:root\[data-accent\] \.home-v4\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/--card-radius:\s*var\(--radius-lg\)/);
    expect(m![1]).toMatch(/--card-shadow:\s*none/);
  });

  it('the install step number has no glow', () => {
    expect(css('components/install-app.css')).not.toMatch(/box-shadow/);
  });

  it('does not touch the shell token block', () => {
    expect(css('components/layout/shell-v4.css')).toMatch(/--card-radius: 18px/);
  });
});
