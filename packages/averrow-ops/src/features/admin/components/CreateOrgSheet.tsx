import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { useCreateOrg, useBrandSearch } from '@/hooks/useAdminOrgs';
import type { BrandSearchResult } from '@/hooks/useAdminOrgs';

interface CreateOrgSheetProps {
  open: boolean;
  onClose: () => void;
  onCreated: (orgId: string) => void;
}

// ─── Plan defaults ──────────────────────────────────────────

const PLAN_OPTIONS = [
  { value: 'free', label: 'Free' },
  { value: 'professional', label: 'Professional — $1,499/mo' },
  { value: 'business', label: 'Business — $3,999/mo' },
  { value: 'enterprise', label: 'Enterprise — Custom' },
];

const PLAN_DEFAULTS: Record<string, { brands: number; members: number }> = {
  free: { brands: 1, members: 3 },
  professional: { brands: 5, members: 10 },
  business: { brands: 15, members: 25 },
  enterprise: { brands: 50, members: 100 },
};

// ─── Service definitions ────────────────────────────────────

const SERVICES = [
  { id: 'sso', label: 'SSO (SAML/OIDC)', group: 'core' },
  { id: 'siem_splunk', label: 'Splunk', group: 'siem' },
  { id: 'siem_elastic', label: 'Elastic', group: 'siem' },
  { id: 'siem_sentinel', label: 'Microsoft Sentinel', group: 'siem' },
  { id: 'siem_qradar', label: 'QRadar', group: 'siem' },
  { id: 'webhook', label: 'Webhook Notifications', group: 'core' },
  { id: 'api_access', label: 'API Access', group: 'core' },
  { id: 'email_notifications', label: 'Email Notifications', group: 'core' },
  { id: 'takedown_service', label: 'Takedown Service', group: 'core' },
  { id: 'custom_threat_feeds', label: 'Custom Threat Feeds', group: 'core' },
];

// ─── Slug generator ─────────────────────────────────────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

// ─── Component ──────────────────────────────────────────────

export function CreateOrgSheet({ open, onClose, onCreated }: CreateOrgSheetProps) {
  const [step, setStep] = useState(1);

  // Step 1: Org details
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [plan, setPlan] = useState('professional');
  const [maxBrands, setMaxBrands] = useState('5');
  const [maxMembers, setMaxMembers] = useState('10');

  // Step 2: Brand assignment
  const [brandQuery, setBrandQuery] = useState('');
  const [selectedBrands, setSelectedBrands] = useState<(BrandSearchResult & { is_primary: boolean })[]>([]);
  const { data: brandResults } = useBrandSearch(brandQuery);

  // Step 3: Services
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set(['api_access', 'email_notifications']));

  // Step 4: First admin
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');

  const createOrg = useCreateOrg();

  // Auto-generate slug from name
  useEffect(() => {
    if (!slugEdited && name) {
      setSlug(generateSlug(name));
    }
  }, [name, slugEdited]);

  // Apply plan defaults
  useEffect(() => {
    const defaults = PLAN_DEFAULTS[plan];
    if (defaults) {
      setMaxBrands(String(defaults.brands));
      setMaxMembers(String(defaults.members));
    }
  }, [plan]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setStep(1);
      setName('');
      setSlug('');
      setSlugEdited(false);
      setPlan('professional');
      setMaxBrands('5');
      setMaxMembers('10');
      setBrandQuery('');
      setSelectedBrands([]);
      setSelectedServices(new Set(['api_access', 'email_notifications']));
      setAdminEmail('');
      setAdminName('');
    }
  }, [open]);

  if (!open) return null;

  const selectedBrandIds = new Set(selectedBrands.map(b => b.id));

  const toggleService = (id: string) => {
    setSelectedServices(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addBrand = (brand: BrandSearchResult) => {
    setSelectedBrands(prev => [...prev, { ...brand, is_primary: prev.length === 0 }]);
    setBrandQuery('');
  };

  const removeBrand = (id: number) => {
    setSelectedBrands(prev => {
      const next = prev.filter(b => b.id !== id);
      // Ensure there's always a primary if brands exist
      if (next.length > 0 && !next.some(b => b.is_primary)) {
        next[0].is_primary = true;
      }
      return next;
    });
  };

  const setPrimaryBrand = (id: number) => {
    setSelectedBrands(prev => prev.map(b => ({ ...b, is_primary: b.id === id })));
  };

  const handleCreate = async () => {
    const payload = {
      name,
      slug,
      plan,
      max_brands: parseInt(maxBrands, 10),
      max_members: parseInt(maxMembers, 10),
      brands: selectedBrands.map(b => ({ brand_id: String(b.id), is_primary: b.is_primary })),
      services: Array.from(selectedServices),
      admin_email: adminEmail || undefined,
      admin_name: adminName || undefined,
    };

    const result = await createOrg.mutateAsync(payload);
    const orgData = result.data as Record<string, unknown> | undefined;
    if (orgData?.id) {
      onCreated(String(orgData.id));
    } else {
      onClose();
    }
  };

  const totalSteps = 4;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg bg-instrument border border-white/10 rounded-t-2xl sm:rounded-xl p-6 max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="font-mono text-xs font-bold text-[color:var(--amber)] uppercase tracking-wider">
            Create Organization — Step {step}/{totalSteps}
          </div>
          <button onClick={onClose} className="text-white/55 hover:text-[color:var(--text-primary)] text-lg">&times;</button>
        </div>

        {/* Progress bar */}
        <div className="h-1 rounded-full bg-white/5 mb-6">
          <div
            className="h-full rounded-full bg-[color:var(--amber)] transition-all"
            style={{ width: `${(step / totalSteps) * 100}%` }}
          />
        </div>

        {/* Step 1: Organization Details */}
        {step === 1 && (
          <div className="space-y-4">
            <SectionLabel>Organization Details</SectionLabel>
            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                Organization Name
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Corporation"
                className="w-full"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                Slug
              </label>
              <div className="flex items-center gap-2">
                <Input
                  value={slug}
                  onChange={(e) => { setSlug(e.target.value); setSlugEdited(true); }}
                  placeholder="acme-corporation"
                  className="flex-1"
                />
                <span className="text-[10px] text-white/55 font-mono shrink-0">.averrow.com</span>
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                Plan
              </label>
              <Select options={PLAN_OPTIONS} value={plan} onChange={(e) => setPlan(e.target.value)} className="w-full" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                  Max Brands
                </label>
                <Input type="number" value={maxBrands} onChange={(e) => setMaxBrands(e.target.value)} className="w-full" />
              </div>
              <div>
                <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                  Max Members
                </label>
                <Input type="number" value={maxMembers} onChange={(e) => setMaxMembers(e.target.value)} className="w-full" />
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Brand Assignment */}
        {step === 2 && (
          <div className="space-y-4">
            <SectionLabel>Brand Assignment</SectionLabel>
            <p className="text-[11px] text-white/55">
              Search and assign brands to this organization. The first brand added is automatically set as primary.
            </p>
            <div>
              <Input
                placeholder="Search brands by name or domain..."
                value={brandQuery}
                onChange={(e) => setBrandQuery(e.target.value)}
                className="w-full"
                autoFocus
              />
              {brandResults && brandResults.length > 0 && brandQuery.length >= 1 && (
                <div className="mt-2 border border-white/10 rounded-md overflow-hidden max-h-48 overflow-y-auto">
                  {brandResults.filter(r => !selectedBrandIds.has(r.id)).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => addBrand(r)}
                      className="w-full text-left px-3 py-2 hover:bg-white/5 border-b border-white/[0.03] last:border-0 flex items-center justify-between transition-colors"
                    >
                      <div>
                        <span className="text-sm text-[color:var(--text-primary)]">{r.name}</span>
                        <span className="text-[11px] text-white/55 font-mono ml-2">{r.canonical_domain}</span>
                      </div>
                      <span className="text-[10px] text-white/55">{r.threat_count} threats</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Selected brands */}
            {selectedBrands.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] text-[color:var(--text-tertiary)] font-mono">{selectedBrands.length} brand{selectedBrands.length !== 1 ? 's' : ''} selected</div>
                {selectedBrands.map((b) => (
                  <div key={b.id} className="flex items-center justify-between py-2 px-3 rounded-md bg-white/[0.03] border border-white/[0.06]">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-[color:var(--text-primary)]">{b.name}</span>
                      <span className="text-[11px] text-white/55 font-mono">{b.canonical_domain}</span>
                      {b.is_primary && <Badge variant="info">Primary</Badge>}
                    </div>
                    <div className="flex items-center gap-2">
                      {!b.is_primary && (
                        <button
                          type="button"
                          onClick={() => setPrimaryBrand(b.id)}
                          className="text-[10px] font-mono text-white/55 hover:text-[color:var(--amber)] transition-colors"
                        >
                          Set Primary
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeBrand(b.id)}
                        className="text-[10px] font-mono text-accent/60 hover:text-accent transition-colors"
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 3: Services & Integrations */}
        {step === 3 && (
          <div className="space-y-4">
            <SectionLabel>Services & Integrations</SectionLabel>
            <p className="text-[11px] text-white/55">
              Select services to enable. They will be created with "pending setup" status for the org admin to configure.
            </p>

            <div className="space-y-1">
              {SERVICES.filter(s => s.group === 'core').map((svc) => (
                <label key={svc.id} className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-white/[0.03] cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={selectedServices.has(svc.id)}
                    onChange={() => toggleService(svc.id)}
                    className="accent-[color:var(--amber)] w-3.5 h-3.5"
                  />
                  <span className="text-sm text-[color:var(--text-primary)]/80">{svc.label}</span>
                </label>
              ))}
            </div>

            <div className="text-[11px] text-[color:var(--text-tertiary)] font-mono uppercase tracking-wide pt-2">SIEM Integration</div>
            <div className="space-y-1 ml-2">
              {SERVICES.filter(s => s.group === 'siem').map((svc) => (
                <label key={svc.id} className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-white/[0.03] cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={selectedServices.has(svc.id)}
                    onChange={() => toggleService(svc.id)}
                    className="accent-[color:var(--amber)] w-3.5 h-3.5"
                  />
                  <span className="text-sm text-[color:var(--text-primary)]/80">{svc.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Step 4: First Admin */}
        {step === 4 && (
          <div className="space-y-4">
            <SectionLabel>First Admin</SectionLabel>
            <p className="text-[11px] text-white/55">
              This person will be invited as the organization's Brand Admin. They can then invite other members and configure integrations.
            </p>
            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                Admin Name
              </label>
              <Input
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="Jane Smith"
                className="w-full"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
                Admin Email (required)
              </label>
              <Input
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="admin@acme.com"
                className="w-full"
              />
            </div>

            {/* Summary */}
            <div className="mt-4 p-3 rounded-lg bg-white/[0.03] border border-white/[0.06] space-y-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-[color:var(--text-secondary)]">Summary</div>
              <div className="text-[11px] text-[color:var(--text-primary)]/70 space-y-1">
                <div><span className="text-[color:var(--text-tertiary)]">Org:</span> {name}</div>
                <div><span className="text-[color:var(--text-tertiary)]">Plan:</span> {plan} · {maxBrands} brands · {maxMembers} members</div>
                <div><span className="text-[color:var(--text-tertiary)]">Brands:</span> {selectedBrands.length} assigned</div>
                <div><span className="text-[color:var(--text-tertiary)]">Services:</span> {selectedServices.size} enabled</div>
                {adminEmail && <div><span className="text-[color:var(--text-tertiary)]">Admin:</span> {adminEmail}</div>}
              </div>
            </div>
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex gap-2 pt-6">
          {step > 1 && (
            <Button type="button" variant="secondary" size="md" onClick={() => setStep(step - 1)} className="flex-1">
              Back
            </Button>
          )}
          {step < totalSteps ? (
            <Button
              type="button"
              size="md"
              onClick={() => setStep(step + 1)}
              disabled={step === 1 && !name.trim()}
              className="flex-1 bg-[color:var(--amber)] hover:bg-[color:var(--amber-dim)] text-black"
            >
              Continue
            </Button>
          ) : (
            <Button
              type="button"
              size="md"
              onClick={handleCreate}
              disabled={createOrg.isPending || !name.trim()}
              className="flex-1 bg-[color:var(--amber)] hover:bg-[color:var(--amber-dim)] text-black"
            >
              {createOrg.isPending ? 'Creating...' : 'Create Organization'}
            </Button>
          )}
        </div>

        {createOrg.isError && (
          <p className="text-[11px] text-accent mt-2">Failed to create organization. Please try again.</p>
        )}
      </div>
    </div>
  );
}
