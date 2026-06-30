import { describe, it, expect } from 'vitest';
import {
  resolveBranding,
  fromAddressFor,
  DEFAULT_ABUSE_BRANDING,
  ABUSE_NOREPLY_ADDRESS,
} from '../src/lib/abuse-mailbox-branding';
import { aliasSlug } from '../src/lib/abuse-alias-provision';

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    enabled: 1,
    from_name: null, product_name: null, tagline: null,
    accent_color: null, header_bg_color: null, logo_url: null, logo_alt: null,
    subject_prefix: null, website_url: null, website_label: null,
    report_url: null, report_label: null, footer_note: null,
    ...over,
  } as never;
}

describe('resolveBranding', () => {
  it('returns the Averrow default for a null or disabled row', () => {
    expect(resolveBranding(null)).toEqual(DEFAULT_ABUSE_BRANDING);
    expect(resolveBranding(row({ enabled: 0, from_name: 'Acme' }))).toEqual(DEFAULT_ABUSE_BRANDING);
  });

  it('merges valid overrides over the defaults', () => {
    const b = resolveBranding(row({
      from_name: 'Acme Trust & Safety',
      product_name: 'Acme',
      subject_prefix: 'Acme',
      accent_color: '#123abc',
      logo_url: 'https://cdn.acme.com/logo.png',
    }));
    expect(b.fromName).toBe('Acme Trust & Safety');
    expect(b.productName).toBe('Acme');
    expect(b.subjectPrefix).toBe('Acme');
    expect(b.accent).toBe('#123abc');
    expect(b.logoUrl).toBe('https://cdn.acme.com/logo.png');
    // untouched fields keep the default
    expect(b.tagline).toBe(DEFAULT_ABUSE_BRANDING.tagline);
  });

  it('drops just the invalid fields, not the whole row', () => {
    const b = resolveBranding(row({
      product_name: 'Acme',
      accent_color: 'not-a-hex',          // invalid → default amber
      logo_url: 'http://insecure.com/l.png', // non-https → default logo
    }));
    expect(b.productName).toBe('Acme');
    expect(b.accent).toBe(DEFAULT_ABUSE_BRANDING.accent);
    expect(b.logoUrl).toBe(DEFAULT_ABUSE_BRANDING.logoUrl);
  });

  it('strips the middot delimiter and control/quote chars from text fields', () => {
    const b = resolveBranding(row({ subject_prefix: 'Ac·me"<x>' }));
    expect(b.subjectPrefix).toBe('Acmex');
  });

  it('falls back logo_alt to product_name when alt is absent', () => {
    expect(resolveBranding(row({ product_name: 'Acme' })).logoAlt).toBe('Acme');
  });
});

describe('fromAddressFor', () => {
  it('always sends over the authenticated Averrow noreply address', () => {
    const b = resolveBranding(row({ from_name: 'Acme Trust' }));
    expect(fromAddressFor(b)).toBe(`Acme Trust <${ABUSE_NOREPLY_ADDRESS}>`);
    expect(fromAddressFor(DEFAULT_ABUSE_BRANDING)).toBe(`Averrow Abuse Triage <${ABUSE_NOREPLY_ADDRESS}>`);
  });
});

describe('aliasSlug', () => {
  it('reduces names to a safe local-part segment', () => {
    expect(aliasSlug('Acme Corp')).toBe('acme-corp');
    expect(aliasSlug('  Big.Bank, Inc.  ')).toBe('big-bank-inc');
    expect(aliasSlug('ACME')).toBe('acme');
  });
  it('returns null when nothing usable survives', () => {
    expect(aliasSlug('')).toBeNull();
    expect(aliasSlug('!!!')).toBeNull();
    expect(aliasSlug(null)).toBeNull();
  });
  it('caps length', () => {
    expect(aliasSlug('a'.repeat(80))!.length).toBeLessThanOrEqual(40);
  });
});
