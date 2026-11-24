import { useState, type ReactNode } from 'react';
import { Badge } from '@/design-system/components';
import { Button, ConfirmDialog, Dialog, Switch } from '@averrow/shared/ui';
import { useAuth } from '@/lib/auth';
import {
  useSetIntegrationAutoSubmit,
  type IntegrationHealth,
} from '@/hooks/useTakedownIntegrations';
import { STATUS_BADGE, timeAgo, successColor, MonthlyQuotaLine } from './integrationShared';

/** The server enforces these; the UI mirrors them. ON needs super_admin, OFF admin or super_admin. */
const TURN_OFF_ROLES = ['admin', 'super_admin'];
const TURN_ON_ROLES = ['super_admin'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 0', borderTop: '1px solid var(--border-base)' }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function KV({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '2px 12px', fontSize: 13, lineHeight: 1.5 }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{
        color: 'var(--text-primary)', textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere',
        ...(mono ? { fontFamily: 'var(--font-mono)', fontSize: 12 } : null),
      }}>
        {value}
      </span>
    </div>
  );
}

const dash = (v: string | null | undefined) => (v ? v : '—');

function SecretRow({ name, configured }: { name: string; configured: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 28 }}>
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{name}</code>
      <strong style={{ fontSize: 13, color: configured ? 'var(--sev-info-text)' : 'var(--sev-critical-text)' }}>
        {configured ? 'set' : 'missing'}
      </strong>
    </div>
  );
}

function AutoSubmitControl({ it }: { it: IntegrationHealth }) {
  const { user } = useAuth();
  const mutation = useSetIntegrationAutoSubmit();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cfg = it.config;
  const provider = cfg?.provider;
  if (!cfg || !provider || it.channel !== 'api') return null;

  if (!cfg.auto_submit_editable) {
    return (
      <Section title="Auto-submit">
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
          Auto-submit is not editable here: no provider row.
        </p>
      </Section>
    );
  }

  const role = user?.role ?? '';
  const isOn = provider.auto_submit_enabled;
  // OFF is open to admin + super_admin; ON is super_admin only (server enforces both).
  const canTurnOff = TURN_OFF_ROLES.includes(role);
  const canTurnOn = TURN_ON_ROLES.includes(role);
  const canToggle = isOn ? canTurnOff : canTurnOn;
  const note = canToggle
    ? null
    : role === 'admin' && !isOn
      ? 'Only a super admin can turn this on'
      : 'Only admins can change this';
  // Show the requested value while the PATCH is in flight; an error falls back to the server value.
  const checked = mutation.isPending && mutation.variables ? mutation.variables.enabled : isOn;
  const labelId = `autosubmit-label-${it.kind}`;
  const busy = mutation.isPending;

  const apply = (enabled: boolean) => mutation.mutateAsync({ kind: it.kind, enabled });

  const onToggle = (next: boolean) => {
    setError(null);
    if (next) {
      setConfirmOpen(true);
      return;
    }
    apply(false).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not update auto-submit'));
  };

  const rowDisabled = !canToggle || busy;

  return (
    <Section title="Auto-submit">
      {/* The whole row is the tap target: tapping the text toggles the switch. */}
      <div
        onClick={(e) => {
          if (rowDisabled || (e.target as HTMLElement).closest('button')) return;
          onToggle(!checked);
        }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 48,
          cursor: rowDisabled ? 'default' : 'pointer',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div id={labelId} style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Auto-submit takedowns</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Controls all automated submission to {provider.provider_name}: its API, and its abuse email if the API is unavailable.
          </div>
        </div>
        <Switch
          checked={checked}
          disabled={rowDisabled}
          onCheckedChange={onToggle}
          aria-labelledby={labelId}
        />
      </div>
      {note && (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-tertiary)' }}>{note}</p>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--sev-critical-text)', overflowWrap: 'anywhere' }}>{error}</p>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        dismissOnBack
        tone="primary"
        title={`Turn on auto-submit for ${it.label}?`}
        description={
          cfg.send_mode === 'live'
            ? `Send mode is live, so eligible takedowns will start being submitted to ${provider.provider_name}, by API and by abuse email if the API is unavailable.`
            : `Send mode is draft, so nothing is sent yet. Once send mode goes live, eligible takedowns will be submitted to ${provider.provider_name}.`
        }
        consequence="You can turn it off at any time."
        confirmLabel="Turn on auto-submit"
        onConfirm={async () => { await apply(true); }}
      />
    </Section>
  );
}

export function IntegrationConfigPanel({
  integration: it, windowHours, onClose,
}: { integration: IntegrationHealth | null; windowHours: number; onClose: () => void }) {
  // Remember the last item so the exit animation has content and a refetch that
  // briefly drops it doesn't make the sheet vanish.
  const [last, setLast] = useState<IntegrationHealth | null>(null);
  if (it && it !== last) setLast(it);
  const shown = it ?? last;
  if (!shown) return null;
  return <PanelBody it={shown} open={!!it} windowHours={windowHours} onClose={onClose} />;
}

function PanelBody({ it, open, windowHours, onClose }: { it: IntegrationHealth; open: boolean; windowHours: number; onClose: () => void }) {
  const badge = STATUS_BADGE[it.status];
  const cfg = it.config;
  const provider = cfg?.provider ?? null;
  const live = cfg?.send_mode === 'live';
  const capVar = cfg?.optional_vars.find((v) => /CAP/.test(v)) ?? cfg?.optional_vars[0] ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => { if (!open) onClose(); }}
      width={560}
      dismissOnBack
      title={it.label}
      description={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{it.kind}</span>}
      footer={<Button type="button" variant="secondary" className="min-h-[44px]" onClick={onClose}>Close</Button>}
    >
      <div data-testid="integration-config" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ paddingBottom: 12 }}>
          <Badge status={badge.status} pulse={badge.pulse}>{badge.label}</Badge>
        </div>

        <Section title="How it sends">
          <KV label="Channel" value={it.channel === 'api' ? 'API' : 'Email'} />
          {cfg && (
            <>
              <KV label="Needs live send mode" value={cfg.requires_live_mode ? 'Yes' : 'No'} />
              <KV label="Global send mode" value={<strong style={{ color: live ? 'var(--sev-info-text)' : 'var(--sev-medium-text)' }}>{live ? 'Live' : 'Draft'}</strong>} />
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                {live
                  ? 'Live: submissions leave the platform and reach the provider or abuse desk.'
                  : 'Draft: nothing leaves the platform. Reports are prepared and held until send mode is live.'}
              </p>
            </>
          )}
        </Section>

        <Section title="Credentials">
          {cfg && cfg.credential_status && cfg.credential_status.length > 0 ? (
            cfg.credential_status.map((c) => <SecretRow key={c.name} name={c.name} configured={c.set} />)
          ) : (
            <>
              <KV label="Credential" value={<strong style={{ color: it.configured ? 'var(--sev-info-text)' : 'var(--sev-critical-text)' }}>{it.configured ? 'set' : 'missing'}</strong>} />
              {cfg && cfg.credential_secrets.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Required</span>
                  {cfg.credential_secrets.map((n) => (
                    <code key={n} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{n}</code>
                  ))}
                </div>
              )}
            </>
          )}
          {cfg && cfg.optional_vars.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Optional</span>
              {cfg.optional_vars.map((n) => (
                <code key={n} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{n}</code>
              ))}
            </div>
          )}
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
            Values are never shown. Set in Cloudflare → Workers → averrow → Settings → Variables and Secrets.
          </p>
        </Section>

        {it.channel === 'api' && (
          <Section title="Provider">
            <KV label="Provider" value={dash(provider?.provider_name ?? it.provider_name)} />
            <KV label="Type" value={dash(provider?.provider_type)} />
            <KV label="Abuse email" value={dash(provider?.abuse_email)} mono />
            <KV label="Abuse URL" value={dash(provider?.abuse_url)} mono />
            <KV label="API URL" value={dash(provider?.abuse_api_url)} mono />
            <KV label="API type" value={dash(provider?.abuse_api_type ?? it.api_type)} mono />
          </Section>
        )}

        <AutoSubmitControl it={it} />

        {it.monthly_quota && (
          <Section title="Monthly quota">
            <MonthlyQuotaLine quota={it.monthly_quota} />
            <KV label="Cap" value={it.monthly_quota.cap} mono />
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
              {capVar
                ? <>Override with <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{capVar}</code>.</>
                : 'The cap is set in the worker configuration.'}
            </p>
          </Section>
        )}

        <Section title={`Activity · ${windowHours}h`}>
          <KV label="Submitted" value={it.submitted} />
          <KV label="Failed" value={it.failed} />
          <KV label="Rejected" value={it.rejected} />
          <KV label="Queued" value={it.queued} />
          <KV label="Total" value={it.total} />
          <KV label="Success rate" value={<strong style={{ color: successColor(it.success_rate) }}>{it.success_rate === null ? '—' : `${it.success_rate}%`}</strong>} />
          <KV label="Last submission" value={timeAgo(it.last_submission_at)} />
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <div style={{ color: 'var(--text-secondary)' }}>Last error</div>
            <div style={{ color: it.last_error ? 'var(--sev-high-text)' : 'var(--text-tertiary)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              {it.last_error ?? 'None'}
            </div>
          </div>
        </Section>
      </div>
    </Dialog>
  );
}
