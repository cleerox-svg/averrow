import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SpfFindingsCard, parseSpfFindings, findingLines } from './SpfFindingsCard';

// API-shaped: GET /api/email-security/:brandId returns the stored row, with
// spf_findings as a JSON string.
function row(over: Record<string, unknown> = {}) {
  return {
    spf_exists: 1,
    spf_lookup_count: 7,
    spf_walk_status: 'complete',
    spf_findings: JSON.stringify([]),
    ...over,
  };
}

describe('parseSpfFindings', () => {
  it('drops unknown codes, bad names and bad JSON', () => {
    expect(parseSpfFindings('not json')).toEqual([]);
    expect(parseSpfFindings(null)).toEqual([]);
    expect(parseSpfFindings(JSON.stringify([
      { code: 'ptr_mechanism', names: ['a.example.com', '<script>alert(1)</script>'] },
      { code: 'made_up' },
    ]))).toEqual([{ code: 'ptr_mechanism', names: ['a.example.com'] }]);
  });
});

describe('SpfFindingsCard', () => {
  it('renders nothing without a scan', () => {
    const { container } = render(<SpfFindingsCard emailSec={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('clean scan: lookup count vs limit, complete walk, no findings', () => {
    render(<SpfFindingsCard emailSec={row()} />);
    expect(screen.getByTestId('spf-lookups')).toHaveTextContent('7 of 10');
    expect(screen.getByTestId('spf-walk')).toHaveTextContent('Complete');
    expect(screen.getByText('No findings on the latest scan.')).toBeInTheDocument();
  });

  it('over limit, incomplete walk shows a lower bound', () => {
    render(<SpfFindingsCard emailSec={row({
      spf_lookup_count: 11,
      spf_walk_status: 'unknown',
      spf_findings: JSON.stringify([
        { code: 'lookup_limit_exceeded', count: 11, atLeast: true },
        { code: 'walk_incomplete', count: 11 },
      ]),
    })} />);
    expect(screen.getByTestId('spf-lookups')).toHaveTextContent('≥ 11 of 10');
    expect(screen.getByText('Needs at least 11 DNS lookups, over the limit of 10.')).toBeInTheDocument();
    expect(screen.getByTestId('spf-walk')).toHaveTextContent('Incomplete');
  });

  it('only the unregistered include is critical, and it is listed first', () => {
    const { container } = render(<SpfFindingsCard emailSec={row({
      spf_findings: JSON.stringify([
        { code: 'include_target_missing', names: ['gone-vendor.com'] },
        { code: 'pass_all' },
        { code: 'include_target_unregistered', names: ['gone-vendor.com'] },
      ]),
    })} />);
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('data-critical', 'true');
    expect(items[0]).toHaveTextContent('Include target gone-vendor.com is not registered. Anyone who registers it can send mail as this domain.');
    expect(container.querySelectorAll('[data-critical="true"]')).toHaveLength(1);
  });

  it('plain sentences for the other findings; names render as text', () => {
    const lines = findingLines([
      { code: 'multiple_records', count: 2 },
      { code: 'include_loop', names: ['a.example.com'] },
      { code: 'include_pass_all', names: ['b.example.com'] },
      { code: 'void_lookup_limit_exceeded', count: 3 },
      { code: 'syntax_error', names: ['c.example.com'] },
      { code: 'include_target_unverified', names: ['d.example.com'] },
    ]).map((l) => l.text);
    expect(lines).toEqual([
      '2 SPF records are published at the domain.',
      'Include loop (a.example.com).',
      'An included record ends in +all (b.example.com).',
      '3 void lookups, over the limit of 2.',
      'Syntax error (c.example.com).',
      'Could not confirm whether d.example.com is registered.',
    ]);
  });

  it('walk statuses: not checked and no record', () => {
    const { rerender } = render(<SpfFindingsCard emailSec={row({ spf_walk_status: null, spf_lookup_count: null })} />);
    expect(screen.getByTestId('spf-walk')).toHaveTextContent('Not checked');
    expect(screen.getByTestId('spf-lookups')).toHaveTextContent('—');
    rerender(<SpfFindingsCard emailSec={row({ spf_exists: 0, spf_walk_status: 'no_record', spf_lookup_count: null })} />);
    expect(screen.getByText('No SPF record, so there is nothing to check.')).toBeInTheDocument();
  });
});
