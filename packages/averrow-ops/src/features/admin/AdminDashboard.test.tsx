import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { AdminDashboard } from './AdminDashboard';

const mockSystemHealthData = {
  threats: { total: 50000, today: 3209, week: 18500 },
  agents: { total: 229, successes: 181, errors: 0 },
  feeds: { pulls: 266, ingested: 6245 },
  sessions: { count: 94 },
  migrations: { total: 45, last_run: '2026-03-27T00:00:00Z', last_name: '0047_agent_activity_log.sql' },
  audit: { count: 283 },
  trend: [
    { day: '2026-03-14', count: 5461 },
    { day: '2026-03-15', count: 2471 },
    { day: '2026-03-16', count: 12754 },
    { day: '2026-03-17', count: 3405 },
  ],
  infrastructure: {
    mainDb: { name: 'trust-radar-v2', sizeMb: 79.5, tables: 57, region: 'ENAM' },
    auditDb: { name: 'trust-radar-v2-audit', sizeKb: 180, tables: 2, region: 'ENAM' },
    worker: { name: 'trust-radar', platform: 'Cloudflare Workers' },
    kvNamespaces: [
      { name: 'trust-radar-cache' },
      { name: 'SESSIONS' },
      { name: 'CACHE' },
    ],
  },
};

vi.mock('@/hooks/useSystemHealth', () => ({
  useSystemHealth: vi.fn().mockReturnValue({
    data: null,
    isLoading: false,
  }),
}));

// Mock recharts to avoid canvas/SVG rendering issues in test
vi.mock('recharts', () => ({
  AreaChart: ({ children }: { children: React.ReactNode }) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { useSystemHealth } from '@/hooks/useSystemHealth';

describe('AdminDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({
      data: mockSystemHealthData,
      isLoading: false,
    });
  });

  it('renders page header with operational badge', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('System Health')).toBeInTheDocument();
    expect(screen.getByText('OPERATIONAL')).toBeInTheDocument();
  });

  it('renders top stat row with correct values', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('3,209')).toBeInTheDocument();
    // 6,245 appears in the StatCard and again in the agent performance subline
    expect(screen.getAllByText('6,245').length).toBeGreaterThanOrEqual(1);
    // 229 appears in both stat card and agent performance section
    expect(screen.getAllByText('229').length).toBeGreaterThanOrEqual(1);
    // 94 appears in stat card, KV sessions note, and compliance row
    expect(screen.getAllByText(/94/).length).toBeGreaterThanOrEqual(1);
  });

  it('renders section labels', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
    // "Activity" now reads "Activity (14d)" — match by prefix
    expect(screen.getByText(/Activity/)).toBeInTheDocument();
  });

  it('renders database cards', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('trust-radar-v2')).toBeInTheDocument();
    expect(screen.getByText('trust-radar-v2-audit')).toBeInTheDocument();
    expect(screen.getByText('PRIMARY')).toBeInTheDocument();
    expect(screen.getByText('AUDIT')).toBeInTheDocument();
  });

  it('renders worker status', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('trust-radar')).toBeInTheDocument();
    expect(screen.getByText('Cloudflare Workers')).toBeInTheDocument();
  });

  it('renders KV namespaces', () => {
    renderWithProviders(<AdminDashboard />);
    // KV namespace names are joined in a compact row — match each by substring.
    expect(screen.getByText(/trust-radar-cache/)).toBeInTheDocument();
    expect(screen.getByText(/SESSIONS/)).toBeInTheDocument();
    expect(screen.getByText(/CACHE/)).toBeInTheDocument();
  });

  it('renders agent performance stats', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText(/success rate/)).toBeInTheDocument();
  });

  it('renders compliance checklist', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('Data residency: ENAM')).toBeInTheDocument();
    expect(screen.getByText('Audit logging: Active')).toBeInTheDocument();
    expect(screen.getByText('283 events recorded')).toBeInTheDocument();
  });

  it('renders migration info', () => {
    renderWithProviders(<AdminDashboard />);
    // "45 migrations run" is now a single text node; match by substring.
    expect(screen.getByText(/45 migrations run/)).toBeInTheDocument();
    expect(screen.getByText('0047_agent_activity_log.sql')).toBeInTheDocument();
    // Migration freshness now appears as the "UP TO DATE" badge label.
    expect(screen.getByText(/UP TO DATE/i)).toBeInTheDocument();
  });

  it('renders threat trend chart', () => {
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('shows degraded badge when errors exist', () => {
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        ...mockSystemHealthData,
        agents: { total: 229, successes: 180, errors: 3 },
      },
      isLoading: false,
    });
    renderWithProviders(<AdminDashboard />);
    expect(screen.getByText('DEGRADED')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    (useSystemHealth as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: true });
    const { container } = renderWithProviders(<AdminDashboard />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });
});
