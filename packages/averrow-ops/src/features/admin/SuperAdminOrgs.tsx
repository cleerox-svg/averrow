import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Card } from '@/components/ui/Card';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  useAdminOrgs, useAdminOrgDetail, useCreateOrg,
  useAdminUpdateOrg, useAdminOrgInvite, useAdminRemoveOrgMember,
  useAdminAssignBrand, useAdminRemoveBrand,
  useBrandSearch,
} from '@/hooks/useAdminOrgs';
import type { AdminOrg, BrandSearchResult, CreateOrgPayload } from '@/hooks/useAdminOrgs';
import {
  useCustomerPricing, usePricingPlans, useModulePrices,
  useCreatePricingOverride, useRevokePricingOverride,
  formatCents,
  type OrgPricingSummary, type OverrideType, type OrgPricingOverride,
} from '@/hooks/useAdminPricing';
import {
  useCustomerModules, useActivateModule, useSuspendModule,
  MODULE_LABELS,
  type CustomerModule, type ModuleStatus,
} from '@/hooks/useAdminCustomerModules';
import { CreateOrgSheet } from './components/CreateOrgSheet';

// ─── Plan config ────────────────────────────────────────────

const PLAN_CONFIG: Record<string, { label: string; price: string; defaultBrands: number; defaultMembers: number }> = {
  free: { label: 'Free', price: 'Free', defaultBrands: 1, defaultMembers: 3 },
  professional: { label: 'Professional', price: '$1,499/mo', defaultBrands: 5, defaultMembers: 10 },
  business: { label: 'Business', price: '$3,999/mo', defaultBrands: 15, defaultMembers: 25 },
  enterprise: { label: 'Enterprise', price: 'Custom', defaultBrands: 50, defaultMembers: 100 },
};

const planBadgeVariant = (plan: string): 'info' | 'success' | 'medium' | 'default' => {
  if (plan === 'enterprise') return 'info';
  if (plan === 'business') return 'success';
  if (plan === 'professional') return 'medium';
  return 'default';
};

const statusBadgeVariant = (status: string): 'success' | 'critical' | 'default' => {
  if (status === 'active') return 'success';
  if (status === 'suspended' || status === 'deactivated') return 'critical';
  return 'default';
};

// ─── Main Page ──────────────────────────────────────────────

export function SuperAdminOrgs() {
  const { isSuperAdmin } = useAuth();
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  if (!isSuperAdmin) {
    return <EmptyState message="Access Denied" description="Only super admins can access organization management." />;
  }

  if (selectedOrgId) {
    return <OrgDetailView orgId={selectedOrgId} onBack={() => setSelectedOrgId(null)} />;
  }

  return (
    <div className="space-y-6">
      <OrgListView
        onSelect={setSelectedOrgId}
        onCreate={() => setShowCreate(true)}
      />
      <CreateOrgSheet
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(orgId) => {
          setShowCreate(false);
          setSelectedOrgId(orgId);
        }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ORG LIST VIEW
// ═══════════════════════════════════════════════════════════════

function OrgListView({ onSelect, onCreate }: {
  onSelect: (orgId: string) => void;
  onCreate: () => void;
}) {
  const { data: orgs, isLoading } = useAdminOrgs();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[color:var(--text-primary)] font-display">Organizations</h1>
          <p className="text-[11px] text-[color:var(--text-tertiary)] font-mono mt-0.5">
            Manage all organizations on the platform
          </p>
        </div>
        <Button onClick={onCreate} className="bg-[color:var(--amber)] hover:bg-[color:var(--amber-dim)] text-black">
          Create New Organization
        </Button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="text-sm text-white/55 font-mono py-16 text-center">Loading organizations...</div>
      ) : !orgs || orgs.length === 0 ? (
        <EmptyState
          message="No organizations yet"
          description="Create your first organization to get started."
          action={{ label: 'Create Organization', onClick: onCreate }}
        />
      ) : (
        <div className="space-y-3">
          {orgs.map((org) => (
            <OrgListRow key={org.id} org={org} onClick={() => onSelect(String(org.id))} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrgListRow({ org, onClick }: { org: AdminOrg; onClick: () => void }) {
  return (
    <Card hover={false} className="cursor-pointer hover:border-white/20 transition-colors" >
      <button type="button" onClick={onClick} className="w-full text-left">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-sm font-bold text-[color:var(--text-primary)] shrink-0">
              {org.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-[color:var(--text-primary)]">{org.name}</span>
                <Badge variant={planBadgeVariant(org.plan)}>{org.plan}</Badge>
                <Badge variant={statusBadgeVariant(org.status)}>{org.status}</Badge>
              </div>
              <div className="text-[11px] text-[color:var(--text-tertiary)] font-mono mt-0.5">
                {org.slug}.averrow.com
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6 shrink-0 text-[11px] text-[color:var(--text-tertiary)] font-mono">
            <div className="text-center">
              <div className="text-sm font-bold text-[color:var(--text-primary)]">{org.member_count}</div>
              <div>members</div>
            </div>
            <div className="text-center">
              <div className="text-sm font-bold text-[color:var(--text-primary)]">{org.brand_count}</div>
              <div>brands</div>
            </div>
            <div className="text-center hidden sm:block">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{new Date(org.created_at).toLocaleDateString()}</div>
              <div>created</div>
            </div>
          </div>
        </div>
      </button>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// ORG DETAIL VIEW
// ═══════════════════════════════════════════════════════════════

// WS-B cull: dropped 'integrations' + 'api-keys' tabs. Both were
// pointer-text placeholders that just said "managed from the org's own
// dashboard" — the link they offered (/v2/admin/users) was wrong and
// the tabs gave no actual functionality. Org admins manage both
// surfaces from their own dashboard already (see features/settings).
const DETAIL_TABS = [
  { id: 'members', label: 'Members' },
  { id: 'brands', label: 'Brands' },
  { id: 'modules', label: 'Modules' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'settings', label: 'Settings' },
];

function OrgDetailView({ orgId, onBack }: { orgId: string; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState('members');
  const { data: org, isLoading } = useAdminOrgDetail(orgId);

  if (isLoading) {
    return <div className="text-sm text-white/55 font-mono py-16 text-center">Loading organization...</div>;
  }

  if (!org) {
    return <EmptyState message="Organization not found" />;
  }

  return (
    <div className="space-y-6">
      {/* Back button + Header */}
      <div>
        <button
          onClick={onBack}
          className="text-[11px] text-[color:var(--text-tertiary)] font-mono hover:text-[color:var(--text-primary)] transition-colors mb-3 flex items-center gap-1"
        >
          &larr; Back to Organizations
        </button>
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-lg font-bold text-[color:var(--text-primary)] shrink-0">
            {org.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-[color:var(--text-primary)] font-display">{org.name}</h1>
              <Badge variant={planBadgeVariant(org.plan)}>{org.plan}</Badge>
              <Badge variant={statusBadgeVariant(org.status)}>{org.status}</Badge>
            </div>
            <p className="text-[11px] text-[color:var(--text-tertiary)] font-mono mt-0.5">
              Created: {new Date(org.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} · {org.members?.length ?? 0} member{(org.members?.length ?? 0) !== 1 ? 's' : ''} · {org.brands?.length ?? 0} brand{(org.brands?.length ?? 0) !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="overflow-x-auto scrollbar-none -mx-1 px-1">
        <Tabs tabs={DETAIL_TABS} activeTab={activeTab} onChange={setActiveTab} />
      </div>

      {/* Tab Content */}
      {activeTab === 'members' && <DetailMembersTab orgId={orgId} members={org.members ?? []} />}
      {activeTab === 'brands' && <DetailBrandsTab orgId={orgId} brands={org.brands ?? []} maxBrands={org.max_brands} />}
      {activeTab === 'modules' && <DetailModulesTab orgId={orgId} />}
      {activeTab === 'pricing' && <DetailPricingTab orgId={orgId} />}
      {activeTab === 'settings' && <DetailSettingsTab orgId={orgId} org={org} />}
    </div>
  );
}

// ─── Members Tab ────────────────────────────────────────────

function DetailMembersTab({ orgId, members }: {
  orgId: string;
  members: { user_id: string; user_name: string; email: string; role: string; last_active_at: string | null; platform_role: string }[];
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const invite = useAdminOrgInvite(orgId);
  const removeMember = useAdminRemoveOrgMember(orgId);

  const handleInvite = async () => {
    if (!email) return;
    await invite.mutateAsync({ email, org_role: role });
    setEmail('');
    setRole('viewer');
    setShowInvite(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <SectionLabel>Team Members</SectionLabel>
        <Button size="sm" onClick={() => setShowInvite(!showInvite)}>Invite Member</Button>
      </div>

      {showInvite && (
        <Card hover={false}>
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1"
            />
            <Select
              options={[
                { value: 'viewer', label: 'Viewer' },
                { value: 'analyst', label: 'Analyst' },
                { value: 'admin', label: 'Admin' },
                { value: 'owner', label: 'Owner' },
              ]}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-32"
            />
            <Button size="sm" onClick={handleInvite} disabled={invite.isPending || !email}>
              {invite.isPending ? 'Sending...' : 'Send Invite'}
            </Button>
          </div>
        </Card>
      )}

      {members.length === 0 ? (
        <EmptyState message="No members yet" description="Invite the first member to this organization." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-white/55 font-mono uppercase tracking-wider border-b border-white/5">
                <th className="pb-2 pr-4">Name</th>
                <th className="pb-2 pr-4">Email</th>
                <th className="pb-2 pr-4">Org Role</th>
                <th className="pb-2 pr-4 hidden sm:table-cell">Last Active</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id} className="border-b border-white/[0.03]">
                  <td className="py-3 pr-4 text-[color:var(--text-primary)] font-medium">{m.user_name}</td>
                  <td className="py-3 pr-4 text-[color:var(--text-secondary)] font-mono">{m.email}</td>
                  <td className="py-3 pr-4">
                    <Badge variant={m.role === 'admin' || m.role === 'owner' ? 'info' : 'default'}>{m.role}</Badge>
                  </td>
                  <td className="py-3 pr-4 text-white/55 hidden sm:table-cell">
                    {m.last_active_at ? new Date(m.last_active_at).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-accent/60"
                      onClick={() => removeMember.mutate(m.user_id)}
                      disabled={removeMember.isPending}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Brands Tab ─────────────────────────────────────────────

function DetailBrandsTab({ orgId, brands, maxBrands }: {
  orgId: string;
  brands: { brand_id: string; brand_name: string; canonical_domain: string; is_primary: number }[];
  maxBrands: number;
}) {
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { data: searchResults } = useBrandSearch(searchQuery);
  const assignBrand = useAdminAssignBrand(orgId);
  const removeBrand = useAdminRemoveBrand(orgId);

  const assignedIds = new Set(brands.map(b => String(b.brand_id)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-[color:var(--text-tertiary)] font-mono">{brands.length} / {maxBrands} brands</div>
        <Button variant="secondary" size="sm" onClick={() => setShowSearch(!showSearch)} disabled={brands.length >= maxBrands}>
          Add Brand
        </Button>
      </div>

      {showSearch && (
        <Card hover={false}>
          <div className="space-y-3">
            <Input
              placeholder="Search brands by name or domain..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full"
              autoFocus
            />
            {searchResults && searchResults.length > 0 && (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {searchResults.filter(r => !assignedIds.has(String(r.id))).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      assignBrand.mutate({ brand_id: String(r.id) });
                      setSearchQuery('');
                    }}
                    className="w-full text-left px-3 py-2 rounded-md hover:bg-white/5 flex items-center justify-between transition-colors"
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
            {searchQuery.length >= 1 && searchResults && searchResults.filter(r => !assignedIds.has(String(r.id))).length === 0 && (
              <p className="text-[11px] text-white/55 py-2">No matching brands found</p>
            )}
          </div>
        </Card>
      )}

      {brands.length === 0 ? (
        <EmptyState message="No brands assigned" description="Add brands to start monitoring threats for this organization." />
      ) : (
        <div className="space-y-3">
          {brands.map((b) => (
            <Card key={b.brand_id} hover={false}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[color:var(--text-primary)]">{b.brand_name}</span>
                    {b.is_primary === 1 && <Badge variant="info">Primary</Badge>}
                  </div>
                  <div className="text-[11px] text-[color:var(--text-tertiary)] font-mono mt-0.5">{b.canonical_domain}</div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-accent/60"
                  onClick={() => removeBrand.mutate(b.brand_id)}
                  disabled={removeBrand.isPending}
                >
                  Remove
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Settings Tab ───────────────────────────────────────────

function DetailSettingsTab({ orgId, org }: { orgId: string; org: AdminOrg }) {
  const [name, setName] = useState(org.name);
  const [plan, setPlan] = useState(org.plan);
  const [maxBrands, setMaxBrands] = useState(String(org.max_brands));
  const [maxMembers, setMaxMembers] = useState(String(org.max_members));
  const updateOrg = useAdminUpdateOrg();

  const handleSave = () => {
    updateOrg.mutate({
      orgId,
      name,
      plan,
      max_brands: parseInt(maxBrands, 10),
      max_members: parseInt(maxMembers, 10),
    });
  };

  const handleDeactivate = () => {
    if (window.confirm(`Are you sure you want to deactivate "${org.name}"? This will suspend all access.`)) {
      updateOrg.mutate({ orgId, status: 'suspended' });
    }
  };

  return (
    <div className="space-y-6">
      <Card hover={false}>
        <SectionLabel className="mb-4">Organization Details</SectionLabel>
        <div className="space-y-4">
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
          </div>
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">Slug</label>
            <div className="text-sm text-[color:var(--text-tertiary)] font-mono">{org.slug} (read-only)</div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">Plan</label>
              <Select
                options={[
                  { value: 'free', label: 'Free' },
                  { value: 'professional', label: 'Professional' },
                  { value: 'business', label: 'Business' },
                  { value: 'enterprise', label: 'Enterprise' },
                ]}
                value={plan}
                onChange={(e) => {
                  setPlan(e.target.value);
                  const cfg = PLAN_CONFIG[e.target.value];
                  if (cfg) {
                    setMaxBrands(String(cfg.defaultBrands));
                    setMaxMembers(String(cfg.defaultMembers));
                  }
                }}
                className="w-full"
              />
              <p className="text-[10px] text-[color:var(--text-tertiary)] font-mono mt-1.5 leading-snug">
                Saving auto-activates this plan's modules on the Modules tab.
              </p>
            </div>
            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">Max Brands</label>
              <Input type="number" value={maxBrands} onChange={(e) => setMaxBrands(e.target.value)} className="w-full" />
            </div>
            <div>
              <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">Max Members</label>
              <Input type="number" value={maxMembers} onChange={(e) => setMaxMembers(e.target.value)} className="w-full" />
            </div>
          </div>
          <Button onClick={handleSave} disabled={updateOrg.isPending}>
            {updateOrg.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </Card>

      {/* Danger Zone */}
      <Card hover={false} className="border-accent/20">
        <SectionLabel className="mb-3 text-accent">Danger Zone</SectionLabel>
        <Button variant="danger" size="sm" onClick={handleDeactivate} disabled={org.status === 'suspended'}>
          {org.status === 'suspended' ? 'Organization Suspended' : 'Deactivate Organization'}
        </Button>
        <p className="text-[10px] text-white/50 mt-2">
          This will suspend all access for organization members.
        </p>
      </Card>
    </div>
  );
}

// ─── Pricing Tab ─────────────────────────────────────────────
//
// Sprint 2: read-only display of the customer's effective pricing
// (plan baseline + a-la-carte modules + active overrides → monthly
// total). Edit forms (override-create, plan/module-price PATCH)
// land in sprint 3.

function DetailPricingTab({ orgId }: { orgId: string }) {
  const { data, isLoading, error } = useCustomerPricing(orgId);

  if (isLoading) {
    return <div className="text-sm text-white/55 font-mono py-12 text-center">Loading pricing…</div>;
  }
  if (error) {
    return (
      <Card hover={false} className="border-accent/20">
        <p className="text-sm text-accent">Couldn't load pricing: {error.message}</p>
      </Card>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-4">
      <PricingHeadline summary={data} />
      <PlanCard summary={data} />
      {data.per_module_subscriptions.length > 0 && <ModuleAddOnsCard summary={data} />}
      <OverridesCard summary={data} orgId={orgId} />
      <OverrideCreateCard orgId={orgId} />
    </div>
  );
}

function PricingHeadline({ summary }: { summary: OrgPricingSummary }) {
  const billingTone =
    summary.billing_status === 'active'   ? 'success'  :
    summary.billing_status === 'trialing' ? 'medium'   :
    summary.billing_status === 'past_due' || summary.billing_status === 'cancelled' ? 'critical' :
                                            'default';
  return (
    <Card hover={false}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <SectionLabel className="mb-1">Effective monthly</SectionLabel>
          <div className="text-3xl font-bold text-[color:var(--text-primary)] tabular-nums">
            {formatCents(summary.effective_monthly_total_cents)}
          </div>
          <p className="text-[11px] text-[color:var(--text-tertiary)] font-mono mt-1">
            after {summary.active_overrides.length} override{summary.active_overrides.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="text-right">
          <SectionLabel className="mb-1">Billing</SectionLabel>
          <Badge variant={billingTone}>{summary.billing_status}</Badge>
          {summary.trial_ends_at && (
            <p className="text-[11px] text-[color:var(--text-tertiary)] font-mono mt-2">
              trial ends {new Date(summary.trial_ends_at).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function PlanCard({ summary }: { summary: OrgPricingSummary }) {
  if (!summary.plan) {
    return (
      <Card hover={false} className="border-accent/20">
        <SectionLabel className="mb-2">Plan</SectionLabel>
        <p className="text-sm text-[color:var(--text-secondary)]">
          No plan assigned. Customer is on the unbilled track — assign a plan via
          the Settings tab once Stripe sprint 3 lands the subscription create flow.
        </p>
      </Card>
    );
  }

  const tierOverride = summary.active_overrides.find((o) => o.override_type === 'tier_price');
  const baseline     = summary.plan.monthly_price_cents;
  const overridden   = tierOverride?.custom_price_cents ?? baseline;
  const isOverridden = tierOverride !== undefined;

  return (
    <Card hover={false}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <SectionLabel className="mb-1">Plan</SectionLabel>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-[color:var(--text-primary)]">
              {summary.plan.display_name}
            </h3>
            {!summary.plan.is_active && <Badge variant="default">retired</Badge>}
          </div>
          {summary.plan.description && (
            <p className="text-[12px] text-[color:var(--text-secondary)] mt-1">
              {summary.plan.description}
            </p>
          )}
        </div>
        <div className="text-right">
          <SectionLabel className="mb-1">Monthly</SectionLabel>
          <div className="tabular-nums font-mono">
            {isOverridden ? (
              <>
                <span className="line-through text-[color:var(--text-tertiary)] text-sm mr-2">
                  {formatCents(baseline)}
                </span>
                <span className="text-[color:var(--text-primary)] font-semibold">
                  {formatCents(overridden)}
                </span>
              </>
            ) : (
              <span className="text-[color:var(--text-primary)] font-semibold">
                {formatCents(baseline)}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 pt-4 border-t border-white/[0.06]">
        <SectionLabel className="mb-2">Included modules</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {summary.plan.included_modules.map((m) => (
            <span
              key={m}
              className="text-[11px] font-mono text-[color:var(--text-secondary)] bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5"
            >
              {m}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function ModuleAddOnsCard({ summary }: { summary: OrgPricingSummary }) {
  const moduleOverrides = summary.active_overrides.filter((o) => o.override_type === 'module_price');
  return (
    <Card hover={false}>
      <SectionLabel className="mb-3">Module add-ons (à-la-carte)</SectionLabel>
      <div className="space-y-2">
        {summary.per_module_subscriptions.map((m) => {
          const override     = moduleOverrides.find((o) => o.module_key === m.module_key);
          const isOverridden = override !== undefined;
          const effective    = override?.custom_price_cents ?? m.price_cents;
          return (
            <div key={m.module_key} className="flex items-center justify-between gap-3 py-1.5 border-b border-white/[0.04] last:border-b-0">
              <span className="text-sm text-[color:var(--text-primary)] font-mono">{m.module_key}</span>
              <div className="tabular-nums font-mono">
                {isOverridden ? (
                  <>
                    <span className="line-through text-[color:var(--text-tertiary)] text-xs mr-2">
                      {formatCents(m.price_cents)}
                    </span>
                    <span className="text-[color:var(--text-primary)]">{formatCents(effective)}</span>
                  </>
                ) : (
                  <span className="text-[color:var(--text-primary)]">{formatCents(m.price_cents)}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function OverridesCard({ summary, orgId }: { summary: OrgPricingSummary; orgId: string }) {
  if (summary.active_overrides.length === 0) {
    return (
      <Card hover={false}>
        <SectionLabel className="mb-2">Active overrides</SectionLabel>
        <p className="text-sm text-[color:var(--text-secondary)]">
          None. List prices apply.
        </p>
      </Card>
    );
  }
  return (
    <Card hover={false}>
      <SectionLabel className="mb-3">Active overrides ({summary.active_overrides.length})</SectionLabel>
      <div className="space-y-3">
        {summary.active_overrides.map((o) => (
          <OverrideRow key={o.id} override={o} orgId={orgId} />
        ))}
      </div>
    </Card>
  );
}

function OverrideRow({ override: o, orgId }: { override: OrgPricingOverride; orgId: string }) {
  const revoke = useRevokePricingOverride(orgId);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={o.override_type === 'discount_percent' ? 'success' : 'medium'}>
            {o.override_type}
          </Badge>
          {o.plan_id    && <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">plan: {o.plan_id}</span>}
          {o.module_key && <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">module: {o.module_key}</span>}
        </div>
        {confirming ? (
          <div className="flex items-center gap-1.5">
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                revoke.mutate(o.id, {
                  onSettled: () => setConfirming(false),
                });
              }}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? 'Revoking…' : 'Confirm revoke'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={revoke.isPending}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Revoke
          </Button>
        )}
      </div>
      <div className="text-sm font-mono text-[color:var(--text-primary)]">
        {o.override_type === 'discount_percent'
          ? `${o.discount_pct}% off`
          : formatCents(o.custom_price_cents ?? 0)}
      </div>
      <p className="text-[12px] text-[color:var(--text-secondary)] mt-1">{o.reason}</p>
      <p className="text-[10px] text-[color:var(--text-tertiary)] font-mono mt-1">
        from {new Date(o.effective_from).toLocaleDateString()}
        {o.effective_until && ` until ${new Date(o.effective_until).toLocaleDateString()}`}
      </p>
      {revoke.error && (
        <p className="text-[12px] text-accent mt-2">Revoke failed: {String(revoke.error)}</p>
      )}
    </div>
  );
}

// ─── Override Create Form ────────────────────────────────────────

function OverrideCreateCard({ orgId }: { orgId: string }) {
  const { data: plans } = usePricingPlans();
  const { data: modules } = useModulePrices();
  const create = useCreatePricingOverride(orgId);

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<OverrideType>('discount_percent');
  const [planId, setPlanId] = useState('');
  const [moduleKey, setModuleKey] = useState('');
  const [priceDollars, setPriceDollars] = useState('');
  const [discountPct, setDiscountPct] = useState('');
  const [reason, setReason] = useState('');

  const reset = () => {
    setType('discount_percent');
    setPlanId('');
    setModuleKey('');
    setPriceDollars('');
    setDiscountPct('');
    setReason('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    const input: Parameters<typeof create.mutateAsync>[0] = {
      override_type: type,
      reason: reason.trim(),
    };
    if (type === 'tier_price') {
      if (!planId || !priceDollars) return;
      input.plan_id = planId;
      input.custom_price_cents = Math.round(Number(priceDollars) * 100);
    } else if (type === 'module_price') {
      if (!moduleKey || !priceDollars) return;
      input.module_key = moduleKey;
      input.custom_price_cents = Math.round(Number(priceDollars) * 100);
    } else if (type === 'discount_percent') {
      if (!discountPct) return;
      input.discount_pct = Number(discountPct);
    }
    try {
      await create.mutateAsync(input);
      reset();
      setOpen(false);
    } catch {
      // Error rendered inline via create.error below
    }
  };

  if (!open) {
    return (
      <Card hover={false}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <SectionLabel className="mb-1">New override</SectionLabel>
            <p className="text-[12px] text-[color:var(--text-secondary)]">
              Discount, custom tier price, or per-module rate. Append-only — the audit trail keeps every change.
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            Add override
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card hover={false}>
      <SectionLabel className="mb-3">Create override</SectionLabel>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
            Type
          </label>
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as OverrideType)}
            className="w-full"
            options={[
              { value: 'discount_percent', label: 'Discount %' },
              { value: 'tier_price', label: 'Custom tier price' },
              { value: 'module_price', label: 'Custom module price' },
            ]}
          />
        </div>

        {type === 'tier_price' && (
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Plan
            </label>
            <Select
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              className="w-full"
              required
              options={[
                { value: '', label: 'Select a plan…' },
                ...(plans?.plans ?? []).map((p) => ({
                  value: String(p.id),
                  label: `${p.display_name} (${formatCents(p.monthly_price_cents)} list)`,
                })),
              ]}
            />
          </div>
        )}

        {type === 'module_price' && (
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Module
            </label>
            <Select
              value={moduleKey}
              onChange={(e) => setModuleKey(e.target.value)}
              className="w-full"
              required
              options={[
                { value: '', label: 'Select a module…' },
                ...(modules?.modules ?? []).map((m) => ({
                  value: String(m.module_key),
                  label: `${m.display_name} (${formatCents(m.monthly_price_cents)} list)`,
                })),
              ]}
            />
          </div>
        )}

        {type !== 'discount_percent' && (
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Custom price (USD/month)
            </label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={priceDollars}
              onChange={(e) => setPriceDollars(e.target.value)}
              placeholder="e.g. 1199.00"
              className="w-full"
              required
            />
          </div>
        )}

        {type === 'discount_percent' && (
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Discount % (0–100)
            </label>
            <Input
              type="number"
              min="0"
              max="100"
              step="0.5"
              value={discountPct}
              onChange={(e) => setDiscountPct(e.target.value)}
              placeholder="e.g. 15"
              className="w-full"
              required
            />
          </div>
        )}

        <div>
          <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
            Reason (recorded in audit trail)
          </label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Annual prepay discount, Enterprise deal Q3"
            className="w-full"
            required
          />
        </div>

        {create.error && (
          <p className="text-[12px] text-accent">
            Couldn't create: {create.error instanceof Error ? create.error.message : String(create.error)}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button variant="primary" type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Add override'}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => { reset(); setOpen(false); }}
            disabled={create.isPending}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ─── Modules Tab ─────────────────────────────────────────────
//
// Per-customer module-entitlement management (operator-flagged
// gap during the Customers page workflow review). Wraps
// /api/orgs/:orgId/modules + the super_admin POST endpoint so
// staff can activate / start a trial / suspend any of the 7
// canonical modules without going to Stripe.
//
// In production, Stripe webhook keeps this in sync with the
// customer's subscription. Manual edits here are for design
// partners, free pilots, troubleshooting, and gap fills before
// Stripe products are wired.

function DetailModulesTab({ orgId }: { orgId: string }) {
  const { data, isLoading, error } = useCustomerModules(orgId);

  if (isLoading) return <div className="text-sm text-white/55 font-mono py-12 text-center">Loading modules…</div>;
  if (error)     return <Card hover={false} className="border-accent/20"><p className="text-sm text-accent">Couldn't load modules: {error.message}</p></Card>;
  if (!data)     return null;

  const activeCount    = data.modules.filter((m) => m.status === 'active' || m.status === 'trial').length;
  const totalCount     = data.modules.length;
  const trialCount     = data.modules.filter((m) => m.status === 'trial').length;
  const suspendedCount = data.modules.filter((m) => m.status === 'suspended').length;

  return (
    <div className="space-y-4">
      <Card hover={false}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <SectionLabel className="mb-1">Module entitlements</SectionLabel>
            <p className="text-[12px] text-[color:var(--text-secondary)]">
              {activeCount} of {totalCount} active
              {trialCount > 0     && <> · {trialCount} on trial</>}
              {suspendedCount > 0 && <> · {suspendedCount} suspended</>}
            </p>
          </div>
          <div className="text-[11px] text-[color:var(--text-tertiary)] font-mono">
            Stripe webhook keeps these synced in production.
          </div>
        </div>
      </Card>

      <div className="space-y-2">
        {data.modules.map((m) => (
          <ModuleRow key={m.module_key} orgId={orgId} module={m} />
        ))}
      </div>
    </div>
  );
}

function ModuleRow({ orgId, module: m }: { orgId: string; module: CustomerModule }) {
  const activate = useActivateModule(orgId);
  const suspend  = useSuspendModule(orgId);
  const [showTrial, setShowTrial] = useState(false);
  const [trialDays, setTrialDays] = useState('14');

  const error = activate.error ?? suspend.error;

  const handleActivate = () => {
    activate.mutate({ module_key: m.module_key });
  };

  const handleStartTrial = () => {
    if (!trialDays || Number(trialDays) <= 0) return;
    const trialEndsAt = new Date(Date.now() + Number(trialDays) * 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    activate.mutate(
      { module_key: m.module_key, trial_ends_at: trialEndsAt },
      { onSuccess: () => setShowTrial(false) },
    );
  };

  const handleSuspend = () => {
    suspend.mutate({ module_key: m.module_key });
  };

  const tone = statusBadgeTone(m.status);

  return (
    <Card hover={false}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">
              {MODULE_LABELS[m.module_key] ?? m.module_key}
            </h3>
            <Badge variant={tone}>{m.status.replace('_', ' ')}</Badge>
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">key: {m.module_key}</span>
            {m.activated_at && (
              <span className="text-[11px] font-mono text-[color:var(--text-tertiary)]">
                activated {formatDateShort(m.activated_at)}
              </span>
            )}
            {m.trial_ends_at && (
              <span className="text-[11px] font-mono text-amber/85">
                trial ends {formatDateShort(m.trial_ends_at)}
              </span>
            )}
            {m.suspended_at && (
              <span className="text-[11px] font-mono text-accent/85">
                suspended {formatDateShort(m.suspended_at)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {m.status === 'not_entitled' && (
            <>
              <Button variant="primary" size="sm" onClick={handleActivate} disabled={activate.isPending}>
                {activate.isPending ? 'Saving…' : 'Activate'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setShowTrial(true)} disabled={activate.isPending}>
                Start trial
              </Button>
            </>
          )}
          {m.status === 'trial' && (
            <>
              <Button variant="primary" size="sm" onClick={handleActivate} disabled={activate.isPending}>
                {activate.isPending ? 'Saving…' : 'Convert to active'}
              </Button>
              <Button variant="danger" size="sm" onClick={handleSuspend} disabled={suspend.isPending}>
                Suspend
              </Button>
            </>
          )}
          {m.status === 'active' && (
            <Button variant="danger" size="sm" onClick={handleSuspend} disabled={suspend.isPending}>
              {suspend.isPending ? 'Suspending…' : 'Suspend'}
            </Button>
          )}
          {m.status === 'suspended' && (
            <Button variant="primary" size="sm" onClick={handleActivate} disabled={activate.isPending}>
              {activate.isPending ? 'Saving…' : 'Re-activate'}
            </Button>
          )}
        </div>
      </div>

      {showTrial && (
        <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-end gap-2 flex-wrap">
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Trial length (days)
            </label>
            <Input
              type="number"
              min="1"
              max="365"
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
              className="w-32"
            />
          </div>
          <Button variant="primary" size="sm" onClick={handleStartTrial} disabled={activate.isPending}>
            {activate.isPending ? 'Saving…' : 'Start trial'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowTrial(false)} disabled={activate.isPending}>
            Cancel
          </Button>
        </div>
      )}

      {error && (
        <p className="text-[12px] text-accent mt-2">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
    </Card>
  );
}

function statusBadgeTone(status: ModuleStatus): 'success' | 'medium' | 'critical' | 'default' {
  if (status === 'active')       return 'success';
  if (status === 'trial')        return 'medium';
  if (status === 'suspended')    return 'critical';
  return 'default';
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default SuperAdminOrgs;
