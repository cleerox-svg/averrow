import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '@averrow/shared/ui';

const styleAttr = (el: HTMLElement) => el.getAttribute('style') ?? '';

describe('shared Badge', () => {
  it.each([
    ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['info', 'Info'],
  ])('severity %s renders %s', (sev, text) => {
    render(<Badge severity={sev} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it.each([
    'active', 'inactive', 'pending', 'draft', 'running', 'healthy', 'degraded', 'failed', 'success', 'warning',
  ] as const)('status %s renders its label', (status) => {
    render(<Badge status={status} />);
    expect(screen.getByText(status)).toBeInTheDocument();
  });

  it.each([
    ['nexus', 'NEXUS'], ['pivot', 'PIVOT'], ['accelerating', 'ACCEL'],
    ['quiet', 'QUIET'], ['worsening', 'WORSENING'], ['improving', 'IMPROVING'],
  ] as const)('context %s renders %s', (context, text) => {
    render(<Badge context={context} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it.each([
    ['clear', 'CLEAR'], ['draining', 'DRAINING'], ['steady', 'STEADY'], ['growing', 'GROWING'],
    ['stale', 'STALE'], ['updated', 'UPDATED'], ['stable', 'STABLE'],
  ] as const)('verdict %s renders %s', (verdict, text) => {
    render(<Badge verdict={verdict} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('classification confirmed renders "Confirmed" in the critical tone (case-insensitive)', () => {
    const { rerender } = render(<Badge classification="confirmed" />);
    const el = screen.getByText('Confirmed');
    expect(styleAttr(el)).toContain('--sev-critical-text');
    rerender(<Badge classification="CONFIRMED" />);
    expect(styleAttr(screen.getByText('Confirmed'))).toContain('--sev-critical-text');
  });

  it.each(['impersonation', 'suspicious', 'official', 'legitimate', 'parked'] as const)(
    'classification %s renders its raw text',
    (c) => {
      render(<Badge classification={c} />);
      expect(screen.getByText(c)).toBeInTheDocument();
    },
  );

  it('matches severity case-insensitively and with surrounding whitespace', () => {
    const { rerender } = render(<Badge severity="CRITICAL" />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
    rerender(<Badge severity="  High " />);
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('matches classification case-insensitively but keeps the raw text', () => {
    render(<Badge classification="IMPERSONATION" />);
    const el = screen.getByText('IMPERSONATION');
    // Resolved to the critical tone despite the casing.
    expect(styleAttr(el)).toContain('--sev-critical-text');
  });

  it('renders an unknown severity as neutral with its own text', () => {
    render(<Badge severity="catastrophic" />);
    const el = screen.getByText('catastrophic');
    expect(styleAttr(el)).toContain('var(--text-secondary)');
    expect(styleAttr(el)).not.toContain('--sev-');
  });

  it('does not treat Object.prototype keys as known severities', () => {
    render(<Badge severity="constructor" />);
    expect(screen.getByText('constructor')).toBeInTheDocument();
  });

  it.each([[''], ['   '], [null]])('renders an em dash for empty severity %j', (v) => {
    render(<Badge severity={v} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders an em dash for null / empty classification', () => {
    const { rerender } = render(<Badge classification={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    rerender(<Badge classification="" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('lets children and label override the default text', () => {
    const { rerender } = render(<Badge severity="high">Escalated</Badge>);
    expect(screen.getByText('Escalated')).toBeInTheDocument();
    rerender(<Badge severity="high" label="P1" />);
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  describe('deprecated variant', () => {
    it.each([
      ['critical', '--sev-critical-text'], ['high', '--sev-high-text'],
      ['medium', '--sev-medium-text'], ['low', '--sev-low-text'],
      ['success', '--sev-info-text'], ['info', '--sev-info-text'],
    ] as const)('variant %s maps to %s', (variant, token) => {
      render(<Badge variant={variant}>x</Badge>);
      expect(styleAttr(screen.getByText('x'))).toContain(token);
    });

    it('default variant is neutral', () => {
      render(<Badge variant="default">x</Badge>);
      expect(styleAttr(screen.getByText('x'))).toContain('var(--text-secondary)');
    });
  });

  it('marks the pulse dot aria-hidden and only renders it for toned dots', () => {
    const { container, rerender } = render(<Badge severity="critical" pulse />);
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThan(0);
    // The label is still readable (not hidden).
    expect(screen.getByText('Critical')).not.toHaveAttribute('aria-hidden');
    rerender(<Badge severity="critical" />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    // `pending` has no dot, so pulse is a no-op.
    rerender(<Badge status="pending" pulse />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it.each([
    ['critical', '--sev-critical-text'], ['high', '--sev-high-text'],
    ['medium', '--sev-medium-text'], ['low', '--sev-low-text'], ['info', '--sev-info-text'],
  ])('severity %s text colour uses the theme token, not a hex', (sev, token) => {
    render(<Badge severity={sev} />);
    const style = styleAttr(screen.getByText(sev[0]!.toUpperCase() + sev.slice(1)));
    expect(style).toContain(`var(${token})`);
    expect(style).not.toMatch(/(^|;\s*)color:\s*#/);
  });

  it('applies the base chip styling (uppercase mono label, bordered tinted pill)', () => {
    render(<Badge severity="low" />);
    const el = screen.getByText('Low');
    expect(el).toHaveClass('uppercase', 'font-mono');
    expect(el.style.border).toBeTruthy();
    expect(el.style.background).toBeTruthy();
  });

  it('renders without a severity, status or variant (neutral, no crash)', () => {
    const { container } = render(<Badge>DEFAULT</Badge>);
    expect(screen.getByText('DEFAULT')).toBeInTheDocument();
    expect(container.firstChild).toBeInTheDocument();
  });

  it('accepts a custom className', () => {
    render(<Badge severity="low" className="custom-class" />);
    expect(screen.getByText('Low')).toHaveClass('custom-class');
  });

  describe('precedence (matches ops Badge truthiness)', () => {
    it('falls through to status when severity is null or empty', () => {
      const { rerender } = render(<Badge severity={null} status="failed" />);
      expect(screen.getByText('failed')).toBeInTheDocument();
      rerender(<Badge severity="" status="failed" />);
      expect(screen.getByText('failed')).toBeInTheDocument();
      expect(screen.queryByText('—')).not.toBeInTheDocument();
    });

    it('falls through to context when severity/classification are empty', () => {
      render(<Badge severity={null} classification="" context="nexus" />);
      expect(screen.getByText('NEXUS')).toBeInTheDocument();
    });

    it('a real severity still wins over status', () => {
      render(<Badge severity="critical" status="active" />);
      expect(screen.getByText('Critical')).toBeInTheDocument();
    });

    it('still renders an em dash when only an empty severity is given', () => {
      render(<Badge severity={null} />);
      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  describe('tokens and contrast', () => {
    const styleOf = (text: string) => screen.getByText(text).closest('span') as HTMLElement;

    it('neutral text uses --text-secondary', () => {
      render(<Badge severity="weird" />);
      expect(styleOf('weird').style.color).toBe('var(--text-secondary)');
    });

    it('inactive and parked use --text-secondary (AA contrast, not tertiary/muted)', () => {
      const { unmount } = render(<Badge status="inactive" />);
      expect(styleOf('inactive').style.color).toBe('var(--text-secondary)');
      unmount();
      render(<Badge classification="parked" />);
      expect(styleOf('parked').style.color).toBe('var(--text-secondary)');
    });

    it('xs size is at least 9px', () => {
      render(<Badge severity="high" size="xs" />);
      expect(parseFloat(styleOf('High').style.fontSize)).toBeGreaterThanOrEqual(9);
    });

    it('NEXUS and STABLE derive from --cyan-text, never the reserved teal', () => {
      const { container, rerender } = render(<Badge context="nexus" pulse />);
      let html = container.innerHTML;
      expect(html).toContain('var(--cyan-text)');
      expect(html).not.toMatch(/0,\s*212,\s*255|#00d4ff/i);
      rerender(<Badge verdict="stable" />);
      html = container.innerHTML;
      expect(html).toContain('var(--cyan-text)');
      expect(html).not.toMatch(/0,\s*212,\s*255|#00d4ff/i);
    });
  });
});
