import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
import { DataRow } from './DataRow';

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');

describe('DataRow', () => {
  it('sets no inline background or border, so the stylesheet hover can apply', () => {
    render(<DataRow><span>plain</span></DataRow>);
    const row = screen.getByText('plain').parentElement as HTMLElement;
    expect(row).toHaveClass('data-row');
    expect(row.style.background).toBe('');
    expect(row.style.borderLeft).toBe('');
    expect(row.style.borderLeftColor).toBe('');
  });

  it('an unread row carries its rail through a class + custom properties, not an inline background', () => {
    render(<DataRow unread severity="high"><span>u</span></DataRow>);
    const row = screen.getByText('u').parentElement as HTMLElement;
    expect(row).toHaveClass('data-row', 'data-row--high', 'data-row--unread');
    expect(row.style.background).toBe('');
    expect(row.style.getPropertyValue('--row-rail')).toBe('var(--sev-high)');
    expect(row.style.getPropertyValue('--row-rail-bg')).toBe('var(--sev-high-bg)');
  });

  it('a non-severity unread row falls back to the primary rail', () => {
    render(<DataRow unread><span>p</span></DataRow>);
    expect((screen.getByText('p').parentElement as HTMLElement).style.getPropertyValue('--row-rail')).toBe('var(--primary)');
  });

  it('only a clickable row sets a pointer inline; a static row is marked so a link can restore it', () => {
    render(<><DataRow onClick={() => {}}><span>c</span></DataRow><DataRow><span>s</span></DataRow></>);
    const clickable = screen.getByText('c').parentElement as HTMLElement;
    const stat = screen.getByText('s').parentElement as HTMLElement;
    expect(clickable.style.cursor).toBe('pointer');
    expect(clickable).not.toHaveClass('data-row--static');
    expect(stat.style.cursor).toBe('');
    expect(stat).toHaveClass('data-row--static');
  });

  it('inside a link the static row shows the pointer (stylesheet rule)', () => {
    render(<MemoryRouter><Link to="/x"><DataRow><span>l</span></DataRow></Link></MemoryRouter>);
    expect(screen.getByText('l').parentElement).toHaveClass('data-row--static');
    expect(css).toMatch(/\.data-row--static \{ cursor: default; \}/);
    expect(css).toMatch(/a \.data-row--static, \[role="link"\] \.data-row--static \{ cursor: pointer; \}/);
  });

  it('the facelift hover keeps an unread rail and sets the text colour', () => {
    expect(css).toMatch(/:root\[data-accent\] \.data-row--unread:hover \{ border-left-color: var\(--row-rail\) !important; \}/);
    expect(css).toMatch(/:root\[data-accent\] \.data-row:hover \{[^}]*color: var\(--text-primary\)/);
  });
});
