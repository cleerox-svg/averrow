import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Card,
  SectionLabel,
  Badge,
  Button,
  Tabs,
  EmptyState,
  PageHeader,
  Input,
  Select,
} from '@/design-system/components';
import { MemberInviteSheet } from '@/features/admin/components/MemberInviteSheet';
import { IntegrationCard } from '@/features/admin/components/IntegrationCard';
import type { IntegrationDef } from '@/features/admin/components/IntegrationCard';
import { ConnectIntegrationSheet } from '@/features/admin/components/ConnectIntegrationSheet';
import { ApiKeyCreateSheet } from '@/features/admin/components/ApiKeyCreateSheet';
import { WebhookConfig } from '@/features/admin/components/WebhookConfig';
import { SsoConfig } from '@/features/admin/components/SsoConfig';
import {
  useOrg, useOrgMembers, useOrgBrands, useOrgInvites,
  useOrgApiKeys, useOrgIntegrations, useOrgIntegrationActivity,
  useRemoveMember, useUpdateMemberRole, useRevokeInvite,
  useRemoveBrand, useRevokeApiKey, useDeleteIntegration,
  useUpdateOrg,
} from '@/hooks/useOrganization';
import type { Integration } from '@/hooks/useOrganization';
import { relativeTime } from '@/lib/time';

// ─── Integration catalog ────────────────────────────────────

const SIEM_INTEGRATIONS: IntegrationDef[] = [
  { type: 'splunk', category: 'siem', name: 'Splunk', description: 'HTTP Event Collector', logoChar: 'Sp' },
  { type: 'sentinel', category: 'siem', name: 'Microsoft Sentinel', description: 'Log Analytics', logoChar: 'Se' },
  { type: 'elastic', category: 'siem', name: 'Elastic SIEM', description: 'Elasticsearch API', logoChar: 'El' },
  { type: 'qradar', category: 'siem', name: 'IBM QRadar', description: 'CEF/Syslog', logoChar: 'QR' },
];

const TICKETING_INTEGRATIONS: IntegrationDef[] = [
  { type: 'jira', category: 'ticketing', name: 'Jira', description: 'Issue tracking', logoChar: 'Ji' },
  { type: 'servicenow', category: 'ticketing', name: 'ServiceNow', description: 'Incident management', logoChar: 'SN' },
  { type: 'pagerduty', category: 'ticketing', name: 'PagerDuty', description: 'Alerting & on-call', logoChar: 'PD' },
  { type: 'linear', category: 'ticketing', name: 'Linear', description: 'Project tracking', logoChar: 'Li' },
];

const INBOUND_INTEGRATIONS: IntegrationDef[] = [
  { type: 'mimecast', category: 'inbound', name: 'Mimecast', description: 'Email security', logoChar: 'Mc' },
  { type: 'proofpoint', category: 'inbound', name: 'Proofpoint TAP', description: 'Targeted attack protection', logoChar: 'Pp' },
  { type: 'defender', category: 'inbound', name: 'Microsoft Defender', description: 'Endpoint detection', logoChar: 'Df' },
  { type: 'crowdstrike', category: 'inbound', name: 'CrowdStrike', description: 'Threat intelligence', logoChar: 'CS' },
];

// ─── Tab definitions ────────────────────────────────────────

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'brands', label: 'Brands' },
  { id: 'members', label: 'Members' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'sso', label: 'SSO' },
  { id: 'settings', label: 'Settings' },
];

// ─── Main Page ──────────────────────────────────────────────

export function Organization() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab');
  const initialTab = TABS.some(t => t.id === tabFromUrl) ? tabFromUrl! : 'overview';
  const [activeTab, setActiveTabState] = useState(initialTab);
  const setActiveTab = (id: string) => {
    setActiveTabState(id);
    // Keep URL in sync so back/forward + bookmarks land on the same
    // tab and the Sidebar can deep-link via `?tab=members`. Audit H9.
    const next = new URLSearchParams(searchParams);
    if (id === 'overview') next.delete('tab'); else next.set('tab', id);
    setSearchParams(next, { replace: true });
  };
  const [showInvite, setShowInvite] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [connectIntegration, setConnectIntegration] = useState<IntegrationDef | null>(null);

  const { data: org, isLoading: orgLoading } = useOrg();
  const { data: members } = useOrgMembers();
  const { data: brands } = useOrgBrands();
  const { data: invites } = useOrgInvites();
  const { data: apiKeys } = useOrgApiKeys();
  const { data: integrations } = useOrgIntegrations();

  if (orgLoading) {
    return <div className="text-sm text-white/55 font-mono py-16 text-center">Loading organization...</div>;
  }

  const brandCount = brands?.length ?? 0;
  const memberCount = members?.length ?? 0;
  const maxBrands = org?.max_brands ?? 5;
  const maxMembers = org?.max_members ?? 10;

  const connectedIntegrations = integrations?.filter((i) => i.status === 'connected') ?? [];
  const findIntegration = (type: string): Integration | undefined =>
    integrations?.find((i) => i.type === type);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader title="Organization" subtitle={org?.name ?? 'Settings'} />

      {/* Tab Bar */}
      <Tabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} variant="underline" sticky />

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <OverviewTab
          brandCount={brandCount}
          maxBrands={maxBrands}
          memberCount={memberCount}
          maxMembers={maxMembers}
          integrationCount={connectedIntegrations.length}
          plan={org?.plan ?? 'enterprise'}
        />
      )}

      {activeTab === 'brands' && (
        <BrandsTab brands={brands ?? []} maxBrands={maxBrands} />
      )}

      {activeTab === 'members' && (
        <MembersTab
          members={members ?? []}
          invites={invites ?? []}
          onInvite={() => setShowInvite(true)}
        />
      )}

      {activeTab === 'integrations' && (
        <IntegrationsTab
          integrations={integrations ?? []}
          onConnect={setConnectIntegration}
        />
      )}

      {activeTab === 'api-keys' && (
        <ApiKeysTab apiKeys={apiKeys ?? []} onCreate={() => setShowApiKey(true)} />
      )}

      {activeTab === 'webhooks' && <WebhookConfig />}

      {activeTab === 'sso' && <SsoConfig slug={org?.slug ?? 'lrx-enterprises'} />}

      {activeTab === 'settings' && <SettingsTab orgName={org?.name ?? ''} slug={org?.slug ?? ''} />}

      {/* Sheets / Modals */}
      <MemberInviteSheet open={showInvite} onClose={() => setShowInvite(false)} />
      <ApiKeyCreateSheet open={showApiKey} onClose={() => setShowApiKey(false)} />
      <ConnectIntegrationSheet
        open={!!connectIntegration}
        onClose={() => setConnectIntegration(null)}
        integration={connectIntegration}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 1 — OVERVIEW
// ═══════════════════════════════════════════════════════════════

function OverviewTab({ brandCount, maxBrands, memberCount, maxMembers, integrationCount, plan }: {
  brandCount: number; maxBrands: number; memberCount: number; maxMembers: number; integrationCount: number; plan: string;
}) {
  return (
    <div className="space-y-6">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatMiniCard label="Brands Monitored" value={`${brandCount} / ${maxBrands}`} pct={brandCount / maxBrands} />
        <StatMiniCard label="Team Members" value={`${memberCount} / ${maxMembers}`} pct={memberCount / maxMembers} />
        <StatMiniCard label="Threats This Month" value="—" />
        <StatMiniCard label="Active Integrations" value={String(integrationCount)} />
      </div>

      {/* Plan Details */}
      <Card hover={false}>
        <SectionLabel className="mb-3">{plan.toUpperCase()} Plan</SectionLabel>
        <ul className="space-y-1.5 text-[11px] opacity-70">
          <li className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-positive" /> Unlimited threat monitoring</li>
          <li className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-positive" /> Up to {maxBrands} brands, {maxMembers} members</li>
          <li className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-positive" /> SIEM integrations</li>
          <li className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-positive" /> API access</li>
          <li className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-positive" /> Priority support</li>
        </ul>
        <div className="mt-4">
          <p className="mt-1.5 text-[10px] font-mono text-white/40">
            Self-serve billing coming soon. Email{' '}
            <a href="mailto:billing@averrow.com" style={{ color: 'var(--amber)' }}>
              billing@averrow.com
            </a>
            {' '}to change plans.
          </p>
        </div>
      </Card>
    </div>
  );
}

function StatMiniCard({ label, value, pct }: { label: string; value: string; pct?: number }) {
  return (
    <Card hover={false} className="p-3">
      <div className="font-mono text-[9px] uppercase tracking-widest text-white/55 mb-1">{label}</div>
      <div className="text-lg font-bold text-white/90 font-display">{value}</div>
      {pct !== undefined && (
        <div className="mt-2 h-1 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full rounded-full bg-afterburner transition-all"
            style={{ width: `${Math.min(pct * 100, 100)}%` }}
          />
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 2 — BRANDS
// ═══════════════════════════════════════════════════════════════

function BrandsTab({ brands, maxBrands }: {
  brands: { brand_id: string; brand_name: string; canonical_domain: string; is_primary: number; threat_count: number }[];
  maxBrands: number;
}) {
  const removeBrand = useRemoveBrand();
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-white/40 font-mono">{brands.length} / {maxBrands} brands</div>
      </div>
      <p className="text-[10px] font-mono text-white/40 -mt-2">
        Member-side brand add lands in v3. Today: super-admins assign brands via{' '}
        <span style={{ color: 'var(--amber)' }}>/admin/organizations</span>.
      </p>

      {brands.length === 0 ? (
        <EmptyState message="No brands assigned" description="Add brands to start monitoring threats for your organization." />
      ) : (
        <div className="space-y-3">
          {brands.map((b) => (
            <Card key={b.brand_id} hover={false}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white/90">{b.brand_name}</span>
                    {b.is_primary === 1 && <Badge variant="info">Primary</Badge>}
                  </div>
                  <div className="text-[11px] text-white/40 font-mono mt-0.5">{b.canonical_domain}</div>
                  <div className="text-[10px] text-white/55 mt-1">{b.threat_count} threats</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/brands/${b.brand_id}`)}>
                    View
                  </Button>
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
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 3 — MEMBERS
// ═══════════════════════════════════════════════════════════════

function MembersTab({ members, invites, onInvite }: {
  members: { user_id: string; user_name: string; email: string; role: string; last_active_at: string | null }[];
  invites: { id: string; email: string; org_role: string; expires_at: string }[];
  onInvite: () => void;
}) {
  const removeMember = useRemoveMember();
  const updateRole = useUpdateMemberRole();
  const revokeInvite = useRevokeInvite();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <SectionLabel>Team Members</SectionLabel>
        <Button size="sm" onClick={onInvite}>Invite Member</Button>
      </div>

      {members.length === 0 ? (
        <EmptyState message="No members yet" action={{ label: 'Invite Member', onClick: onInvite }} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-white/55 font-mono uppercase tracking-wider border-b border-white/5">
                <th className="pb-2 pr-4">Name</th>
                <th className="pb-2 pr-4">Email</th>
                <th className="pb-2 pr-4">Role</th>
                <th className="pb-2 pr-4 hidden sm:table-cell">Last Active</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id} className="border-b border-white/[0.03]">
                  <td className="py-3 pr-4 font-medium text-white/90">{m.user_name}</td>
                  <td className="py-3 pr-4 text-white/55 font-mono">{m.email}</td>
                  <td className="py-3 pr-4">
                    <Select
                      value={m.role}
                      onChange={(e) => {
                        // Role changes are immediate and have no undo —
                        // confirm before a mis-click demotes an owner.
                        const next = e.target.value;
                        if (window.confirm(`Change ${m.user_name}'s role from ${m.role} to ${next}?`)) {
                          updateRole.mutate({ userId: m.user_id, role: next });
                        } else {
                          e.target.value = m.role;
                        }
                      }}
                      className="px-2 py-1 text-[11px]"
                      options={[
                        { value: 'owner',   label: 'Owner' },
                        { value: 'admin',   label: 'Admin' },
                        { value: 'analyst', label: 'Analyst' },
                        { value: 'viewer',  label: 'Viewer' },
                      ]}
                    />
                  </td>
                  <td className="py-3 pr-4 text-white/55 hidden sm:table-cell">
                    {m.last_active_at ? new Date(m.last_active_at).toLocaleDateString() : 'never'}
                  </td>
                  <td className="py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-accent/60"
                      onClick={() => {
                        if (window.confirm(`Remove ${m.user_name} (${m.email}) from the organization?`)) {
                          removeMember.mutate(m.user_id);
                        }
                      }}
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

      {/* Pending Invitations */}
      <div>
        <SectionLabel className="mb-2">Pending Invitations</SectionLabel>
        {invites.length === 0 ? (
          <p className="text-[11px] text-white/55">No pending invitations</p>
        ) : (
          <div className="space-y-2">
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between py-2 border-b border-white/[0.03]">
                <div>
                  <span className="text-[11px] opacity-80 font-mono">{inv.email}</span>
                  <span className="text-[10px] text-white/55 ml-2 capitalize">{inv.org_role}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-accent/60"
                  onClick={() => revokeInvite.mutate(inv.id)}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 4 — INTEGRATIONS
// ═══════════════════════════════════════════════════════════════

function IntegrationsTab({ integrations, onConnect }: {
  integrations: Integration[];
  onConnect: (def: IntegrationDef) => void;
}) {
  const deleteIntegration = useDeleteIntegration();

  const findConnected = (type: string) => integrations.find((i) => i.type === type);

  const renderSection = (label: string, defs: IntegrationDef[]) => (
    <div>
      <SectionLabel className="mb-3">{label}</SectionLabel>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {defs.map((def) => {
          const connected = findConnected(def.type);
          return (
            <IntegrationCard
              key={def.type}
              def={def}
              connected={!!connected}
              status={connected?.status}
              lastSync={connected?.last_sync_at}
              eventsSent={connected?.events_sent}
              lastError={connected?.last_error}
              onConnect={() => onConnect(def)}
              onConfigure={() => onConnect(def)}
              onDisconnect={() => connected && deleteIntegration.mutate(connected.id)}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-8">
      {renderSection('SIEM & Logging', SIEM_INTEGRATIONS)}
      {renderSection('Ticketing & Incident Management', TICKETING_INTEGRATIONS)}
      {renderSection('Inbound Feeds', INBOUND_INTEGRATIONS)}
      <IntegrationActivityPanel />
    </div>
  );
}

// Data-out proof: what got delivered to the org's SIEM and which compliance
// tickets were opened/closed. Hidden until there's activity to show.
function IntegrationActivityPanel() {
  const { data } = useOrgIntegrationActivity();
  const deliveries = data?.deliveries ?? [];
  const tickets = data?.tickets ?? [];
  if (deliveries.length === 0 && tickets.length === 0) return null;

  return (
    <div>
      <SectionLabel className="mb-3">Activity</SectionLabel>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="text-xs font-semibold text-white/70 mb-3">Recent deliveries</div>
          {deliveries.length === 0 ? (
            <div className="text-[11px] text-white/40">No events delivered yet.</div>
          ) : (
            <div className="space-y-2">
              {deliveries.slice(0, 12).map((d) => (
                <div key={d.id} className="flex items-center gap-2 text-[11px]">
                  <span style={{ color: d.status === 'delivered' ? 'var(--green)' : 'var(--red)' }}>●</span>
                  <span className="text-white/75">{d.integration_name}</span>
                  <span className="text-white/40 font-mono">{d.event_type}</span>
                  {d.error && <span className="text-white/40 truncate" title={d.error}>· {d.error}</span>}
                  <span className="ml-auto text-white/30 shrink-0">{relativeTime(d.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="text-xs font-semibold text-white/70 mb-3">Compliance tickets</div>
          {tickets.length === 0 ? (
            <div className="text-[11px] text-white/40">No tickets opened yet.</div>
          ) : (
            <div className="space-y-2">
              {tickets.slice(0, 12).map((t) => (
                <div key={t.id} className="flex items-center gap-2 text-[11px]">
                  <span style={{ color: t.status === 'closed' ? 'var(--text-tertiary)' : 'var(--green)' }}>●</span>
                  {t.external_url ? (
                    <a href={t.external_url} target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:underline font-mono">
                      {t.external_key}
                    </a>
                  ) : (
                    <span className="text-white/75 font-mono">{t.external_key}</span>
                  )}
                  <span className="text-white/40">{t.integration_name}</span>
                  <span className="ml-auto text-white/30 shrink-0 capitalize">{t.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 5 — API KEYS
// ═══════════════════════════════════════════════════════════════

function ApiKeysTab({ apiKeys, onCreate }: {
  apiKeys: { id: string; name: string; key_prefix: string; scopes: string; last_used_at: string | null; created_at: string }[];
  onCreate: () => void;
}) {
  const revokeKey = useRevokeApiKey();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <SectionLabel>API Keys</SectionLabel>
          <p className="text-[11px] text-white/55 mt-1">
            API keys allow programmatic access to your org's threat data.
          </p>
        </div>
        <Button size="sm" onClick={onCreate}>Create API Key</Button>
      </div>

      {apiKeys.length === 0 ? (
        <EmptyState
          message="No API keys"
          description="Create an API key to integrate with your systems."
          action={{ label: 'Create API Key', onClick: onCreate }}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-white/55 font-mono uppercase tracking-wider border-b border-white/5">
                <th className="pb-2 pr-4">Name</th>
                <th className="pb-2 pr-4">Prefix</th>
                <th className="pb-2 pr-4">Scopes</th>
                <th className="pb-2 pr-4">Last Used</th>
                <th className="pb-2 pr-4 hidden sm:table-cell">Created</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((k) => {
                let scopes: string[] = [];
                try { scopes = JSON.parse(k.scopes); } catch { /* empty */ }
                return (
                  <tr key={k.id} className="border-b border-white/[0.03]">
                    <td className="py-3 pr-4 font-medium text-white/90">{k.name}</td>
                    <td className="py-3 pr-4 font-mono text-white/55">{k.key_prefix}...</td>
                    <td className="py-3 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {scopes.map((s) => (
                          <span key={s} className="text-[9px] font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-white/40">
                            {s}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-white/55">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'never'}
                    </td>
                    <td className="py-3 pr-4 text-white/55 hidden sm:table-cell">
                      {new Date(k.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-accent/60"
                        onClick={() => revokeKey.mutate(k.id)}
                        disabled={revokeKey.isPending}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 7 — SETTINGS
// ═══════════════════════════════════════════════════════════════

function SettingsTab({ orgName, slug }: { orgName: string; slug: string }) {
  // Hardcoded fallbacks ('LRX Enterprises', 'cleerox@gmail.com', 'lrx-enterprises')
  // were demo-mode artifacts; removed so non-org-1 tenants don't see other
  // tenants' names. If a field is empty the input is just empty.
  const [name, setName] = useState(orgName ?? '');
  const updateOrg = useUpdateOrg();

  return (
    <div className="space-y-6">
      {/* Organization Details */}
      <Card hover={false}>
        <SectionLabel className="mb-4">Organization Details</SectionLabel>
        <div className="space-y-4">
          <div>
            <label className="block text-[11px] text-white/55 font-mono uppercase tracking-wide mb-1">
              Organization Name
            </label>
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1"
              />
              <Button
                variant="secondary"
                size="md"
                onClick={() => updateOrg.mutate({ name })}
                disabled={updateOrg.isPending || !name.trim()}
              >
                Save
              </Button>
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-white/55 font-mono uppercase tracking-wide mb-1">
              Billing Email
            </label>
            <p className="mt-1 text-[10px] font-mono text-white/40">
              Self-serve billing email arrives with v3 (Phase D / Stripe wiring). Until then, email{' '}
              <a href="mailto:billing@averrow.com" style={{ color: 'var(--amber)' }}>billing@averrow.com</a>.
            </p>
          </div>

          <div>
            <label className="block text-[11px] text-white/55 font-mono uppercase tracking-wide mb-1">
              Slug
            </label>
            <div className="text-sm text-white/40 font-mono">{slug || '—'} (read-only)</div>
          </div>
        </div>
      </Card>

      {/* SSO Configuration — now has its own tab */}
      <Card hover={false}>
        <SectionLabel className="mb-3">SSO Configuration</SectionLabel>
        <p className="text-[11px] text-white/40 mb-3">
          Configure Single Sign-On for your organization in the dedicated SSO tab.
        </p>
      </Card>

      {/* SCIM Provisioning */}
      <Card hover={false}>
        <SectionLabel className="mb-3">SCIM Provisioning</SectionLabel>
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-[11px]">
            <span className="text-white/55 font-mono">Status</span>
            <span className="text-white/55">Not configured</span>
          </div>
          <p className="mt-1 text-[10px] font-mono text-white/40">
            Auto-provisioning + de-provisioning via SCIM lands in v3 Phase 5.
          </p>
        </div>
      </Card>

      {/* Danger Zone */}
      <Card hover={false} className="border-accent/20">
        <SectionLabel className="mb-3 text-accent">Danger Zone</SectionLabel>
        <p className="mt-2 text-[10px] font-mono text-white/50">
          Self-serve deletion isn't wired yet. Email{' '}
          <a href="mailto:support@averrow.com" style={{ color: 'var(--amber)' }}>
            support@averrow.com
          </a>
          {' '}to delete your organization.
        </p>
      </Card>
    </div>
  );
}
