import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { useSsoConfig, useUpdateSsoConfig, useTestSsoConnection } from '@/hooks/useOrganization';

type SsoProtocol = 'none' | 'saml' | 'oidc';

const OIDC_PROVIDERS = [
  { value: 'okta', label: 'Okta' },
  { value: 'azure', label: 'Azure AD' },
  { value: 'google', label: 'Google Workspace' },
  { value: 'custom', label: 'Custom' },
];

export function SsoConfig({ slug }: { slug: string }) {
  const { data: ssoConfig, isLoading } = useSsoConfig();
  const updateSso = useUpdateSsoConfig();
  const testSso = useTestSsoConnection();

  const [protocol, setProtocol] = useState<SsoProtocol>('none');

  // SAML fields
  const [samlMetadataUrl, setSamlMetadataUrl] = useState('');
  const [samlCertificate, setSamlCertificate] = useState('');

  // OIDC fields
  const [oidcProvider, setOidcProvider] = useState('okta');
  const [oidcClientId, setOidcClientId] = useState('');
  const [oidcClientSecret, setOidcClientSecret] = useState('');
  const [oidcDiscoveryUrl, setOidcDiscoveryUrl] = useState('');

  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (ssoConfig) {
      setProtocol(ssoConfig.protocol ?? 'none');
      if (ssoConfig.protocol === 'saml') {
        setSamlMetadataUrl(ssoConfig.saml_metadata_url ?? '');
        setSamlCertificate(ssoConfig.saml_certificate ? '(uploaded)' : '');
      }
      if (ssoConfig.protocol === 'oidc') {
        setOidcProvider(ssoConfig.oidc_provider ?? 'okta');
        setOidcClientId(ssoConfig.oidc_client_id ?? '');
        setOidcClientSecret(ssoConfig.oidc_client_secret ? '••••••••' : '');
        setOidcDiscoveryUrl(ssoConfig.oidc_discovery_url ?? '');
      }
    }
  }, [ssoConfig]);

  const orgSlug = slug || 'lrx-enterprises';
  const entityId = `https://averrow.com/saml/${orgSlug}`;
  const acsUrl = 'https://averrow.com/api/auth/saml/callback';

  const handleSave = async () => {
    if (protocol === 'none') {
      await updateSso.mutateAsync({ protocol: 'none' });
      return;
    }
    if (protocol === 'saml') {
      await updateSso.mutateAsync({
        protocol: 'saml',
        saml_metadata_url: samlMetadataUrl,
        saml_certificate: samlCertificate === '(uploaded)' ? undefined : samlCertificate,
      });
    }
    if (protocol === 'oidc') {
      await updateSso.mutateAsync({
        protocol: 'oidc',
        oidc_provider: oidcProvider,
        oidc_client_id: oidcClientId,
        oidc_client_secret: oidcClientSecret === '••••••••' ? undefined : oidcClientSecret,
        oidc_discovery_url: oidcDiscoveryUrl,
      });
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    try {
      const res = await testSso.mutateAsync();
      setTestResult({
        ok: !!res.data?.success,
        msg: res.data?.success ? 'SSO connection verified' : (res.data?.error ?? 'Connection test failed'),
      });
    } catch {
      setTestResult({ ok: false, msg: 'Connection test failed' });
    }
  };

  const handleFetchMetadata = async () => {
    if (!samlMetadataUrl) return;
    setSamlCertificate('(fetched from metadata)');
  };

  if (isLoading) {
    return <div className="text-sm text-white/55 font-mono py-4 text-center">Loading SSO config...</div>;
  }

  return (
    <div className="space-y-6">
      <Card hover={false}>
        <div className="flex items-center justify-between mb-4">
          <SectionLabel>SSO Configuration</SectionLabel>
          {ssoConfig?.protocol && ssoConfig.protocol !== 'none' && (
            <Badge variant={ssoConfig.status === 'active' ? 'success' : 'medium'}>
              {ssoConfig.status === 'active' ? 'Active' : 'Configured'}
            </Badge>
          )}
        </div>

        {/* Protocol Selection */}
        <div className="mb-6">
          <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-2">
            Authentication Protocol
          </label>
          <div className="flex gap-2">
            {(['none', 'saml', 'oidc'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProtocol(p)}
                className={`px-4 py-2 rounded-lg text-[11px] font-mono border transition-colors ${
                  protocol === p
                    ? 'border-[color:var(--amber)]/40 bg-[color:var(--amber)]/10 text-[color:var(--amber)]'
                    : 'border-white/10 text-[color:var(--text-tertiary)] hover:bg-white/5'
                }`}
              >
                {p === 'none' ? 'Disabled' : p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* SAML Configuration */}
        {protocol === 'saml' && (
          <div className="space-y-4">
            <SectionLabel>SAML 2.0</SectionLabel>

            {/* Auto-generated fields */}
            <div className="bg-[color:var(--bg-page)] border border-white/10 rounded-lg p-4 space-y-3">
              <div>
                <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                  Entity ID (auto-generated)
                </label>
                <div className="flex gap-2 items-center">
                  <div className="flex-1 bg-white/[0.03] border border-white/[0.06] rounded-md px-3 py-2 text-xs font-mono text-[color:var(--text-secondary)] select-all">
                    {entityId}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigator.clipboard.writeText(entityId)}
                  >
                    Copy
                  </Button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                  ACS URL (auto-generated)
                </label>
                <div className="flex gap-2 items-center">
                  <div className="flex-1 bg-white/[0.03] border border-white/[0.06] rounded-md px-3 py-2 text-xs font-mono text-[color:var(--text-secondary)] select-all">
                    {acsUrl}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigator.clipboard.writeText(acsUrl)}
                  >
                    Copy
                  </Button>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                IdP Metadata URL
              </label>
              <div className="flex gap-2">
                <Input
                  value={samlMetadataUrl}
                  onChange={(e) => setSamlMetadataUrl(e.target.value)}
                  placeholder="https://idp.example.com/metadata.xml"
                  className="flex-1"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleFetchMetadata}
                  disabled={!samlMetadataUrl}
                >
                  Fetch Certificate
                </Button>
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                IdP Certificate
              </label>
              <div className="flex gap-2 items-center">
                <div className="flex-1">
                  {samlCertificate ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-positive/80">{samlCertificate}</span>
                      <Button variant="ghost" size="sm" onClick={() => setSamlCertificate('')}>
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <div className="px-3 py-2 border border-dashed border-white/20 rounded-lg text-[11px] text-[color:var(--text-tertiary)] hover:bg-white/5 transition-colors">
                        Upload IdP Certificate (.pem, .crt)
                      </div>
                      <input
                        type="file"
                        accept=".pem,.crt,.cer"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) setSamlCertificate(`(${file.name})`);
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* OIDC Configuration */}
        {protocol === 'oidc' && (
          <div className="space-y-4">
            <SectionLabel>OpenID Connect</SectionLabel>

            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                Provider
              </label>
              <Select
                options={OIDC_PROVIDERS}
                value={oidcProvider}
                onChange={(e) => setOidcProvider(e.target.value)}
                className="w-full"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                Client ID
              </label>
              <Input
                value={oidcClientId}
                onChange={(e) => setOidcClientId(e.target.value)}
                placeholder="Your application client ID"
                className="w-full"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                Client Secret
              </label>
              <Input
                type="password"
                value={oidcClientSecret}
                onChange={(e) => setOidcClientSecret(e.target.value)}
                placeholder="Your application client secret"
                className="w-full"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                Discovery URL
              </label>
              <Input
                value={oidcDiscoveryUrl}
                onChange={(e) => setOidcDiscoveryUrl(e.target.value)}
                placeholder={
                  oidcProvider === 'azure'
                    ? 'https://login.microsoftonline.com/{tenant}/.well-known/openid-configuration'
                    : oidcProvider === 'okta'
                    ? 'https://your-org.okta.com/.well-known/openid-configuration'
                    : oidcProvider === 'google'
                    ? 'https://accounts.google.com/.well-known/openid-configuration'
                    : 'https://your-provider/.well-known/openid-configuration'
                }
                className="w-full"
              />
            </div>
          </div>
        )}

        {/* Actions */}
        {protocol !== 'none' && (
          <div className="flex gap-2 mt-6 pt-4 border-t border-white/[0.06]">
            <Button
              size="md"
              onClick={handleSave}
              disabled={updateSso.isPending}
            >
              {updateSso.isPending ? 'Saving...' : 'Save SSO Configuration'}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={handleTest}
              disabled={testSso.isPending || (protocol === 'saml' && !samlMetadataUrl) || (protocol === 'oidc' && (!oidcClientId || !oidcDiscoveryUrl))}
            >
              {testSso.isPending ? 'Testing...' : 'Test SSO Connection'}
            </Button>
          </div>
        )}

        {protocol === 'none' && ssoConfig?.protocol && ssoConfig.protocol !== 'none' && (
          <div className="mt-4">
            <Button
              variant="danger"
              size="sm"
              onClick={handleSave}
              disabled={updateSso.isPending}
            >
              Disable SSO
            </Button>
          </div>
        )}

        {testResult && (
          <div className={`mt-3 text-[11px] font-mono ${testResult.ok ? 'text-positive' : 'text-accent'}`}>
            {testResult.msg}
          </div>
        )}

        {updateSso.isError && (
          <div className="mt-3 text-[11px] font-mono text-accent">
            Failed to save SSO configuration. Please check your settings.
          </div>
        )}
      </Card>

      {/* Info Card */}
      <Card hover={false}>
        <SectionLabel className="mb-2">How SSO Works</SectionLabel>
        <ul className="space-y-1.5 text-[11px] text-[color:var(--text-secondary)]">
          <li className="flex items-start gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--amber)]/60 mt-1 shrink-0" />
            SSO authentication runs inside the Averrow Worker via Web Crypto API — no additional infrastructure required
          </li>
          <li className="flex items-start gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--amber)]/60 mt-1 shrink-0" />
            When enabled, team members will be redirected to your identity provider on login
          </li>
          <li className="flex items-start gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--amber)]/60 mt-1 shrink-0" />
            Existing password-based accounts will continue to work as a fallback
          </li>
        </ul>
      </Card>
    </div>
  );
}
