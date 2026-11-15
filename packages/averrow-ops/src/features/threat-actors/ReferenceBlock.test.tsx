import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReferenceBlock, REFERENCE_VISIBLE_ALIASES } from './ReferenceBlock';
import type { ActorReference } from '@/hooks/useThreatActors';

const CREDIT =
  'Source: MISP Galaxy threat-actor cluster (MISP Project, CC0 1.0), https://github.com/MISP/misp-galaxy';

function ref(over: Partial<ActorReference> = {}): ActorReference {
  return {
    id: 'misp:0f1c0f6e-0000-4000-8000-000000000001',
    name: 'APT28',
    aliases: ['Sofacy', 'Fancy Bear'],
    country_code: 'RU',
    state_sponsor: 'GRU Unit 26165',
    description: 'Russian-linked group.',
    source: 'misp_galaxy',
    source_version: '20260101',
    updated_at: '2026-11-15T00:00:00Z',
    matched_on: 'APT28',
    credit: CREDIT,
    ...over,
  };
}

describe('ReferenceBlock', () => {
  it('null: one muted line, no card, no implication the actor is unknown', () => {
    render(<ReferenceBlock reference={null} />);
    expect(screen.getByText('No public reference entry matched.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Public reference' })).toBeNull();
    expect(screen.queryByText(/unknown/i)).toBeNull();
  });

  it('undefined (older API response) behaves like null', () => {
    render(<ReferenceBlock reference={undefined} />);
    expect(screen.getByText('No public reference entry matched.')).toBeInTheDocument();
  });

  it('matched: name, aliases, labelled country and sponsor, credit; no verdict wording', () => {
    render(<ReferenceBlock reference={ref()} />);
    expect(screen.getByRole('region', { name: 'Public reference' })).toBeInTheDocument();
    expect(screen.getByText('APT28')).toBeInTheDocument();
    expect(screen.getByText('Fancy Bear')).toBeInTheDocument();
    expect(screen.getByText('Country (per MISP Galaxy)')).toBeInTheDocument();
    expect(screen.getByText('RU')).toBeInTheDocument();
    expect(screen.getByText('Suspected sponsor (per MISP Galaxy)')).toBeInTheDocument();
    expect(screen.getByText('GRU Unit 26165')).toBeInTheDocument();
    expect(screen.getByText(CREDIT)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/attributed to|confirmed/i);
    expect(screen.getByText(/Not Averrow's attribution/)).toBeInTheDocument();
  });

  it('omits country and sponsor rows when absent, keeps credit', () => {
    render(<ReferenceBlock reference={ref({ country_code: null, state_sponsor: null })} />);
    expect(screen.queryByText(/per MISP Galaxy/)).toBeNull();
    expect(screen.getByText(CREDIT)).toBeVisible();
  });

  it('country only / sponsor only render just that row', () => {
    const { rerender } = render(<ReferenceBlock reference={ref({ state_sponsor: null })} />);
    expect(screen.getByText('Country (per MISP Galaxy)')).toBeInTheDocument();
    expect(screen.queryByText('Suspected sponsor (per MISP Galaxy)')).toBeNull();
    rerender(<ReferenceBlock reference={ref({ country_code: null })} />);
    expect(screen.queryByText('Country (per MISP Galaxy)')).toBeNull();
    expect(screen.getByText('Suspected sponsor (per MISP Galaxy)')).toBeInTheDocument();
  });

  it('"Matched on" only when it differs from the reference name', () => {
    const { rerender } = render(<ReferenceBlock reference={ref({ matched_on: 'apt28' })} />);
    expect(document.querySelector('[data-matched-on]')).toBeNull();
    rerender(<ReferenceBlock reference={ref({ matched_on: 'Fancy Bear' })} />);
    expect(document.querySelector('[data-matched-on]')).toHaveTextContent('Matched on Fancy Bear');
  });

  it('many aliases: capped, keyboard toggle with aria-expanded', async () => {
    const aliases = Array.from({ length: 20 }, (_, i) => `Alias-${i}`);
    render(<ReferenceBlock reference={ref({ aliases })} />);
    expect(screen.getByText('Alias-0')).toBeInTheDocument();
    expect(screen.getByText(`Alias-${REFERENCE_VISIBLE_ALIASES - 1}`)).toBeInTheDocument();
    expect(screen.queryByText(`Alias-${REFERENCE_VISIBLE_ALIASES}`)).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show 12 more aliases' });
    expect(toggle).toHaveTextContent('+12');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('Alias-19')).toBeInTheDocument();
    const less = screen.getByRole('button', { name: 'Show fewer aliases' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(less).toHaveTextContent('Less');
    await userEvent.keyboard(' ');
    expect(screen.queryByText('Alias-19')).toBeNull();
  });

  it('no toggle when aliases fit', () => {
    render(<ReferenceBlock reference={ref({ aliases: Array.from({ length: REFERENCE_VISIBLE_ALIASES }, (_, i) => `A${i}`) })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('no aliases: no chip row', () => {
    render(<ReferenceBlock reference={ref({ aliases: [] })} />);
    expect(document.querySelector('[data-aliases]')).toBeNull();
  });

  it('long description is clamped behind Show more / Show less; short one has no toggle', async () => {
    const long = 'Long text. '.repeat(60).trim();
    const { rerender } = render(<ReferenceBlock reference={ref({ description: long })} />);
    const desc = document.querySelector('[data-description]') as HTMLElement;
    expect(desc.className).toMatch(/line-clamp-4/);
    const more = screen.getByRole('button', { name: 'Show more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveAttribute('aria-controls', desc.id);
    await userEvent.click(more);
    expect(desc.className).not.toMatch(/line-clamp/);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    rerender(<ReferenceBlock reference={ref({ description: 'Short.' })} />);
    expect(screen.queryByRole('button', { name: /Show (more|less)/ })).toBeNull();
  });

  it('null description renders no description paragraph', () => {
    render(<ReferenceBlock reference={ref({ description: null })} />);
    expect(document.querySelector('[data-description]')).toBeNull();
  });

  it('third-party markup and markdown render as text, never elements', () => {
    const evil = '<script>window.__pwned=1</script>';
    const { container } = render(
      <ReferenceBlock
        reference={ref({
          name: evil,
          aliases: ['<img src=x onerror=alert(1)>', '**bold** [link](http://x.test)'],
          state_sponsor: '<b>Sponsor</b>',
          description: '# Heading\n<a href="http://evil.test">click</a> **bold**',
          matched_on: '<i>m</i>',
          credit: CREDIT,
        })}
      />,
    );
    expect(container.querySelector('script, img, a, b, i, h1, strong')).toBeNull();
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.getByText('**bold** [link](http://x.test)')).toBeInTheDocument();
    expect(screen.getByText('<b>Sponsor</b>')).toBeInTheDocument();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('credit stays visible when everything else is empty', () => {
    render(<ReferenceBlock reference={ref({ aliases: [], country_code: null, state_sponsor: null, description: null })} />);
    expect(screen.getByText(CREDIT)).toBeVisible();
  });
});
