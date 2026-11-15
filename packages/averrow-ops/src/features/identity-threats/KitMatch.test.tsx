import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KitMatchBlock } from './KitMatch';
import type { KitMatch, KitMatching } from './types';

const ATTR = 'Rules: IOK by phish.report (ODbL)';
const COMMIT = '142f762aa12994cbd26ddf7d40d40c07ac01bd66';

function kit(over: Partial<KitMatching> = {}): KitMatching {
  return {
    ruleset_commit: COMMIT, evaluated_at: '2026-11-15T10:00:00Z', status: 'complete', matches: [], attribution: ATTR, ...over,
  };
}
function match(i: number, over: Partial<KitMatch> = {}): KitMatch {
  return {
    rule_id: `rule-${i}`, title: `Rule title ${i}`, tags: [], approximate_fields: [],
    ruleset_commit: COMMIT, matched_at: '2026-11-15T10:00:00Z', ...over,
  };
}

describe('KitMatchBlock', () => {
  it('not evaluated: muted line, never "no match", no credit line', () => {
    render(<KitMatchBlock kit={{ ruleset_commit: null, evaluated_at: null, status: null, matches: [], attribution: ATTR }} />);
    expect(screen.getByText('Not checked against kit rules.')).toBeInTheDocument();
    expect(screen.queryByText(/No kit rule matched/)).toBeNull();
    expect(screen.queryByText(ATTR)).toBeNull();
  });

  it('evaluated, no match, complete: plain statement, no caveat, credit + commit visible', () => {
    render(<KitMatchBlock kit={kit()} />);
    expect(screen.getByText('No kit rule matched.')).toBeInTheDocument();
    expect(document.querySelector('[data-kit-caveat]')).toBeNull();
    expect(screen.getByText(ATTR, { exact: false })).toBeVisible();
    expect(screen.getByText(/commit 142f762/)).toBeInTheDocument();
  });

  it('truncated and partial add a caveat', () => {
    const { rerender } = render(<KitMatchBlock kit={kit({ status: 'truncated' })} />);
    expect(document.querySelector('[data-kit-caveat]')).toHaveTextContent('Only part of the page was checked.');
    rerender(<KitMatchBlock kit={kit({ status: 'partial' })} />);
    expect(document.querySelector('[data-kit-caveat]')).toHaveTextContent('Only some of the rules were checked.');
  });

  it('matches: title, tags, approximate marker with explanation, credit line', () => {
    render(<KitMatchBlock kit={kit({ matches: [
      match(1, { tags: ['phishing', 'okta'], approximate_fields: ['html'] }),
      match(2),
    ] })} />);
    expect(screen.getByText('Rule title 1')).toBeInTheDocument();
    expect(screen.getByText('okta')).toBeInTheDocument();
    const approx = document.querySelectorAll('[data-approximate]');
    expect(approx).toHaveLength(1);
    expect(approx[0]).toHaveTextContent(/may over-match/);
    expect(screen.getByText(/2 kit rules matched/)).toBeInTheDocument();
    expect(screen.getByText(ATTR, { exact: false })).toBeVisible();
    expect(screen.queryByText(/confirmed|attributed/i)).toBeNull();
  });

  it('caps tags with +N and expands', async () => {
    render(<KitMatchBlock kit={kit({ matches: [match(1, { tags: ['a', 'b', 'c', 'd', 'e'] })] })} />);
    expect(screen.queryByText('d')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 more tags' }));
    expect(screen.getByText('e')).toBeInTheDocument();
  });

  it('long title wraps and many matches are capped behind Show all', async () => {
    const long = 'L'.repeat(300);
    const matches = [match(0, { title: long }), ...[1, 2, 3, 4, 5, 6, 7].map((i) => match(i))];
    render(<KitMatchBlock kit={kit({ matches })} />);
    expect(screen.getByText(long)).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(screen.queryByText('Rule title 7')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show all 8' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByText('Rule title 7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders a hostile title as text, not markup', () => {
    const evil = '<script>alert(1)</script> **bold** <img src=x onerror=alert(1)>';
    const { container } = render(<KitMatchBlock kit={kit({ matches: [match(1, { title: evil, tags: ['<b>t</b>'] })] })} />);
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(container.querySelector('script, img, b, strong:not([style])')).toBeNull();
    expect(screen.getByText('<b>t</b>')).toBeInTheDocument();
  });

  it('tolerates a missing kit_matching (older cached payload)', () => {
    render(<KitMatchBlock kit={undefined} />);
    expect(screen.getByText('Not checked against kit rules.')).toBeInTheDocument();
  });
});
