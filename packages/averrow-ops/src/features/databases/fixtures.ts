// Typed fixtures built from the /api/databases contract (v1). Used by tests.

import type { DatabaseEntry, DatabasesPayload, DbHourly } from '@/hooks/useDatabases';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function hours(reads: number[], overloads: Array<number | null>): DbHourly[] {
  return reads.map((r, i) => ({
    hour: `2026-11-22T${String(i % 24).padStart(2, '0')}:00:00Z`,
    rows_read: r,
    rows_written: Math.round(r / 900),
    overloads: overloads[i] ?? null,
  }));
}

const coreReads = Array.from({ length: 24 }, (_, i) => (i === 12 ? 19_400_000 : 6_000_000 + i * 100_000));
const coreOverloads = Array.from({ length: 24 }, (_, i) => (i === 12 ? 14 : i === 13 ? 5 : 0));

export const coreDb: DatabaseEntry = {
  store: 'core',
  name: 'trust-radar-v2',
  binding: 'DB',
  role: 'Threats, brands, cubes, tenants, agent telemetry',
  label: 'CORE',
  status: 'overloaded',
  status_reasons: ['37 overload rejections in 24 h'],
  size_bytes: 5.42 * GB,
  cap_bytes: 10 * GB,
  size_source: 'cf_api',
  tables: 212,
  growth_bytes_per_day: 21 * MB,
  days_to_cap: 213,
  size_history: [
    { date: '2026-09-01', bytes: 3.1 * GB },
    { date: '2026-10-01', bytes: 4.2 * GB },
    { date: '2026-11-01', bytes: 4.9 * GB },
    { date: '2026-11-22', bytes: 5.42 * GB },
  ],
  reads_6h: 54_200_000,
  writes_6h: 61_300,
  reads_24h: 160_000_000,
  writes_24h: 240_000,
  reads_cycle: 1_360_000_000,
  writes_cycle: 2_870_000,
  hourly: hours(coreReads, coreOverloads),
  overloads_24h: 37,
  top_tables: [
    { name: 'threat_cube_geo', rows_estimate: 6_550_000, bytes: null },
    { name: 'threat_cube_brand', rows_estimate: 2_780_000, bytes: null, estimate_divergent: true },
    { name: 'threats', rows_estimate: 1_650_000, bytes: 2.1 * GB },
  ],
  top_jobs: [
    { source: 'navigator', kind: 'agent', rows_read: 6_950_000, rows_written: 12_000, overloads: 9 },
    { source: 'cube_healer', kind: 'agent', rows_read: 3_920_000, rows_written: 8_000, overloads: 4 },
  ],
  note: 'Main reader (Cartographer) paused 31 h',
};

export const geoDb: DatabaseEntry = {
  store: 'geo',
  name: 'geoip-db',
  binding: 'GEOIP_DB',
  role: 'MaxMind GeoLite2 ranges for Cartographer',
  label: 'REFERENCE',
  status: 'healthy',
  status_reasons: [],
  size_bytes: 673 * MB,
  cap_bytes: 10 * GB,
  size_source: 'cf_api',
  tables: 2,
  growth_bytes_per_day: 0,
  days_to_cap: null,
  size_history: [
    { date: '2026-11-01', bytes: 673 * MB },
    { date: '2026-11-22', bytes: 673 * MB },
  ],
  reads_6h: 20_400,
  writes_6h: 0,
  reads_24h: 80_000,
  writes_24h: 0,
  reads_cycle: 900_000,
  writes_cycle: 274_000,
  hourly: hours([3000, 4000, 2000], [null, null, null]),
  overloads_24h: 0,
  top_tables: [{ name: 'geo_ip_ranges', rows_estimate: 3_760_000, bytes: 640 * MB }],
  top_jobs: [],
  note: null,
};

export const dnsqDb: DatabaseEntry = {
  store: 'dnsq',
  name: 'trust-radar-dns-queue',
  binding: 'DNS_QUEUE_DB',
  role: 'Needs-DNS-resolution work queue',
  label: 'WORK QUEUE',
  status: 'healthy',
  status_reasons: [],
  size_bytes: 848 * 1024,
  cap_bytes: 10 * GB,
  size_source: 'pragma',
  tables: 1,
  growth_bytes_per_day: null,
  days_to_cap: null,
  size_history: [],
  reads_6h: 1000,
  writes_6h: 400,
  reads_24h: null,
  writes_24h: null,
  reads_cycle: 20_000,
  writes_cycle: 9000,
  hourly: [],
  overloads_24h: null,
  top_tables: [{ name: 'dns_queue', rows_estimate: 3850, bytes: null }],
  top_jobs: [],
  note: null,
};

// Size unknown + nothing measured: every null path at once.
export const auditDb: DatabaseEntry = {
  store: 'audit',
  name: 'trust-radar-v2-audit',
  binding: 'AUDIT_DB',
  role: 'Append-only audit trail',
  label: 'COMPLIANCE',
  status: 'unknown',
  status_reasons: ['size unavailable'],
  size_bytes: null,
  cap_bytes: 10 * GB,
  size_source: null,
  tables: null,
  growth_bytes_per_day: null,
  days_to_cap: null,
  size_history: [],
  reads_6h: null,
  writes_6h: null,
  reads_24h: null,
  writes_24h: null,
  reads_cycle: null,
  writes_cycle: null,
  hourly: [],
  overloads_24h: null,
  top_tables: [],
  top_jobs: [],
  note: null,
};

export const databasesFixture: DatabasesPayload = {
  generated_at: '2026-11-22T14:06:00Z',
  window: '24h',
  summary: {
    live: 4,
    proposed: 2,
    total_bytes: 6.1 * GB,
    largest_share_pct: 89,
    cycle_rows_read: 1_440_000_000,
    cycle_pct_of_plan: 5.76,
    overloads_24h: 37,
  },
  databases: [coreDb, geoDb, dnsqDb, auditDb],
  proposed: [
    { name: 'averrow-telemetry', role: 'Telemetry', description: 'Agent runs and feed history move here.' },
    { name: 'averrow-archive', role: 'Archive', description: 'Inactive threats older than 180 days.' },
  ],
  edges: [
    { source: 'navigator', kind: 'agent', store: 'core', rows_read: 6_950_000, rows_written: 12_000, queries: 400, overloads: 9 },
    { source: 'cube_healer', kind: 'agent', store: 'core', rows_read: 3_920_000, rows_written: 8_000, queries: 90, overloads: 0 },
    { source: 'navigator', kind: 'agent', store: 'dnsq', rows_read: 5000, rows_written: 900, queries: 30, overloads: null },
    { source: 'cartographer', kind: 'agent', store: 'geo', rows_read: 0, rows_written: 0, queries: 0, overloads: null },
    { source: 'hourly-tick', kind: 'cron', store: 'core', rows_read: 3_310_000, rows_written: 5000, queries: 200, overloads: 3 },
    { source: 'nexus', kind: 'workflow', store: 'core', rows_read: 1_040_000, rows_written: 2000, queries: 60, overloads: 0 },
  ],
};

export const emptyMeterFixture: DatabasesPayload = {
  ...databasesFixture,
  summary: { ...databasesFixture.summary, overloads_24h: null, cycle_rows_read: null, cycle_pct_of_plan: null, total_bytes: null, largest_share_pct: null },
  databases: [{ ...auditDb }, { ...dnsqDb, hourly: [] }],
  edges: [],
};
