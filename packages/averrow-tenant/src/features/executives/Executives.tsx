// Executive Identity Registry — tenant surface.
//
// EXEC_IMPERSONATION_2026-07 Stage 5. Lets the customer register, view,
// edit, and remove the named executives they want monitored for social
// impersonation, per brand. Feeds two upstream pieces already live:
//   - the deterministic detector (Stage 2) — watches `watch_platforms`
//     for handles that aren't in `official_handles` (the allowlist)
//   - the executive_monitor agent (Stage 4) — creates org-scoped
//     `executive_impersonation` alerts, which already surface in the
//     Alerts feed (features/alerts/Alerts.tsx), filterable by brand +
//     alert_type.
//
// Placement: its own settings-adjacent surface (Account section of the
// sidebar), not folded into Social.tsx. Social/BrandSocialFindings show
// FINDINGS (what the monitor detected); this page manages the REGISTRY
// that feeds detection — same relationship as Monitoring Rules (config)
// vs. Alerts (findings). Mutations are org-admin-only server side
// (requireOrgAdmin), mirrored here via canManageMembers (identical role
// gate: super_admin, or org role admin/owner).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserCog, Plus, Pencil, Trash2, AlertTriangle, ExternalLink } from 'lucide-react';
import { parseInitials } from '@averrow/shared/avatar';
import { useAuth } from '@/lib/auth';
import { canManageMembers } from '@/lib/members';
import { useTenantDashboard, type DashboardBrand } from '@/lib/dashboard';
import { useTenantAlerts } from '@/lib/alerts';
import {
  useOrgExecutives,
  useCreateExecutive,
  useUpdateExecutive,
  useDeleteExecutive,
  validateExecutiveName,
  validateWatchPlatforms,
  SUPPORTED_EXEC_PLATFORMS,
  EXEC_PLATFORM_LABELS,
  type Executive,
  type ExecutiveInput,
  type ExecPlatform,
} from '@/lib/executives';

const EXEC_ALERT_TYPE = 'executive_impersonation';

export function Executives() {
  const { user } = useAuth();
  const canManage = canManageMembers(user?.role, user?.organization?.role);
  const dash = useTenantDashboard();
  const brands = dash.data?.brands ?? [];

  const [brandFilter, setBrandFilter] = useState<string>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const scopedBrandId = brandFilter === 'all' ? undefined : brandFilter;
  const { data: executives, isLoading, error } = useOrgExecutives(scopedBrandId);

  // Impersonation-alert counts, keyed by executive_id. Only fetched when a
  // single brand is in view — the alerts API has no executive_id filter,
  // only brand_id + alert_type, so counting per-exec across ALL brands
  // would mean one query per brand. `enabled: !!scopedBrandId` means this
  // genuinely doesn't fire a request on the "All brands" tab (not just
  // fetch-and-discard) — same shape as MonitoringRules' per-brand tab
  // pattern.
  const alertsQuery = useTenantAlerts({
    brandId: scopedBrandId,
    alertType: EXEC_ALERT_TYPE,
    status: 'all',
    limit: 100,
    enabled: !!scopedBrandId,
  });
  const alertCounts = useMemo(
    () => (scopedBrandId ? countAlertsByExecutive(alertsQuery.data?.alerts ?? []) : {}),
    [scopedBrandId, alertsQuery.data],
  );
  // The fetch above is capped at limit:100. If the brand actually has more
  // executive_impersonation alerts than that (server-reported `total` >
  // rows returned), the per-exec counts below can undercount — flag them
  // as approximate rather than presenting a capped count as exact.
  const alertCountsApprox = !!(
    alertsQuery.data && alertsQuery.data.total > alertsQuery.data.alerts.length
  );

  const brandById = useMemo(
    () => new Map(brands.map((b) => [b.id, b] as const)),
    [brands],
  );

  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <UserCog size={18} className="text-amber" />
            <h1 className="text-[24px] font-bold text-white/90 tracking-tight">Executives</h1>
          </div>
          <p className="mt-1 text-sm text-white/55 max-w-2xl">
            Register the named executives you want monitored for social impersonation. Averrow
            watches the platforms you pick for fake accounts and skips handles you list as
            official.
          </p>
        </div>
        {canManage && brands.length > 0 && (
          <button
            type="button"
            onClick={() => { setShowCreate((v) => !v); setEditingId(null); }}
            aria-expanded={showCreate}
            aria-controls="create-executive-form"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber text-[#0a0a0a] rounded-lg font-semibold text-sm hover:bg-amber-dim transition-colors whitespace-nowrap"
          >
            <Plus size={14} /> {showCreate ? 'Cancel' : 'Register executive'}
          </button>
        )}
      </header>

      {!canManage && (
        <section className="rounded-xl border border-amber/[0.20] bg-amber/[0.04] p-4 flex items-start gap-3">
          <AlertTriangle className="text-amber flex-shrink-0 mt-0.5" size={16} />
          <p className="text-[12px] text-white/65 leading-relaxed">
            Org admins and owners can register, edit, and remove executives. You can view the
            registry read-only.
          </p>
        </section>
      )}

      {dash.isLoading && <div className="text-white/40 text-sm font-mono py-8 text-center">Loading…</div>}

      {!dash.isLoading && brands.length === 0 && (
        <section className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
          <p className="text-white/55 text-sm">No brands assigned to your organization yet.</p>
          <p className="text-white/35 text-xs mt-1">
            Contact <a className="text-amber hover:underline" href="mailto:support@averrow.com">support@averrow.com</a> to add a brand.
          </p>
        </section>
      )}

      {brands.length > 0 && showCreate && canManage && (
        <ExecutiveForm
          mode="create"
          brands={brands}
          defaultBrandId={scopedBrandId ?? brands[0]?.id}
          onCancel={() => setShowCreate(false)}
          onSaved={() => setShowCreate(false)}
        />
      )}

      {brands.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setBrandFilter('all')}
              className={[
                'px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors',
                brandFilter === 'all'
                  ? 'bg-amber/[0.10] text-amber border-amber/[0.30]'
                  : 'bg-white/[0.04] text-white/60 border-white/[0.08] hover:text-white/90',
              ].join(' ')}
            >
              All brands
            </button>
            {brands.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setBrandFilter(b.id)}
                className={[
                  'px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors',
                  brandFilter === b.id
                    ? 'bg-amber/[0.10] text-amber border-amber/[0.30]'
                    : 'bg-white/[0.04] text-white/60 border-white/[0.08] hover:text-white/90',
                ].join(' ')}
              >
                {b.name}
              </button>
            ))}
          </div>

          <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white/90">Registered executives</h2>
              <span className="text-[11px] font-mono text-white/45 tabular-nums">
                {executives?.length ?? 0}
              </span>
            </div>

            {isLoading && <p className="text-[12px] text-white/40 font-mono py-6 text-center">Loading…</p>}
            {error && (
              <p className="text-[12px] text-sev-critical py-2">
                {error instanceof Error ? error.message : 'Failed to load executives'}
              </p>
            )}
            {!isLoading && !error && (!executives || executives.length === 0) && (
              <EmptyExecutives />
            )}
            {!isLoading && executives && executives.length > 0 && (
              <div className="space-y-1">
                {executives.map((exec) =>
                  editingId === exec.id ? (
                    <ExecutiveForm
                      key={exec.id}
                      mode="edit"
                      brands={brands}
                      initial={exec}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => setEditingId(null)}
                    />
                  ) : (
                    <ExecutiveRow
                      key={exec.id}
                      executive={exec}
                      brand={brandById.get(exec.brand_id)}
                      showBrand={brandFilter === 'all'}
                      canManage={canManage}
                      alertCount={scopedBrandId ? alertCounts[exec.id] ?? 0 : null}
                      alertCountApprox={alertCountsApprox}
                      onEdit={() => { setEditingId(exec.id); setShowCreate(false); }}
                    />
                  ),
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function EmptyExecutives() {
  return (
    <div className="py-8 text-center">
      <p className="text-white/55 text-sm">No executives registered — add one to start monitoring for impersonation.</p>
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────

function ExecutiveRow({
  executive, brand, showBrand, canManage, alertCount, alertCountApprox, onEdit,
}: {
  executive:        Executive;
  brand:            DashboardBrand | undefined;
  showBrand:        boolean;
  canManage:        boolean;
  alertCount:       number | null;
  /** True when the underlying alert fetch was capped (limit:100) below the
   *  brand's true total, so `alertCount` may be an undercount. */
  alertCountApprox: boolean;
  onEdit:           () => void;
}) {
  const remove = useDeleteExecutive();
  const initials = parseInitials(executive.full_name, null);
  const isPaused = executive.status === 'paused';

  const handleDelete = () => {
    const ok = window.confirm(
      `Remove ${executive.full_name} from the executive registry? Averrow will stop monitoring for impersonation of them.`,
    );
    if (!ok) return;
    remove.mutate(executive.id);
  };

  return (
    <div className="py-3 px-2 -mx-2 rounded-lg hover:bg-white/[0.02] transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-xs font-semibold text-white/70 bg-white/[0.06] border border-white/10">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-white/90 font-medium truncate">{executive.full_name}</span>
            {executive.title && (
              <span className="text-[11px] text-white/45 truncate">{executive.title}</span>
            )}
            {isPaused && (
              <span className="text-[10px] font-mono uppercase tracking-wider text-white/45 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
                Paused
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-1">
            {showBrand && (
              <span className="text-[11px] font-mono text-amber/80 bg-amber/[0.06] border border-amber/[0.20] rounded px-1.5 py-0.5">
                {brand?.name ?? executive.brand_id}
              </span>
            )}
            <div className="flex items-center gap-1 flex-wrap">
              {executive.watch_platforms.map((p) => (
                <span
                  key={p}
                  className="text-[10px] font-mono text-white/55 bg-white/[0.03] border border-white/[0.07] rounded px-1.5 py-0.5"
                >
                  {EXEC_PLATFORM_LABELS[p as ExecPlatform] ?? p}
                </span>
              ))}
            </div>
          </div>
          {alertCount !== null && (
            <Link
              to={`/alerts?brand=${executive.brand_id}&type=${EXEC_ALERT_TYPE}`}
              className="inline-flex items-center gap-1 text-[11px] font-mono text-white/45 hover:text-amber mt-1.5 transition-colors"
              title={
                alertCountApprox
                  ? "Opens this brand's executive-impersonation alerts. Count is approximate — this brand has more than 100 such alerts, so per-executive counts may undercount (not exec-specific either — the alerts API has no per-executive filter)"
                  : "Opens this brand's executive-impersonation alerts (not exec-specific — the alerts API has no per-executive filter)"
              }
            >
              <ExternalLink size={10} />
              {alertCount > 0
                ? `${alertCountApprox ? '~' : ''}${alertCount}${alertCountApprox ? '+' : ''} impersonation alert${alertCount === 1 && !alertCountApprox ? '' : 's'}`
                : 'No impersonation alerts yet'}
            </Link>
          )}
        </div>
        {canManage && (
          <div className="flex-shrink-0 flex items-center gap-1">
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center justify-center w-7 h-7 rounded text-white/45 hover:text-amber hover:bg-amber/[0.10] transition-colors"
              title="Edit executive"
              aria-label="Edit executive"
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={remove.isPending}
              className="inline-flex items-center justify-center w-7 h-7 rounded text-white/45 hover:text-sev-critical hover:bg-sev-critical/[0.10] disabled:opacity-55 disabled:cursor-not-allowed transition-colors"
              title="Remove executive"
              aria-label="Remove executive"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>
      {remove.isError && (
        <p className="text-[11px] text-sev-critical mt-2 pl-11">
          {remove.error instanceof Error ? remove.error.message : 'Remove failed'}
        </p>
      )}
    </div>
  );
}

// ─── Create / edit form ────────────────────────────────────────

function ExecutiveForm({
  mode, brands, initial, defaultBrandId, onCancel, onSaved,
}: {
  mode:           'create' | 'edit';
  brands:         DashboardBrand[];
  initial?:       Executive;
  defaultBrandId?: string;
  onCancel:       () => void;
  onSaved:        () => void;
}) {
  const create = useCreateExecutive();
  const update = useUpdateExecutive();
  const pending = create.isPending || update.isPending;
  const submitError = create.error ?? update.error;

  const [brandId, setBrandId] = useState(initial?.brand_id ?? defaultBrandId ?? brands[0]?.id ?? '');
  const [fullName, setFullName] = useState(initial?.full_name ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [status, setStatus] = useState<'active' | 'paused'>((initial?.status as 'active' | 'paused') ?? 'active');
  const [watchPlatforms, setWatchPlatforms] = useState<string[]>(
    initial?.watch_platforms ?? [...SUPPORTED_EXEC_PLATFORMS],
  );
  const [handles, setHandles] = useState<Record<string, string>>(initial?.official_handles ?? {});
  const [nameError, setNameError] = useState<string | null>(null);
  const [platformsError, setPlatformsError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setBrandId(initial.brand_id);
      setFullName(initial.full_name);
      setTitle(initial.title ?? '');
      setStatus((initial.status as 'active' | 'paused') ?? 'active');
      setWatchPlatforms(initial.watch_platforms);
      setHandles(initial.official_handles);
    }
  }, [initial]);

  const togglePlatform = (p: string) => {
    setWatchPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  };

  const setHandle = (platform: string, value: string) => {
    setHandles((prev) => {
      const next = { ...prev };
      if (value.trim()) next[platform] = value.trim();
      else delete next[platform];
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nameErr = validateExecutiveName(fullName);
    const platformsErr = validateWatchPlatforms(watchPlatforms);
    setNameError(nameErr);
    setPlatformsError(platformsErr);
    if (nameErr || platformsErr || !brandId) return;

    const input: ExecutiveInput = {
      brand_id: brandId,
      full_name: fullName.trim(),
      title: title.trim() || null,
      official_handles: handles,
      watch_platforms: watchPlatforms,
      status,
    };

    if (mode === 'create') {
      create.mutate(input, { onSuccess: onSaved });
    } else if (initial) {
      update.mutate({ execId: initial.id, input }, { onSuccess: onSaved });
    }
  };

  return (
    <form
      id={mode === 'create' ? 'create-executive-form' : undefined}
      onSubmit={handleSubmit}
      className="rounded-xl border border-amber/[0.20] bg-amber/[0.03] p-5 space-y-4"
    >
      <h2 className="text-sm font-semibold text-white/90">
        {mode === 'create' ? 'Register a new executive' : `Edit ${initial?.full_name ?? ''}`}
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="exec-brand" className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-1.5">
            Brand
          </label>
          <select
            id="exec-brand"
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="w-full rounded-lg border border-white/[0.08] bg-bg-page px-3 py-2 text-sm text-white/90 focus:border-amber focus:outline-none"
          >
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="exec-status" className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-1.5">
            Status
          </label>
          <select
            id="exec-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'active' | 'paused')}
            className="w-full rounded-lg border border-white/[0.08] bg-bg-page px-3 py-2 text-sm text-white/90 focus:border-amber focus:outline-none"
          >
            <option value="active">Active — monitored</option>
            <option value="paused">Paused — kept, not scanned</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="exec-name" className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-1.5">
            Full name
          </label>
          <input
            id="exec-name"
            type="text"
            value={fullName}
            onChange={(e) => { setFullName(e.target.value); if (nameError) setNameError(null); }}
            placeholder="Jane Doe"
            className="w-full rounded-lg border border-white/[0.08] bg-bg-page px-3 py-2 text-sm text-white/90 placeholder-white/30 focus:border-amber focus:outline-none"
          />
          {nameError && <p className="text-[11px] text-sev-critical mt-1">{nameError}</p>}
        </div>
        <div>
          <label htmlFor="exec-title" className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-1.5">
            Title <span className="text-white/30 normal-case">(optional)</span>
          </label>
          <input
            id="exec-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Chief Executive Officer"
            className="w-full rounded-lg border border-white/[0.08] bg-bg-page px-3 py-2 text-sm text-white/90 placeholder-white/30 focus:border-amber focus:outline-none"
          />
        </div>
      </div>

      <fieldset className="border-0 p-0 m-0">
        <legend className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-2">
          Watch platforms <span className="text-white/30 normal-case">— where to look for impersonation</span>
        </legend>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {SUPPORTED_EXEC_PLATFORMS.map((p) => {
            const on = watchPlatforms.includes(p);
            return (
              <label
                key={p}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                  on ? 'border-amber/[0.40] bg-amber/[0.06]' : 'border-white/[0.08] bg-bg-page hover:border-white/15'
                }`}
              >
                <input type="checkbox" checked={on} onChange={() => togglePlatform(p)} className="accent-amber" />
                <span className="text-[12px] text-white/85">{EXEC_PLATFORM_LABELS[p]}</span>
              </label>
            );
          })}
        </div>
        {platformsError && <p className="text-[11px] text-sev-critical mt-1.5">{platformsError}</p>}
      </fieldset>

      <fieldset className="border-0 p-0 m-0">
        <legend className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-2">
          Official handles <span className="text-white/30 normal-case">— the real accounts, so the detector allowlists them</span>
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {SUPPORTED_EXEC_PLATFORMS.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-white/45 w-20 flex-shrink-0">{EXEC_PLATFORM_LABELS[p]}</span>
              <input
                type="text"
                value={handles[p] ?? ''}
                onChange={(e) => setHandle(p, e.target.value)}
                placeholder="@handle"
                aria-label={`${EXEC_PLATFORM_LABELS[p]} official handle`}
                className="flex-1 min-w-0 rounded-md border border-white/[0.08] bg-bg-page px-2.5 py-1.5 text-[12px] text-white/90 placeholder-white/25 focus:border-amber focus:outline-none"
              />
            </div>
          ))}
        </div>
      </fieldset>

      {submitError && (
        <p className="text-[12px] text-sev-critical">
          {submitError instanceof Error ? submitError.message : 'Save failed'}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || !brandId}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber text-[#0a0a0a] rounded-lg font-semibold text-sm hover:bg-amber-dim disabled:opacity-55 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? 'Saving…' : mode === 'create' ? 'Register executive' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-white/55 hover:text-white/85 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Alert-count helper ────────────────────────────────────────

/** Counts executive_impersonation alerts per executive_id from an
 *  already-fetched, brand-scoped, type-filtered alert list. Client-side
 *  because the alerts API has no executive_id filter — see module
 *  header note. */
export function countAlertsByExecutive(alerts: Array<{ details: string | null }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of alerts) {
    if (!a.details) continue;
    try {
      const parsed = JSON.parse(a.details) as { executive_id?: unknown };
      const execId = parsed.executive_id;
      if (typeof execId === 'string' && execId) {
        counts[execId] = (counts[execId] ?? 0) + 1;
      }
    } catch {
      // Malformed details — skip, don't let one bad row break the count.
    }
  }
  return counts;
}
