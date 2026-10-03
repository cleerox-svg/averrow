// Ops body of the briefing shell (/admin -> Briefing tab).
//
// The 12-section Platform Operations Briefing (`threat_briefings`), moved here
// from the former DailyBriefingWidget, plus the payload sections that
// widget never rendered: geopoliticalCampaigns, marketingVisibility and the
// new-capability counts. Types live in ./types and mirror the worker's
// `ComprehensiveBriefing`.

import { useState, type CSSProperties } from 'react';
import { Badge, Button, Card, Table, Th, Td } from '@/design-system/components';
import { useAuth } from '@/lib/auth';
import { BriefingShell } from './BriefingShell';
import { useGenerateBriefing, useOpsBriefing } from './useOpsBriefing';
import type { ComprehensiveBriefing, PlatformOverview } from './types';

// Theme-flippable via CSS custom properties (tokens.css defines them for both
// dark and light). No hardcoded colours in this file.
const textPrimary: CSSProperties = { color: 'var(--text-primary)' };
const textSecondary: CSSProperties = { color: 'var(--text-secondary)' };
const textTertiary: CSSProperties = { color: 'var(--text-tertiary)' };
const textMuted: CSSProperties = { color: 'var(--text-muted)' };
const amberText: CSSProperties = { color: 'var(--amber-text)' };

// ─── Helpers ────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString();
}

function pct(hits: number, checked: number): string {
  if (checked === 0) return '—';
  return ((hits / checked) * 100).toFixed(1) + '%';
}

function triggerLabel(trigger: string): string {
  if (trigger.startsWith('cron')) return 'scheduled';
  return 'manual';
}

function severityDotColor(severity: string): string {
  switch (severity) {
    case 'critical': return 'var(--sev-critical)';
    case 'high':      return 'var(--sev-high)';
    case 'medium':    return 'var(--sev-medium)';
    case 'low':       return 'var(--sev-low)';
    default:          return 'var(--green)';
  }
}

function dodPct(today: number, yesterday: number): string {
  if (yesterday === 0) return today > 0 ? '+100%' : '0%';
  const change = ((today - yesterday) / yesterday) * 100;
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(0)}%`;
}

// ─── Sub-components ─────────────────────────────────────────────

function OverviewCard({ title, metric, metricLabel, metricColor, children }: {
  title: string;
  metric: string;
  metricLabel: string;
  metricColor?: string;
  children?: React.ReactNode;
}) {
  const metricStyle: CSSProperties = { color: metricColor ?? 'var(--text-primary)' };
  return (
    <Card variant="flat" padding={16}>
      <div className="font-mono text-[9px] uppercase tracking-widest mb-3" style={textSecondary}>{title}</div>
      {/* Mobile: stacked layout, Desktop: side-by-side */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="text-center sm:text-left sm:hidden">
          <div className="text-[28px] font-bold leading-none" style={metricStyle}>{metric}</div>
          <div className="text-[9px] uppercase mt-1" style={textTertiary}>{metricLabel}</div>
        </div>
        <div className="flex-1 min-w-0">{children}</div>
        <div className="hidden sm:flex border-l pl-3 flex-col items-center gap-1" style={{ borderColor: 'var(--border-base)' }}>
          <div className="text-[28px] font-bold leading-none" style={metricStyle}>{metric}</div>
          <div className="text-[9px] uppercase" style={textTertiary}>{metricLabel}</div>
        </div>
      </div>
    </Card>
  );
}

function DotRow({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: count > 0 ? color : 'var(--text-muted)' }}
      />
      <span className="text-[11px] flex-1" style={textSecondary}>{label}</span>
      <span className="text-[11px] font-mono" style={textSecondary}>{fmt(count)}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[9px] uppercase tracking-widest" style={textSecondary}>{children}</div>
  );
}

function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    // [&_td] beats the shared Td's own text-sm, so cell text stays 11px.
    <Table className="w-full font-mono text-[11px] [&_td]:text-[11px]">
        <thead>
          <tr className="border-b" style={{ borderColor: 'var(--border-base)' }}>
            {headers.map((h) => (
              <Th key={h} className="p-0 text-left text-[9px] uppercase tracking-widest pb-2 pr-4 font-medium last:text-right" style={textSecondary}>
                {h}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
    </Table>
  );
}

// Screen-reader announcement for the generate-briefing result. role="status"
// (polite) for success, role="alert" (assertive) for failure so an SR user
// hears the outcome without having to go find the toast.
function GenerateToast({ toast }: { toast: { type: 'success' | 'error'; message: string } | null }) {
  if (!toast) return null;
  return (
    <div
      role={toast.type === 'error' ? 'alert' : 'status'}
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      className="font-mono text-[10px]"
      style={{ color: toast.type === 'success' ? 'var(--green)' : 'var(--red)' }}
    >
      {toast.message}
    </div>
  );
}

// ─── Sections ───────────────────────────────────────────────────

function OpsSections({ briefing }: { briefing: ComprehensiveBriefing }) {
  // ── Derived data
  const p = briefing.platformOverview ?? {} as PlatformOverview;
  const total12h = briefing.newThreats?.bySeverity?.reduce((s, r) => s + Number(r.count), 0) ?? 0;
  const dodStr = dodPct(p.todayCount ?? 0, p.yesterdayCount ?? 0);
  const dodUp = (p.todayCount ?? 0) >= (p.yesterdayCount ?? 0);

  // Feed health summary
  const healthCounts: Record<string, number> = {};
  for (const h of (briefing.feedHealth?.summary ?? [])) {
    healthCounts[h.health_status] = Number(h.count);
  }

  // Feed production totals
  const totalIngested = (briefing.feedProduction ?? []).reduce((s, f) => s + Number(f.ingested), 0);
  const totalFeedRuns = (briefing.feedProduction ?? []).reduce((s, f) => s + Number(f.runs), 0);

  // Enrichment engines
  const enrichmentEngines = briefing.enrichment ? [
    { name: 'SURBL', checked: briefing.enrichment.surbl_checked, hits: briefing.enrichment.surbl_hits },
    { name: 'VirusTotal', checked: briefing.enrichment.vt_checked, hits: briefing.enrichment.vt_hits },
    { name: 'Google SB', checked: briefing.enrichment.gsb_checked, hits: briefing.enrichment.gsb_hits },
    { name: 'Spamhaus DBL', checked: briefing.enrichment.dbl_checked, hits: briefing.enrichment.dbl_hits },
    { name: 'AbuseIPDB', checked: briefing.enrichment.abuse_checked, hits: briefing.enrichment.abuse_hits },
    { name: 'GreyNoise', checked: briefing.enrichment.gn_checked, hits: 0 },
    { name: 'SecLookup', checked: briefing.enrichment.sec_checked, hits: 0 },
  ] : [];

  // Anomalies
  const anomalies: Array<{ text: string; level: 'warn' | 'ok' }> = [];
  if (briefing.enrichment) {
    if (briefing.enrichment.gn_checked === 0) {
      anomalies.push({ text: 'GreyNoise: 0 enrichments — API may not be returning data', level: 'warn' });
    }
    if (briefing.enrichment.sec_checked === 0) {
      anomalies.push({ text: 'SecLookup: 0 enrichments — API may not be returning data', level: 'warn' });
    }
  }
  if (briefing.newCapabilities?.certstream === 0) {
    anomalies.push({ text: 'CertStream: alive but 0 captures', level: 'warn' });
  }
  for (const f of (briefing.feedHealth?.degradedFeeds ?? [])) {
    anomalies.push({ text: `${f.feed_name}: degraded — ${f.last_error ?? 'unknown'}`, level: 'warn' });
  }
  if ((briefing.agentActivity ?? []).length > 0) {
    anomalies.push({ text: `All ${briefing.agentActivity.length} agents running normally`, level: 'ok' });
  }
  const producingEngines = enrichmentEngines.filter((e) => e.checked > 0).length;
  anomalies.push({ text: `Enrichment pipeline operational (${producingEngines} of 7 engines producing)`, level: 'ok' });
  if ((briefing.newCapabilities?.typosquat_new ?? 0) > 0) {
    anomalies.push({ text: `Typosquat scanner active — ${fmt(briefing.newCapabilities.typosquat_new)} domains discovered`, level: 'ok' });
  }

  return (
    <div className="space-y-4">
      {/* ── SECTION 1: PLATFORM OVERVIEW ─────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <OverviewCard title="Total Threats" metric={fmt(p.totalThreats)} metricLabel="total" metricColor="var(--amber-text)">
          <DotRow color="var(--red)" label="New 24h" count={p.last24h ?? 0} />
          <DotRow color="var(--amber)" label="New 12h" count={p.last12h ?? 0} />
        </OverviewCard>

        <OverviewCard title="24H Ingest" metric={fmt(p.last24h)} metricLabel="new" metricColor="var(--amber-text)">
          <DotRow color="var(--green)" label="Brands" count={p.brandsMonitored ?? 0} />
          <DotRow color="var(--blue)" label="Classified" count={p.brandsClassified ?? 0} />
        </OverviewCard>

        <OverviewCard title="Hourly Rate" metric={`${fmt(p.avgPerHour)}`} metricLabel="/hr" metricColor="var(--amber-text)">
          <div className="text-[11px]" style={textTertiary}>Last 24h average</div>
        </OverviewCard>

        <OverviewCard
          title="Day over Day"
          metric={dodStr}
          metricLabel="change"
          metricColor={dodUp ? 'var(--red)' : 'var(--green)'}
        >
          <div className="text-[11px]" style={textTertiary}>
            {dodUp ? '▲ Threats increasing' : '▼ Threats decreasing'}
          </div>
        </OverviewCard>
      </div>

      {/* ── SECTION 2: NEW THREATS (12H) ──────────── */}
      {briefing.newThreats && (
        <Card variant="flat" padding={16} className="space-y-3">
          <div className="flex items-center justify-between">
            <SectionTitle>New Threats (12h)</SectionTitle>
            <span className="font-mono text-[14px] font-bold" style={amberText}>{fmt(total12h)}</span>
          </div>
          <div className="flex flex-wrap gap-3 font-mono text-[11px]">
            {briefing.newThreats.bySeverity.map((s) => (
              <span key={s.severity} className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: severityDotColor(s.severity) }}
                />
                <span className="capitalize" style={textSecondary}>{s.severity}:</span>
                <span style={textPrimary}>{fmt(s.count)}</span>
              </span>
            ))}
          </div>
          {briefing.newThreats.bySource.length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              <DataTable headers={['Source', 'Count']}>
                {briefing.newThreats.bySource.map((s) => (
                  <tr key={s.source_feed} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                    <Td className="p-0 py-1 pr-4" style={textPrimary}>{s.source_feed}</Td>
                    <Td className="p-0 py-1 text-right" style={textSecondary}>{fmt(s.count)}</Td>
                  </tr>
                ))}
              </DataTable>
            </>
          )}
          {briefing.newThreats.notable.length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              <div className="font-mono text-[9px] uppercase tracking-widest mb-1" style={textSecondary}>Notable Critical/High</div>
              <div className="space-y-1.5">
                {briefing.newThreats.notable.slice(0, 5).map((t, i) => (
                  <div key={i} className="flex items-start gap-2 font-mono text-[11px]">
                    <span
                      className="w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0"
                      style={{ background: severityDotColor(t.severity) }}
                    />
                    <span className="font-semibold" style={textPrimary}>{t.malicious_domain}</span>
                    <span style={textSecondary}>{t.type} &middot; {t.severity} &middot; {t.source_feed}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {/* ── GEOPOLITICAL CAMPAIGNS ─────────────────── */}
      {(briefing.geopoliticalCampaigns ?? []).length > 0 && (
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Geopolitical Campaigns</SectionTitle>
          <DataTable headers={['Campaign', 'Status', 'Priority', 'Threats', 'New 24h', 'Brands']}>
            {briefing.geopoliticalCampaigns.map((c) => (
              <tr key={c.name} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                <Td className="p-0 py-1 pr-4 truncate max-w-[200px]" style={textPrimary} title={c.conflict ? `${c.name} · ${c.conflict}` : c.name}>{c.name}</Td>
                <Td className="p-0 py-1 pr-4 text-right" style={textSecondary}>{c.status}</Td>
                <Td className="p-0 py-1 pr-4 text-right" style={textSecondary}>{c.briefing_priority}</Td>
                <Td className="p-0 py-1 pr-4 text-right" style={textSecondary}>{fmt(c.total_threats)}</Td>
                <Td className="p-0 py-1 pr-4 text-right" style={amberText}>{fmt(c.new_24h)}</Td>
                <Td className="p-0 py-1 text-right" style={textSecondary}>{fmt(c.brands_hit)}</Td>
              </tr>
            ))}
          </DataTable>
        </Card>
      )}

      {/* ── SECTION 3 & 4: FEED PRODUCTION + HEALTH ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* FEED PRODUCTION */}
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Feed Production (12h)</SectionTitle>
          <div className="font-mono text-[10px]" style={textSecondary}>
            {(briefing.feedProduction ?? []).length} feeds &middot; {fmt(totalFeedRuns)} runs &middot; {fmt(totalIngested)} ingested
          </div>
          {(briefing.feedProduction ?? []).length > 0 && (
            <DataTable headers={['Feed', 'Runs', 'Ingested']}>
              {briefing.feedProduction.map((f) => (
                <tr key={f.feed_name} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                  <Td className="p-0 py-1 pr-4 truncate max-w-[140px]" style={textPrimary}>{f.feed_name}</Td>
                  <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{fmt(f.runs)}</Td>
                  <Td className="p-0 py-1 text-right" style={amberText}>{fmt(f.ingested)}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>

        {/* FEED HEALTH */}
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Feed Health</SectionTitle>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
            {healthCounts['healthy'] != null && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: 'var(--green)' }} />
                <span style={textSecondary}>{healthCounts['healthy']} healthy</span>
              </span>
            )}
            {healthCounts['degraded'] != null && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: 'var(--amber)' }} />
                <span style={textSecondary}>{healthCounts['degraded']} degraded</span>
              </span>
            )}
            {healthCounts['failed'] != null && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: 'var(--red)' }} />
                <span style={textSecondary}>{healthCounts['failed']} failed</span>
              </span>
            )}
          </div>
          {(briefing.feedHealth?.degradedFeeds ?? []).length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              {briefing.feedHealth.degradedFeeds.map((f) => (
                <div key={f.feed_name} className="font-mono text-[10px]" style={amberText}>
                  {'⚠'} {f.feed_name} — {f.last_error ?? 'unknown error'}
                </div>
              ))}
            </>
          )}
          {(briefing.feedHealth?.staleFeeds ?? []).length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              {briefing.feedHealth.staleFeeds.map((f) => (
                <div key={f.feed_name} className="font-mono text-[10px]" style={amberText}>
                  {'⚠'} {f.feed_name} — last run {f.last_successful_pull ?? 'never'} (stale)
                </div>
              ))}
            </>
          )}
        </Card>
      </div>

      {/* ── SECTION 5: ENRICHMENT PIPELINE ────────── */}
      {enrichmentEngines.length > 0 && (
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Enrichment Pipeline</SectionTitle>
          <DataTable headers={['Engine', 'Checked', 'Hits', 'Hit Rate', 'Status']}>
            {enrichmentEngines.map((e) => (
              <tr key={e.name} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                <Td className="p-0 py-1 pr-4" style={textPrimary}>{e.name}</Td>
                <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{fmt(e.checked)}</Td>
                <Td className="p-0 py-1 text-right pr-4" style={amberText}>{fmt(e.hits)}</Td>
                <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{pct(e.hits, e.checked)}</Td>
                <Td className="p-0 py-1 text-right">
                  <Badge status={e.checked > 0 ? 'success' : 'warning'} label={e.checked > 0 ? 'OK' : 'Idle'} size="xs" />
                </Td>
              </tr>
            ))}
          </DataTable>
        </Card>
      )}

      {/* ── NEW CAPABILITIES ───────────────────────── */}
      {briefing.newCapabilities && (
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>New Capabilities</SectionTitle>
          <DataTable headers={['Scanner', 'Total', 'New']}>
            <tr className="border-b" style={{ borderColor: 'var(--border-base)' }}>
              <Td className="p-0 py-1 pr-4" style={textPrimary}>Typosquat</Td>
              <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{fmt(briefing.newCapabilities.typosquat_total)}</Td>
              <Td className="p-0 py-1 text-right" style={amberText}>{fmt(briefing.newCapabilities.typosquat_new)}</Td>
            </tr>
            <tr className="border-b" style={{ borderColor: 'var(--border-base)' }}>
              <Td className="p-0 py-1 pr-4" style={textPrimary}>Social</Td>
              <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{fmt(briefing.newCapabilities.social_total)}</Td>
              <Td className="p-0 py-1 text-right" style={amberText}>{fmt(briefing.newCapabilities.social_new)}</Td>
            </tr>
            <tr className="border-b" style={{ borderColor: 'var(--border-base)' }}>
              <Td className="p-0 py-1 pr-4" style={textPrimary}>App stores</Td>
              <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{fmt(briefing.newCapabilities.appstore_total)}</Td>
              <Td className="p-0 py-1 text-right" style={amberText}>{fmt(briefing.newCapabilities.appstore_new)}</Td>
            </tr>
            <tr className="border-b" style={{ borderColor: 'var(--border-base)' }}>
              <Td className="p-0 py-1 pr-4" style={textPrimary}>Dark web</Td>
              <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{fmt(briefing.newCapabilities.darkweb_total)}</Td>
              <Td className="p-0 py-1 text-right" style={amberText}>{fmt(briefing.newCapabilities.darkweb_new)}</Td>
            </tr>
          </DataTable>
          <div className="font-mono text-[10px]" style={textSecondary}>
            CertStream captures: <span style={amberText}>{fmt(briefing.newCapabilities.certstream)}</span>
          </div>
        </Card>
      )}

      {/* ── SECTION 6 & 7: FLIGHT CONTROLLER + AGENTS ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* FLIGHT CONTROLLER */}
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Flight Controller</SectionTitle>
          {briefing.flightController?.summary ? (
            <div className="font-mono text-[11px] whitespace-pre-wrap break-words" style={textSecondary}>
              {briefing.flightController.summary}
            </div>
          ) : (
            <div className="font-mono text-[10px]" style={textMuted}>No diagnostic available</div>
          )}
        </Card>

        {/* AGENT STATUS */}
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Agent Status (12h)</SectionTitle>
          {(briefing.agentActivity ?? []).length > 0 ? (
            <DataTable headers={['Agent', 'Runs', 'Last Run']}>
              {briefing.agentActivity.map((a) => (
                <tr key={a.agent_id} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                  <Td className="p-0 py-1 pr-4" style={textPrimary}>{a.agent_id}</Td>
                  <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{fmt(a.runs)}</Td>
                  <Td className="p-0 py-1 text-right" style={textSecondary}>
                    {a.last_run ? new Date(a.last_run).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC' : '—'}
                  </Td>
                </tr>
              ))}
            </DataTable>
          ) : (
            <div className="font-mono text-[10px]" style={textMuted}>No agent activity</div>
          )}
        </Card>
      </div>

      {/* ── SECTION 8: SPAM TRAP INTELLIGENCE ──────── */}
      {briefing.spamTrap && (
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Spam Trap Intelligence</SectionTitle>
          <div className="flex flex-wrap gap-4 font-mono text-[11px]">
            <span style={textSecondary}>Seeds: <span style={amberText}>{fmt(briefing.spamTrap.totalSeeds)}</span></span>
            <span style={textSecondary}>Captures: <span style={amberText}>{fmt(briefing.spamTrap.totalCaptures)}</span></span>
            <span style={textSecondary}>New (12h): <span style={amberText}>{fmt(briefing.spamTrap.captures12h)}</span></span>
          </div>
          {briefing.spamTrap.seedingSources.length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              <div className="font-mono text-[9px] uppercase tracking-widest mb-1" style={textSecondary}>Seeding Sources</div>
              <DataTable headers={['Source', 'Seeds', 'Catches']}>
                {briefing.spamTrap.seedingSources.map((s) => (
                  <tr key={s.seeded_location} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                    <Td className="p-0 py-1 pr-4 truncate max-w-[160px]" style={textPrimary}>{s.seeded_location}</Td>
                    <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{fmt(s.seeds)}</Td>
                    <Td className="p-0 py-1 text-right" style={amberText}>{fmt(s.catches)}</Td>
                  </tr>
                ))}
              </DataTable>
            </>
          )}
          {briefing.spamTrap.latestCaptures.length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              <div className="font-mono text-[9px] uppercase tracking-widest mb-1" style={textSecondary}>Latest Captures</div>
              <div className="space-y-2">
                {briefing.spamTrap.latestCaptures.map((c, i) => (
                  <div key={i} className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-base)' }}>
                    <div className="font-mono text-[11px]" style={textPrimary}>
                      From: <span style={textSecondary}>{c.from_address}</span> &rarr; <span style={textSecondary}>{c.trap_address}</span>
                    </div>
                    <div className="font-mono text-[11px] mt-0.5" style={textPrimary}>Subject: &ldquo;{c.subject}&rdquo;</div>
                    <div className="font-mono text-[10px] mt-0.5" style={textTertiary}>{c.category} &middot; {c.severity} &middot; {c.captured_at}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {/* ── SECTION 9: HONEYPOT ACTIVITY ──────────── */}
      {briefing.honeypot && (
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Honeypot Activity</SectionTitle>
          <div className="flex flex-wrap gap-4 font-mono text-[11px]">
            <span style={textSecondary}>Total: <span style={amberText}>{fmt(briefing.honeypot.totalVisits)}</span></span>
            <span style={textSecondary}>Bots: <span style={textSecondary}>{fmt(briefing.honeypot.botVisits)}</span></span>
            <span style={textSecondary}>Humans: <span style={textSecondary}>{fmt(briefing.honeypot.humanVisits)}</span></span>
            <span style={textSecondary}>Last 12h: <span style={amberText}>{fmt(briefing.honeypot.visits12h)}</span></span>
          </div>
          {briefing.honeypot.pageBreakdown.length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              <div className="font-mono text-[9px] uppercase tracking-widest mb-1" style={textSecondary}>
                {briefing.honeypot.pageBreakdownTotal > briefing.honeypot.pageBreakdown.length
                  ? `Top 20 of ${fmt(briefing.honeypot.pageBreakdownTotal)} pages`
                  : 'Pages'}
              </div>
              <DataTable headers={['Page', 'Visits', 'Bots']}>
                {briefing.honeypot.pageBreakdown.slice(0, 20).map((p) => (
                  <tr key={p.page} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                    <Td className="p-0 py-1 pr-4 truncate max-w-[160px]" style={textPrimary}>{p.page}</Td>
                    <Td className="p-0 py-1 text-right pr-4" style={textSecondary}>{fmt(p.visits)}</Td>
                    <Td className="p-0 py-1 text-right" style={textSecondary}>{fmt(p.bots)}</Td>
                  </tr>
                ))}
              </DataTable>
            </>
          )}
          {briefing.honeypot.recentBots.length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              <div className="font-mono text-[9px] uppercase tracking-widest mb-1" style={textSecondary}>Recent Crawlers</div>
              {briefing.honeypot.recentBots.map((b, i) => (
                <div key={i} className="font-mono text-[11px]" style={textSecondary}>
                  &#9679; {b.bot_name || 'Unknown bot'} &middot; {b.country || '?'} &middot; {b.visited_at ? new Date(b.visited_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC' : '—'}
                </div>
              ))}
            </>
          )}
          {briefing.honeypot.suspiciousHumans.length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              <div className="font-mono text-[9px] uppercase tracking-widest mb-1" style={textSecondary}>Recon &amp; Bait Hits (7d)</div>
              {briefing.honeypot.suspiciousHumans.map((h, i) => {
                const label = h.reason === 'bait' ? 'Bait page hit' : 'Recon probe';
                const time = h.visited_at ? new Date(h.visited_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC' : '—';
                const asn = h.asn ? ' AS' + h.asn : '';
                return (
                  <div key={i} className="font-mono text-[11px]" style={amberText}>
                    {'⚠'} {label}: {h.country || '??'}{asn} &rarr; {h.page} at {time}
                  </div>
                );
              })}
            </>
          )}
        </Card>
      )}

      {/* ── MARKETING VISIBILITY ───────────────────── */}
      {briefing.marketingVisibility && (
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Marketing Visibility ({fmt(briefing.marketingVisibility.windowHours)}h)</SectionTitle>
          <div className="flex flex-wrap gap-4 font-mono text-[11px]">
            <span style={textSecondary}>Human views: <span style={amberText}>{fmt(briefing.marketingVisibility.humanViews)}</span></span>
            <span style={textSecondary}>AI crawlers: <span style={amberText}>{fmt(briefing.marketingVisibility.aiCrawlerViews)}</span></span>
            <span style={textSecondary}>Other bots: <span style={textSecondary}>{fmt(briefing.marketingVisibility.otherBotViews)}</span></span>
            <span style={textSecondary}>AI referrals: <span style={amberText}>{fmt(briefing.marketingVisibility.aiReferralSessions)}</span></span>
            <span style={textSecondary}>CTA clicks: <span style={amberText}>{fmt(briefing.marketingVisibility.ctaClicks)}</span></span>
            <span style={textSecondary}>Contact submissions: <span style={amberText}>{fmt(briefing.marketingVisibility.contactSubs)}</span></span>
          </div>
          {(briefing.marketingVisibility.topPages ?? []).length > 0 && (
            <>
              <hr style={{ borderColor: 'var(--border-base)' }} />
              <DataTable headers={['Top page', 'Views']}>
                {briefing.marketingVisibility.topPages.map((p) => (
                  <tr key={p.page} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                    <Td className="p-0 py-1 pr-4 truncate max-w-[220px]" style={textPrimary}>{p.page}</Td>
                    <Td className="p-0 py-1 text-right" style={textSecondary}>{fmt(p.views)}</Td>
                  </tr>
                ))}
              </DataTable>
            </>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {(briefing.marketingVisibility.aiCrawlerBreakdown ?? []).length > 0 && (
              <DataTable headers={['AI crawler', 'Hits']}>
                {briefing.marketingVisibility.aiCrawlerBreakdown.map((c) => (
                  <tr key={c.crawler_name} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                    <Td className="p-0 py-1 pr-4" style={textPrimary}>{c.crawler_name}</Td>
                    <Td className="p-0 py-1 text-right" style={textSecondary}>{fmt(c.hits)}</Td>
                  </tr>
                ))}
              </DataTable>
            )}
            {(briefing.marketingVisibility.aiReferralBySource ?? []).length > 0 && (
              <DataTable headers={['AI referral source', 'Sessions']}>
                {briefing.marketingVisibility.aiReferralBySource.map((r) => (
                  <tr key={r.ai_source} className="border-b" style={{ borderColor: 'var(--border-base)' }}>
                    <Td className="p-0 py-1 pr-4" style={textPrimary}>{r.ai_source}</Td>
                    <Td className="p-0 py-1 text-right" style={textSecondary}>{fmt(r.sessions)}</Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </div>
        </Card>
      )}

      {/* ── SECTION 10: TOP TARGETED BRANDS ────────── */}
      {(briefing.topTargetedBrands ?? []).length > 0 && (
        <Card variant="flat" padding={16} className="space-y-3">
          <SectionTitle>Top Targeted Brands (24h)</SectionTitle>
          <div className="space-y-1">
            {briefing.topTargetedBrands.map((b, i) => (
              <div key={b.name} className="flex items-center justify-between font-mono text-[11px]">
                <div className="flex items-center gap-2 truncate">
                  <span className="w-5 text-right" style={textTertiary}>{i + 1}.</span>
                  <span className="truncate" style={textPrimary}>{b.name}</span>
                </div>
                <span className="ml-2" style={amberText}>{fmt(b.threats_24h)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── SECTION 11: ANOMALIES & ALERTS ─────────── */}
      {anomalies.length > 0 && (
        <Card
          variant="flat"
          padding={16}
          className="space-y-2"
          style={{
            borderColor: anomalies.some(a => a.level === 'warn') ? 'var(--amber-border)' : 'var(--green-border)',
            background:  anomalies.some(a => a.level === 'warn') ? 'var(--amber-glow)' : 'var(--green-glow)',
          }}
        >
          <SectionTitle>Anomalies & Alerts</SectionTitle>
          {anomalies.map((a, i) => (
            <div key={i} className="flex items-start gap-2 font-mono text-[11px]" style={textSecondary}>
              <Badge status={a.level === 'warn' ? 'warning' : 'success'} label={a.level === 'warn' ? 'Warning' : 'OK'} size="xs" />
              <span className="min-w-0 break-words">{a.text}</span>
            </div>
          ))}
        </Card>
      )}

      {/* ── SECTION 12: BRAND COVERAGE ──────────────── */}
      {(briefing.brandCoverage ?? []).length > 0 && (
        <Card variant="flat" padding={16} className="space-y-2">
          <SectionTitle>Brand Coverage</SectionTitle>
          <div className="font-mono text-[11px]" style={textSecondary}>
            {fmt(p.brandsMonitored)} monitored &middot; {fmt(p.brandsClassified)} classified
          </div>
          <div className="font-mono text-[11px]" style={textSecondary}>
            Top: {briefing.brandCoverage.slice(0, 5).map((c) => `${c.sector} (${c.brands})`).join(' · ')}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Body ───────────────────────────────────────────────────────

export function OpsBriefingBody() {
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const { data, isLoading, isError, refetch } = useOpsBriefing();
  const generate = useGenerateBriefing();
  // Generating is admin-only server-side (requireAdmin); other staff roles
  // see the briefing read-only. Hook is still called unconditionally, but
  // the mutation is only ever invoked from the admin-gated button.
  const { user } = useAuth();
  const canGenerate = user?.role === 'admin' || user?.role === 'super_admin';

  const handleGenerate = async () => {
    setToast(null);
    try {
      await generate.mutateAsync();
      setToast({ type: 'success', message: 'Briefing generated and emailed.' });
    } catch (err) {
      setToast({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const generating = generate.isPending;
  const runButton = (
    <Button size="sm" onClick={handleGenerate} disabled={generating} loading={generating}>
      Run Briefing Now
    </Button>
  );

  // A failed fetch is never "no briefing generated yet".
  const status = isError && !data ? 'error' : isLoading ? 'loading' : data ? 'ready' : 'empty';
  const briefing = data?.briefing ?? null;

  return (
    <BriefingShell
      source="ops"
      title="Platform operations briefing"
      eyebrow={briefing && (
        <Badge
          status={briefing.statusBadge === 'DEGRADED' ? 'warning' : 'active'}
          label={briefing.statusBadge ?? 'OPERATIONAL'}
          size="xs"
        />
      )}
      generatedAt={data?.row.generated_at}
      meta={data && <span>&middot; {triggerLabel(data.row.trigger)}</span>}
      actions={canGenerate && (status === 'ready' || status === 'empty') ? runButton : undefined}
      notice={toast && <GenerateToast toast={toast} />}
      status={status}
      onRetry={() => { void refetch(); }}
      errorTitle="Couldn't load the briefing"
      emptyTitle="No briefing generated yet."
      emptyDescription={canGenerate
        ? 'Run one to populate this widget.'
        : 'The daily briefing runs automatically at 13:13 UTC.'}
      loadingTitle="Loading briefing…"
    >
      {briefing && <OpsSections briefing={briefing} />}
    </BriefingShell>
  );
}
