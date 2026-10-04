// Monitoring Rules — per-brand watchlist + suppression + signal severity
// floor + notifications (TENANT_ANALYST_UX_RESEARCH_2026-06 #14). Backed by
// the existing monitoring-config endpoint; no new backend.

import { useEffect, useState, type KeyboardEvent } from 'react';
import { X, Plus } from 'lucide-react';
import { useTenantDashboard } from '@/lib/dashboard';
import { useCanTriage, useIsStaff } from '@/lib/alerts';
import { StaffTriageNote } from '@/features/alerts/AlertActions';
import {
  useMonitoringConfig, useUpdateMonitoringConfig, SEVERITY_LEVELS,
  type MonitoringConfig,
} from '@/lib/monitoring';

export function MonitoringRules() {
  const canEdit = useCanTriage();
  const dash = useTenantDashboard();
  const brands = dash.data?.brands ?? [];
  const [brandId, setBrandId] = useState<string | null>(null);

  useEffect(() => {
    if (!brandId && brands.length > 0) setBrandId(brands[0].id);
  }, [brands, brandId]);

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Account</div>
        <h1 className="text-[24px] font-bold text-[var(--text-primary)] tracking-tight">Monitoring Rules</h1>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Per-brand controls over what generates a signal — a watchlist of extra keywords, domains to suppress, the severity floor, and how you're notified.
        </p>
      </header>

      {dash.isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading…</div>}

      {!dash.isLoading && brands.length === 0 && (
        <section className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
          <p className="text-sm text-white/70">No brands assigned to your organization yet.</p>
        </section>
      )}

      {brands.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 flex-wrap">
            {brands.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setBrandId(b.id)}
                className={[
                  'px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors',
                  brandId === b.id
                    ? 'bg-amber/[0.10] text-amber border-amber/[0.30]'
                    : 'bg-white/[0.04] text-white/60 border-white/[0.08] hover:text-white/90',
                ].join(' ')}
              >
                {b.name}
              </button>
            ))}
          </div>
          {brandId && <BrandConfig key={brandId} brandId={brandId} canEdit={canEdit} />}
        </>
      )}
    </div>
  );
}

function BrandConfig({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const isStaff = useIsStaff();
  const { data, isLoading, error } = useMonitoringConfig(brandId);
  const update = useUpdateMonitoringConfig(brandId);
  const [cfg, setCfg] = useState<MonitoringConfig | null>(null);

  useEffect(() => { if (data) setCfg(data); }, [data]);

  if (isLoading || !cfg) {
    return <div className="text-white/40 text-sm font-mono py-8 text-center">Loading rules…</div>;
  }
  if (error) {
    return (
      <section className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-5">
        <p className="text-[12px] text-white/55">{error instanceof Error ? error.message : 'Failed to load rules'}</p>
      </section>
    );
  }

  const dirty = JSON.stringify(cfg) !== JSON.stringify(data);
  const set = <K extends keyof MonitoringConfig>(k: K, v: MonitoringConfig[K]) => setCfg((c) => c ? { ...c, [k]: v } : c);

  const toggleSeverity = (s: string) => {
    const has = cfg.alert_severity_filter.includes(s);
    set('alert_severity_filter', has
      ? cfg.alert_severity_filter.filter((x) => x !== s)
      : [...cfg.alert_severity_filter, s]);
  };

  return (
    <div className="space-y-4">
      <Card title="Signal severity floor" sub="Only these severities generate signals for this brand.">
        <div className="flex items-center gap-1.5 flex-wrap">
          {SEVERITY_LEVELS.map((s) => {
            const on = cfg.alert_severity_filter.includes(s);
            return (
              <button
                key={s}
                type="button"
                disabled={!canEdit}
                onClick={() => toggleSeverity(s)}
                className={[
                  'px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors disabled:opacity-60',
                  on ? 'bg-amber/[0.12] text-amber border-amber/[0.35]' : 'bg-white/[0.03] text-white/40 border-white/[0.07]',
                ].join(' ')}
              >
                {s}
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="Watchlist keywords" sub="Extra terms to watch for across this brand's surfaces.">
        <TagInput values={cfg.custom_keywords} onChange={(v) => set('custom_keywords', v)} canEdit={canEdit} placeholder="add a keyword…" />
      </Card>

      <Card title="Suppressed domains" sub="Signals from these domains are ignored (false-positive sources, your own infra).">
        <TagInput values={cfg.excluded_domains} onChange={(v) => set('excluded_domains', v)} canEdit={canEdit} placeholder="add a domain…" />
      </Card>

      <Card title="Auto-acknowledge" sub="Automatically acknowledge LOW signals after this many days (0 = off).">
        <input
          type="number"
          min={0}
          max={365}
          disabled={!canEdit}
          value={cfg.auto_acknowledge_low_days}
          onChange={(e) => set('auto_acknowledge_low_days', Math.max(0, Math.min(365, parseInt(e.target.value || '0', 10))))}
          className="w-24 bg-white/[0.04] border border-white/[0.10] rounded-md px-2.5 py-1.5 text-[13px] text-white/85 focus:outline-none focus:border-amber/[0.40] disabled:opacity-60"
        />
        <span className="ml-2 text-[12px] text-white/45">days</span>
      </Card>

      <Card title="Notifications" sub="How this brand's signals reach you by email.">
        <div className="space-y-3">
          <Toggle label="Email notifications" checked={cfg.email_notifications} disabled={!canEdit} onChange={(v) => set('email_notifications', v)} />
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-white/55 w-40">Email threshold</span>
            <select
              disabled={!canEdit || !cfg.email_notifications}
              value={cfg.email_notification_threshold}
              onChange={(e) => set('email_notification_threshold', e.target.value)}
              className="bg-white/[0.04] border border-white/[0.10] rounded-md px-2 py-1 text-[12px] text-white/85 focus:outline-none focus:border-amber/[0.40] disabled:opacity-50"
            >
              {SEVERITY_LEVELS.map((s) => <option key={s} value={s}>{s} and above</option>)}
            </select>
          </div>
          <Toggle label="Weekly digest" checked={cfg.weekly_digest} disabled={!canEdit} onChange={(v) => set('weekly_digest', v)} />
        </div>
      </Card>

      {canEdit ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!dirty || update.isPending}
            onClick={() => cfg && update.mutate(cfg)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber/[0.14] hover:bg-amber/[0.20] text-amber border border-amber/[0.40] rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-default"
          >
            {update.isPending ? 'Saving…' : 'Save rules'}
          </button>
          {!dirty && !update.isPending && update.isSuccess && <span className="text-[12px] text-green/80">Saved.</span>}
          {update.isError && <span className="text-[12px] text-sev-critical">{update.error instanceof Error ? update.error.message : 'Save failed'}</span>}
        </div>
      ) : (
        isStaff ? (
          <StaffTriageNote />
        ) : (
          <p role="note" className="text-[11px] text-white/55">Analyst role required to edit.</p>
        )
      )}
    </div>
  );
}

// ─── small parts ─────────────────────────────────────────────

function Card({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
      <h3 className="text-sm font-semibold text-white/90">{title}</h3>
      <p className="text-[12px] text-white/45 mt-0.5 mb-3">{sub}</p>
      {children}
    </section>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`inline-flex items-center gap-2 text-[12px] text-white/70 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-amber w-3.5 h-3.5" />
      {label}
    </label>
  );
}

function TagInput({ values, onChange, canEdit, placeholder }: {
  values: string[]; onChange: (v: string[]) => void; canEdit: boolean; placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim().toLowerCase();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  const remove = (v: string) => onChange(values.filter((x) => x !== v));
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {values.length === 0 && <span className="text-[12px] text-white/30">None.</span>}
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 text-[11px] font-mono text-white/75 bg-white/[0.05] border border-white/[0.10] rounded px-1.5 py-0.5">
            {v}
            {canEdit && (
              <button type="button" onClick={() => remove(v)} className="text-white/40 hover:text-sev-critical" aria-label={`Remove ${v}`}>
                <X size={10} />
              </button>
            )}
          </span>
        ))}
      </div>
      {canEdit && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={placeholder}
            className="flex-1 bg-white/[0.04] border border-white/[0.10] rounded-md px-2.5 py-1.5 text-[12px] text-white/85 placeholder:text-white/30 focus:outline-none focus:border-amber/[0.40]"
          />
          <button type="button" onClick={add} disabled={!draft.trim()} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-mono text-white/70 bg-white/[0.04] border border-white/[0.08] hover:text-white/95 disabled:opacity-40">
            <Plus size={11} /> Add
          </button>
        </div>
      )}
    </div>
  );
}
