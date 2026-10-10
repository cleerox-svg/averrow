import { describe, it, expect } from 'vitest';
import {
  classifyIdpImpersonation as classify,
  idpTenantLabel,
  techniqueToVector,
  IDP_FAMILY_TECHNIQUES,
  IDP_TECHNIQUE,
  IDP_MITRE,
  IDP_PROVIDER_LABEL,
  IDP_VECTOR_LABEL,
  IDP_TENANT_HOSTS,
  type IdpProvider,
  type IdpVector,
} from '../src/lib/idp-impersonation';

const acme = ['acme'];

describe('technique family', () => {
  it('lists all four family techniques', () => {
    expect([...IDP_FAMILY_TECHNIQUES].sort()).toEqual(
      ['device_code_phishing', 'idp_lookalike', 'idp_tenant_abuse', 'oauth_consent_phishing'],
    );
    expect(IDP_TECHNIQUE).toEqual({ idp_tenant: 'idp_tenant_abuse', idp_lookalike: 'idp_lookalike' });
  });

  it('maps technique → vector', () => {
    expect(techniqueToVector('idp_tenant_abuse')).toBe('idp_tenant');
    expect(techniqueToVector('idp_lookalike')).toBe('idp_lookalike');
    expect(techniqueToVector('device_code_phishing')).toBe('device_code');
    expect(techniqueToVector('oauth_consent_phishing')).toBe('device_code');
    expect(techniqueToVector('aitm_phishing')).toBeNull();
    expect(techniqueToVector(null)).toBeNull();
  });
});

describe('idp_tenant', () => {
  const cases: Array<[string, IdpProvider]> = [
    ['acme-sso.okta.com', 'okta'],
    ['acme.oktapreview.com', 'okta'],
    ['acme.okta-emea.com', 'okta'],
    ['acme.okta-gov.com', 'okta'],
    ['acme.onelogin.com', 'onelogin'],
    ['acme.auth0.com', 'auth0'],
    ['acme.eu.auth0.com', 'auth0'],
    ['acme.us.auth0.com', 'auth0'],
    ['openam-acme.forgeblocks.com', 'ping'],
  ];
  it.each(cases)('%s → %s', (host, idp) => {
    expect(classify({ host })).toEqual({
      vector: 'idp_tenant', idp, technique: 'idp_tenant_abuse', matched: host,
    });
  });

  it('normalizes case, trailing dot, www., scheme, port and path', () => {
    expect(classify({ host: '  ACME-SSO.Okta.com. ' })?.matched).toBe('acme-sso.okta.com');
    expect(classify({ host: 'https://acme.okta.com:443/app/x' })?.vector).toBe('idp_tenant');
  });

  it.each([
    'okta.com', 'www.okta.com', 'login.okta.com', 'support.okta.com', 'developer.okta.com',
    'trust.okta.com', 'help.okta.com', 'status.okta.com', 'eu.auth0.com', 'manage.auth0.com',
    'community.auth0.com', 'app.onelogin.com', 'api.us.onelogin.com', 'onelogin.com', 'auth0.com',
  ])('vendor corp host %s → null (not tenant, not lookalike)', (host) => {
    expect(classify({ host })).toBeNull();
  });

  it('does not treat Microsoft or Duo shared hosts as tenants', () => {
    expect(classify({ host: 'login.microsoftonline.com' })).toBeNull();
    expect(classify({ host: 'acme.onmicrosoft.com' })).toBeNull();
    expect(classify({ host: 'api-1a2b3c4d.duosecurity.com' })?.vector).not.toBe('idp_tenant');
    expect(Object.keys(IDP_TENANT_HOSTS)).not.toContain('microsoftonline.com');
  });
});

describe('idpTenantLabel', () => {
  it.each([
    ['acme-sso.okta.com', 'acme-sso'],
    ['acme-admin.okta.com', 'acme'],
    ['acme.eu.auth0.com', 'acme'],
    ['acme-dev.us.auth0.com', 'acme-dev'],
    ['acme.auth0.com', 'acme'],
    ['acme.onelogin.com', 'acme'],
    ['openam-acme-prod.forgeblocks.com', 'acme-prod'],
    ['WWW.acme.okta.com.', 'acme'],
  ])('%s → %s', (host, label) => {
    expect(idpTenantLabel(host)).toBe(label);
  });

  it.each(['okta.com', 'login.okta.com', 'eu.auth0.com', 'acme-okta.com', 'example.com'])(
    '%s → null', (host) => expect(idpTenantLabel(host)).toBeNull(),
  );
});

describe('idp_lookalike — strong lures', () => {
  const cases: Array<[string, IdpProvider, string]> = [
    ['acme-okta.com', 'okta', 'okta'],
    ['acme-0kta.com', 'okta', '0kta'],
    ['okta.acme-login.xyz', 'okta', 'okta'],
    ['acme.okta.com.evil.xyz', 'okta', 'okta'],
    ['acme-sso.com', 'generic_sso', 'sso'],
    ['acme2sso.net', 'generic_sso', 'sso'],
    ['mysso-portal.top', 'generic_sso', 'mysso'],
    ['oktalogin.net', 'okta', 'oktalogin'],
    ['acme-adfs.com', 'entra', 'adfs'],
    ['acme-onelogin.com', 'onelogin', 'onelogin'],
    ['one-login-acme.com', 'onelogin', 'onelogin'],
    ['acme-auth0.com', 'auth0', 'auth0'],
    ['acme-entra.com', 'entra', 'entra'],
    ['azure-ad-acme.com', 'entra', 'azuread'],
    ['login.microsoftonIine.com.evil.ru', 'entra', 'microsoftoniine'],
    ['micros0ftonline-verify.com', 'entra', 'micros0ftonline'],
    ['pingone-acme.com', 'ping', 'pingone'],
    ['duosecurity-acme.com', 'duo', 'duosecurity'],
    ['acme-okta.co.uk', 'okta', 'okta'],
  ];
  it.each(cases)('%s → %s (%s)', (host, idp, matched) => {
    expect(classify({ host })).toEqual({
      vector: 'idp_lookalike', idp, technique: 'idp_lookalike', matched,
    });
  });

  it('brand-concatenated strong lures need brand tokens', () => {
    expect(classify({ host: 'acmeokta.com', brandTokens: acme })?.idp).toBe('okta');
    expect(classify({ host: 'ssoacme.com', brandTokens: ['Acme'] })?.matched).toBe('ssoacme');
    expect(classify({ host: 'acmeokta.com' })).toBeNull();
  });

  it('prefers a named provider over generic sso', () => {
    expect(classify({ host: 'acme-sso-okta.com' })?.idp).toBe('okta');
  });
});

describe('idp_lookalike — weak lures need a brand', () => {
  it.each([
    ['acme-servicedesk.com', 'generic_sso'],
    ['acme-helpdesk.com', 'generic_sso'],
    ['acme-vpn.com', 'generic_sso'],
    ['acmevpn.com', 'generic_sso'],
    ['acme-citrix.com', 'generic_sso'],
    ['acme-duo.com', 'duo'],
    ['acme-gsuite.com', 'google'],
    ['idp-acme.net', 'generic_sso'],
  ] as Array<[string, IdpProvider]>)('%s with brand → %s', (host, idp) => {
    expect(classify({ host, brandTokens: acme })?.idp).toBe(idp);
    expect(classify({ host })).toBeNull();
  });

  it('weak lure with an unrelated brand → null', () => {
    expect(classify({ host: 'cheap-vpn.com', brandTokens: acme })).toBeNull();
    expect(classify({ host: 'servicedesk-pro.com', brandTokens: acme })).toBeNull();
  });
});

describe('false-positive guards', () => {
  it.each([
    'kotaku.com', 'pseudossomething.com', 'ssolutions.com', 'lasso.io', 'espresso-bar.com',
    'picasso-art.net', 'duolingo.com', 'dakota-news.com', 'oktoberfest.de', 'idpeducation.com',
    'microsoft-support-acme.com', 'office365-login.com', 'google-docs-share.com', 'example.com',
  ])('%s → null', (host) => {
    expect(classify({ host })).toBeNull();
  });

  it('punycode hosts pass through without throwing', () => {
    expect(classify({ host: 'xn--80ak6aa92e.com' })).toBeNull();
    expect(classify({ host: 'xn--80ak6aa92e-okta.com' })?.idp).toBe('okta');
  });

  it('empty host → null', () => {
    expect(classify({ host: '' })).toBeNull();
  });
});

describe('Entra lures from URL path (non-Microsoft host only)', () => {
  it.each([
    'https://secure-docs.xyz/common/oauth2/v2.0/authorize?client_id=1',
    'https://secure-docs.xyz/organizations/oauth2/authorize',
    'https://secure-docs.xyz/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/authorize',
    'https://secure-docs.xyz/acme.onmicrosoft.com/oauth2/token',
    'https://secure-docs.xyz/adfs/ls/?wa=wsignin1.0',
  ])('%s → entra lookalike', (url) => {
    const r = classify({ host: 'secure-docs.xyz', url });
    expect(r?.vector).toBe('idp_lookalike');
    expect(r?.idp).toBe('entra');
    expect(r?.matched.startsWith('/')).toBe(true);
  });

  it('ignores Microsoft hosts and query-string mentions', () => {
    expect(classify({ host: 'login.microsoftonline.com', url: 'https://login.microsoftonline.com/common/oauth2/authorize' })).toBeNull();
    expect(classify({ host: 'shop.example.com', url: 'https://shop.example.com/cb?next=https://login.microsoftonline.com/common/oauth2/x' })).toBeNull();
    expect(classify({ host: 'shop.example.com', url: 'not a url %%%' })).toBeNull();
  });

  it('Entra path upgrades a generic sso hit but not a named provider', () => {
    expect(classify({ host: 'acme-sso.com', url: 'https://acme-sso.com/common/oauth2/authorize' })?.idp).toBe('entra');
    expect(classify({ host: 'acme-okta.com', url: 'https://acme-okta.com/common/oauth2/authorize' })?.idp).toBe('okta');
  });
});

describe('existingTechnique', () => {
  it('never overwrites a non-family technique', () => {
    expect(classify({ host: 'acme-sso.okta.com', existingTechnique: 'aitm_phishing' })).toBeNull();
    expect(classify({ host: 'acme-okta.com', existingTechnique: 'credential_harvest' })).toBeNull();
  });

  it('keeps an existing family technique and refines the idp from the host', () => {
    expect(classify({ host: 'acme-okta.com', existingTechnique: 'idp_tenant_abuse' })).toEqual({
      vector: 'idp_tenant', idp: 'okta', technique: 'idp_tenant_abuse', matched: 'okta',
    });
    expect(classify({ host: 'acme-sso.okta.com', existingTechnique: 'idp_tenant_abuse' })?.idp).toBe('okta');
  });

  it('maps device-code techniques into the family (default Entra)', () => {
    expect(classify({ host: 'lure-sender.biz', existingTechnique: 'device_code_phishing' })).toEqual({
      vector: 'device_code', idp: 'entra', technique: 'device_code_phishing', matched: 'lure-sender.biz',
    });
    expect(classify({ host: 'x.biz', existingTechnique: 'oauth_consent_phishing' })?.vector).toBe('device_code');
  });

  it('null / empty existing technique classifies normally', () => {
    expect(classify({ host: 'acme-okta.com', existingTechnique: null })?.vector).toBe('idp_lookalike');
  });
});

describe('labels and MITRE map', () => {
  const providers: IdpProvider[] = ['okta', 'entra', 'onelogin', 'auth0', 'ping', 'duo', 'google', 'generic_sso'];
  const vectors: IdpVector[] = ['idp_tenant', 'idp_lookalike', 'device_code'];

  it('has a customer-safe label for every provider and vector', () => {
    for (const p of providers) expect(IDP_PROVIDER_LABEL[p]).toBeTruthy();
    for (const v of vectors) expect(IDP_VECTOR_LABEL[v]).toBeTruthy();
    const all = [...Object.values(IDP_PROVIDER_LABEL), ...Object.values(IDP_VECTOR_LABEL)].join(' ');
    expect(all.toLowerCase()).not.toContain('oktajacking');
  });

  it('MITRE ids are unique, every vector is covered, T1621 dropped', () => {
    const ids = IDP_MITRE.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('T1621');
    for (const v of vectors) expect(IDP_MITRE.some((m) => m.vectors.includes(v))).toBe(true);
  });
});
