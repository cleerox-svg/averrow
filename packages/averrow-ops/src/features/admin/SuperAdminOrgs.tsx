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

const DETAIL_TABS = [
  { id: 'members', label: 'Members' },
  { id: 'brands', label: 'Brands' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'api-keys', label: 'API Keys' },
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
      {activeTab === 'integrations' && <DetailIntegrationsTab orgId={orgId} />}
      {activeTab === 'api-keys' && <DetailApiKeysTab orgId={orgId} />}
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

// ─── Integrations Tab (placeholder - uses existing tenant endpoints) ──

function DetailIntegrationsTab({ orgId }: { orgId: string }) {
  return (
    <div className="space-y-4">
      <SectionLabel>Integrations</SectionLabel>
      <p className="text-[11px] text-white/55">
        Integration configuration is managed from the organization's own dashboard.
        Assigned integrations are created during org setup and can be configured by the org admin.
      </p>
      <Button variant="secondary" size="sm" onClick={() => window.open(`/v2/admin/users`, '_blank')}>
        Open Org Dashboard
      </Button>
    </div>
  );
}

// ─── API Keys Tab (placeholder) ─────────────────────────────

function DetailApiKeysTab({ orgId }: { orgId: string }) {
  return (
    <div className="space-y-4">
      <SectionLabel>API Keys</SectionLabel>
      <p className="text-[11px] text-white/55">
        API keys are managed from the organization's own dashboard by org admins.
      </p>
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

export default SuperAdminOrgs;
