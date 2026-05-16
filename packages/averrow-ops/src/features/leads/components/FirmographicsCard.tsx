// FirmographicsCard — public-record company profile for outbound qualification.
//
// Reads from sales_leads snapshot columns populated by db/sales-leads.ts at
// lead create + AI-enrich time. Source of truth is brand_firmographics
// (SEC EDGAR / Companies House / Wikidata).
//
// All cells are optional — a row hides when the field is null. We never
// render placeholder "—" rows because empty rows train the eye to ignore
// the card; better to show fewer, denser rows.

import { Card, SectionLabel, Badge, Button } from '@/design-system/components';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { SalesLead } from '@/hooks/useLeads';

export interface FirmographicsCardProps {
  lead: SalesLead;
  onRefresh?: () => void;
  refreshing?: boolean;
}

type FieldRow =
  | { label: string; kind: 'text'; value: string }
  | { label: string; kind: 'badge'; value: string; variant?: 'default' | 'info' | 'success' | 'low' }
  | { label: string; kind: 'link'; value: string; href: string };

function buildRows(lead: SalesLead): FieldRow[] {
  const rows: FieldRow[] = [];

  if (lead.revenue_band) {
    rows.push({ label: 'Revenue', kind: 'badge', value: lead.revenue_band, variant: 'info' });
  }
  if (lead.employee_band) {
    rows.push({ label: 'Headcount', kind: 'badge', value: lead.employee_band, variant: 'info' });
  } else if (lead.company_size) {
    // Fallback to AI-derived size category when SEC/Wikidata data is missing.
    // company_size is one of 'startup' | 'smb' | 'mid-market' | 'enterprise'.
    rows.push({ label: 'Size', kind: 'badge', value: lead.company_size, variant: 'low' });
  }
  if (lead.is_public != null) {
    const label = lead.is_public === 1
      ? (lead.ticker ? `Public · ${lead.ticker}` : 'Public')
      : 'Private';
    rows.push({ label: 'Ownership', kind: 'badge', value: label, variant: lead.is_public === 1 ? 'success' : 'default' });
  }
  if (lead.industry_naics) {
    rows.push({ label: 'NAICS', kind: 'text', value: lead.industry_naics });
  }
  if (lead.company_industry) {
    rows.push({ label: 'Industry', kind: 'text', value: lead.company_industry });
  }
  if (lead.founded_year) {
    rows.push({ label: 'Founded', kind: 'text', value: String(lead.founded_year) });
  }
  if (lead.company_hq) {
    rows.push({ label: 'HQ', kind: 'text', value: lead.company_hq });
  }
  if (lead.parent_company) {
    rows.push({ label: 'Parent', kind: 'text', value: lead.parent_company });
  }
  if (lead.is_public === 1 && lead.ticker) {
    rows.push({
      label: 'SEC',
      kind: 'link',
      value: `EDGAR · ${lead.ticker}`,
      href: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(lead.ticker)}&type=10-K&dateb=&owner=include&count=10`,
    });
  }

  return rows;
}

export function FirmographicsCard({ lead, onRefresh, refreshing }: FirmographicsCardProps) {
  const rows = buildRows(lead);
  const hasAny = rows.length > 0;

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Firmographics</SectionLabel>
        {onRefresh && (
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={`w-3 h-3 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh from SEC'}
          </Button>
        )}
      </div>

      {!hasAny ? (
        <p className="text-sm text-white/40 italic">
          No firmographic data yet. SEC EDGAR / Wikidata coverage is sparse for private companies and brands outside US/UK.
          {onRefresh && ' Click Refresh to try the public-records lookup.'}
        </p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="font-mono text-[10px] uppercase self-center" style={{ color: 'var(--text-tertiary)' }}>
                {row.label}
              </dt>
              <dd className="text-sm">
                {row.kind === 'badge' ? (
                  <Badge variant={row.variant ?? 'default'} className="text-[10px]">{row.value}</Badge>
                ) : row.kind === 'link' ? (
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs hover:underline"
                    style={{ color: 'var(--amber)' }}
                  >
                    {row.value}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                ) : (
                  <span style={{ color: 'var(--text-primary)' }}>{row.value}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}
