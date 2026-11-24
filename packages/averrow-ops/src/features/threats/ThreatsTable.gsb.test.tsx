// The shared threats table shows a Safe Browsing verdict only for rows Google
// actually answered (gsb_checked = 1). 0 means not checked yet (or, from the
// API, rejected as unanswerable) and must never read as "clean".
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreatsTable, type ThreatRow, type ThreatsTableState } from '@averrow/shared/threats-table';

const state: ThreatsTableState = {
  q: '', severity: '', type: '', status: '', brandId: '', country: '', sort: 'last_seen', dir: 'desc', page: 0,
};

function row(id: string, extra: Partial<ThreatRow>): ThreatRow {
  return {
    id, threat_type: 'phishing', malicious_domain: `${id}.example`, malicious_url: null, ip_address: null,
    target_brand_id: null, source_feed: 'test', ...extra,
  } as ThreatRow;
}

async function expand(id: string) {
  render(
    <ThreatsTable
      columns={['target', 'severity']}
      rows={[row(id, rows[id]!)]}
      total={1} loading={false} state={state} pageSize={25}
      onFilter={() => {}} onSearch={() => {}} onToggleSort={() => {}} onPage={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: new RegExp(`Show evidence for ${id}`) }));
}

const rows: Record<string, Partial<ThreatRow>> = {
  unchecked: { gsb_checked: 0, gsb_flagged: 0 },
  clean: { gsb_checked: 1, gsb_flagged: 0 },
  flagged: { gsb_checked: 1, gsb_flagged: 1, gsb_threat_type: 'SOCIAL_ENGINEERING' },
};

describe('ThreatsTable — Safe Browsing verdict', () => {
  it('an unchecked row shows no Safe Browsing line (never "clean")', async () => {
    await expand('unchecked');
    expect(screen.queryByText('Safe Browsing')).toBeNull();
    expect(screen.queryByText('clean')).toBeNull();
  });

  it('a checked, unlisted row shows clean', async () => {
    await expand('clean');
    const label = screen.getByText('Safe Browsing');
    expect(within(label.parentElement!).getByText('clean')).toBeInTheDocument();
  });

  it('a checked, listed row shows the threat type', async () => {
    await expand('flagged');
    const label = screen.getByText('Safe Browsing');
    expect(within(label.parentElement!).getByText('SOCIAL_ENGINEERING')).toBeInTheDocument();
  });
});
