// Tenant sidebar logo (facelift P3-5): the legacy "AVERROW / TENANT" lockup is
// unchanged and stays visible until an accent is set; the R3 lockup (no
// tagline) is rendered alongside it, hidden until then.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LOGO_LEGACY_CLASS, LOGO_R3_CLASS } from '@averrow/shared/ui';
import { AverrowLogo } from './AverrowLogo';

describe('AverrowLogo', () => {
  it('renders the legacy lockup and the R3 lockup as siblings with the toggle classes', () => {
    const { container } = render(<div data-testid="host"><AverrowLogo /></div>);
    const host = container.firstElementChild!;
    expect(host.children).toHaveLength(2);
    const [legacy, r3] = [...host.children];
    expect(legacy!.classList.contains(LOGO_LEGACY_CLASS)).toBe(true);
    expect(legacy!.classList.contains('flex')).toBe(true);
    expect(legacy).toHaveTextContent('AVERROW');
    expect(legacy).toHaveTextContent('TENANT');
    expect(r3!.classList.contains(LOGO_R3_CLASS)).toBe(true);
    expect(r3!.getAttribute('data-logo')).toBe('r3');
    expect(r3).toHaveAttribute('aria-label', 'Averrow');
    expect(r3!.getAttribute('height')).toBe('32');
    expect(r3).not.toHaveTextContent('TENANT');
  });

  it('sizes the R3 lockup with the legacy size prop', () => {
    const { container } = render(<><AverrowLogo size="small" /><AverrowLogo size="large" /></>);
    const r3s = container.querySelectorAll(`.${LOGO_R3_CLASS}`);
    expect([...r3s].map((e) => e.getAttribute('height'))).toEqual(['28', '40']);
    for (const e of r3s) expect(Number(e.getAttribute('height'))).toBeGreaterThanOrEqual(28);
  });
});
