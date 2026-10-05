// @averrow/shared/account — SecuritySettings (ACCOUNT_DESIGN_SPEC §5.2)
//
// The Security page: status card, passkeys, active sessions, sign-out danger
// zone. Portable: it takes an API client + passkey adapter + callbacks and
// reads CSS variables only (no router, no app imports), so ops and tenant mount
// the same component. Must render inside the kit's <ToastProvider>.
//
// Honesty rules (the old SecuritySection broke them):
//   - a list that is loading or failed never renders as "0" / "No passkeys";
//   - every count/chip appears only once its data has really loaded;
//   - failures say what failed and offer a retry.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Badge, Button, Card, ConfirmDialog, DangerZone, IconTile, InlineBanner,
  Menu, MenuContent, MenuItem, MenuTrigger, PageState, SettingsGroup, SettingsRow, useToast,
} from '../ui';
import { KeyIcon, LaptopIcon, MoreIcon, PhoneIcon, PlusIcon, ShieldAlertIcon, ShieldCheckIcon, TrashIcon } from './security/icons';
import { normalizeSessions, signInMethodLabel, type NormalizedSessions } from './security/sessions';
import { formatAbsolute, formatRelativeTime, formatShortDate, isActiveNow, toValidDate } from './time-format';
import {
  DEFAULT_SECURITY_ENDPOINTS,
  type PasskeyDevice, type SecurityApiResponse, type SecurityEndpoints, type SecuritySession,
  type SecuritySettingsProps,
} from './security/types';
import { parseUserAgent } from './security/userAgent';

const VISIBLE_SESSIONS = 5;
const TOUCH_MIN = 'max-md:min-h-[44px]';

// ─── data loading ───────────────────────────────────────────

type Remote<T> =
  | { status: 'loading' }
  | { status: 'error' }
  /** `stale`: a background refresh failed; `data` is the last good copy. */
  | { status: 'ready'; data: T; stale: boolean };

function useRemote<T>(load: () => Promise<T>) {
  const [state, setState] = useState<Remote<T>>({ status: 'loading' });
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  /** `silent` keeps the current view while refreshing (after a mutation). */
  const reload = useCallback(async (silent = false) => {
    const id = ++seq.current;
    if (!silent) setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    try {
      const data = await loadRef.current();
      if (id === seq.current) setState({ status: 'ready', data, stale: false });
    } catch {
      if (id !== seq.current) return;
      setState((s) => (s.status === 'ready' ? { ...s, stale: true } : { status: 'error' }));
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => { seq.current += 1; };
  }, [reload]);

  return [state, reload] as const;
}

function unwrap<T>(res: SecurityApiResponse<T>, fallback: string): T | undefined {
  if (!res.success) throw new Error(res.error || fallback);
  return res.data;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ─── small presentational pieces ────────────────────────────

function RowSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {[0, 1].map((i) => (
        <div key={i} aria-hidden="true" className="flex min-h-[60px] items-center gap-3 px-4 py-3 md:min-h-[56px]">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-[9px] bg-[var(--border-base)] md:h-8 md:w-8" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/5 animate-pulse rounded bg-[var(--border-base)]" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-[var(--border-base)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function When({ iso, children }: { iso: string | null; children: (d: Date) => ReactNode }) {
  const d = toValidDate(iso);
  if (!d) return null;
  return <time dateTime={d.toISOString()} title={formatAbsolute(d)}>{children(d)}</time>;
}

function passkeyTitle(k: PasskeyDevice): string {
  if (k.device_label) return k.device_label;
  const ua = parseUserAgent(k.user_agent);
  return ua.device === 'unknown' && !ua.browser ? 'Unnamed passkey' : `Passkey · ${ua.label}`;
}

function passkeyDescription(k: PasskeyDevice): ReactNode {
  return (
    <>
      <When iso={k.created_at}>{(d) => <>Added {formatShortDate(d)}</>}</When>
      {' · '}
      {toValidDate(k.last_used_at)
        ? <When iso={k.last_used_at}>{(d) => <>Last used {formatRelativeTime(d)}</>}</When>
        : 'Not used yet'}
    </>
  );
}

function sessionDescription(s: SecuritySession): ReactNode {
  const last = toValidDate(s.lastActiveAt);
  if (!last) return 'Signed in';
  if (s.isCurrent || isActiveNow(last)) return <When iso={s.lastActiveAt}>{() => <>Active now</>}</When>;
  return <When iso={s.lastActiveAt}>{(d) => <>Last active {formatRelativeTime(d)}</>}</When>;
}

// ─── the page ───────────────────────────────────────────────

export function SecuritySettings({
  api, passkeys, onSignedOut, onPasskeysChanged, requiresPasskey = false,
  signInProvider = 'Google', endpoints, className,
}: SecuritySettingsProps) {
  const toast = useToast();
  const ep: SecurityEndpoints = useMemo(() => ({ ...DEFAULT_SECURITY_ENDPOINTS, ...endpoints }), [endpoints]);
  const supported = useMemo(() => {
    try { return passkeys.isSupported(); } catch { return false; }
  }, [passkeys]);

  const [keysState, reloadKeys] = useRemote<PasskeyDevice[]>(async () => {
    const list = await passkeys.list();
    if (!Array.isArray(list)) throw new Error('Unexpected passkeys response');
    return list;
  });
  const [sessState, reloadSessions] = useRemote<NormalizedSessions>(async () =>
    normalizeSessions(unwrap(await api.get<unknown>(ep.sessions), 'Could not load sessions')));

  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Dialog targets stay set while a dialog animates closed; `open` flags drive visibility.
  const [removeTarget, setRemoveTarget] = useState<PasskeyDevice | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const [everywhereOpen, setEverywhereOpen] = useState(false);

  const keys = keysState.status === 'ready' ? keysState.data : null;
  const sess = sessState.status === 'ready' ? sessState.data : null;
  const otherCount = sess ? sess.sessions.filter((s) => !s.isCurrent).length : 0;

  // ── actions ──
  const addPasskey = async () => {
    setAdding(true);
    try {
      await passkeys.register();
      toast.success('Passkey added.');
      void reloadKeys(true);
      onPasskeysChanged?.();
    } catch (err) {
      const cancelled = typeof DOMException !== 'undefined' && err instanceof DOMException
        && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      if (!cancelled) toast.error(messageOf(err, "Couldn't add the passkey. Try again."));
    } finally {
      setAdding(false);
    }
  };

  const confirmRemovePasskey = async () => {
    if (!removeTarget) return;
    await passkeys.remove(removeTarget.id); // a rejection keeps the dialog open with the message
    toast.success('Passkey removed.');
    void reloadKeys(true);
    onPasskeysChanged?.();
  };

  const signOutSession = async (s: SecuritySession) => {
    if (!ep.session) return;
    setRevokingId(s.id);
    setRowErrors(({ [s.id]: _drop, ...rest }) => rest);
    try {
      unwrap(await api.delete(ep.session(s.id)), "Couldn't sign that device out.");
      toast.success(`Signed out ${parseUserAgent(s.userAgent).label}.`);
      void reloadSessions(true);
    } catch (err) {
      const msg = messageOf(err, "Couldn't sign that device out. Try again.");
      setRowErrors((e) => ({ ...e, [s.id]: msg }));
      toast.error(msg);
    } finally {
      setRevokingId(null);
    }
  };

  const confirmSignOutOthers = async () => {
    if (!ep.revokeOthers) return;
    unwrap(await api.post(ep.revokeOthers), "Couldn't sign out your other devices. Try again.");
    toast.success('Signed out your other devices.');
    void reloadSessions(true);
  };

  const confirmSignOutEverywhere = async () => {
    unwrap(await api.post(ep.logoutEverywhere), "Couldn't sign you out everywhere. Try again.");
    toast.success('Signed out everywhere.');
    await onSignedOut();
  };

  // ── status card ──
  const hasPasskey = !!keys && keys.length > 0;
  const noPasskey = !!keys && keys.length === 0;
  const current = sess?.sessions.find((s) => s.isCurrent);
  const signInVia = signInMethodLabel(current?.authMethod ?? null) ?? signInProvider;

  const addDisabledReason = !supported ? "This browser doesn't support passkeys. Open Averrow in a browser that does, like Safari, Chrome or Edge." : null;
  const addButton = (variant: 'primary' | 'secondary') => (
    <Button
      type="button"
      variant={variant}
      size="sm"
      className={variant === 'secondary' ? 'ds-hbtn' : TOUCH_MIN}
      disabled={!supported || adding}
      aria-busy={adding || undefined}
      title={addDisabledReason ?? undefined}
      onClick={() => { void addPasskey(); }}
    >
      <PlusIcon />
      {adding ? 'Adding…' : 'Add passkey'}
    </Button>
  );

  const statusTitle = hasPasskey ? 'Your account is protected'
    : noPasskey ? 'Add a passkey to secure your account'
      : keysState.status === 'error' ? 'Account security'
        : 'Checking your account security…';
  const statusBody = hasPasskey
    ? 'You can sign in with a passkey, and you control which devices stay signed in.'
    : noPasskey ? 'Passkeys let you sign in with Face ID, Touch ID or a security key. There is nothing to type or remember.'
      : keysState.status === 'error' ? "We couldn't check your passkeys. Retry below."
        : 'One moment.';

  return (
    <div className={className}>
      {/* 1. Status */}
      <Card
        variant={hasPasskey ? 'active' : 'base'}
        accent={hasPasskey ? 'var(--green)' : undefined}
        padding="lg"
        className="mb-6 lg:mb-7"
        aria-busy={keysState.status === 'loading' || undefined}
      >
        <div className="flex items-start gap-4">
          <IconTile tone={hasPasskey ? 'green' : noPasskey ? 'amber' : 'neutral'} size={40}>
            {noPasskey ? <ShieldAlertIcon /> : <ShieldCheckIcon />}
          </IconTile>
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[18px] font-bold leading-[1.25] text-[var(--text-primary)]">{statusTitle}</h2>
            <p className="m-0 mt-1 text-[14px] leading-[1.5] text-[var(--text-secondary)]">{statusBody}</p>
            {(keys || sess) && (
              <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Security summary">
                {keys && (
                  <Badge size="md" font="sans" {...(keys.length > 0 ? { status: 'active' as const } : { status: 'warning' as const })} label={`${keys.length} ${keys.length === 1 ? 'passkey' : 'passkeys'}`} />
                )}
                {sess && (
                  <Badge size="md" font="sans" label={`${sess.sessions.length} active ${sess.sessions.length === 1 ? 'session' : 'sessions'}`} />
                )}
                <Badge size="md" font="sans" label={`Signed in with ${signInVia}`} />
              </div>
            )}
            {noPasskey && (
              <InlineBanner tone="warn" className="mt-4">
                Your account relies on {signInProvider} sign-in alone. A passkey adds a faster, phishing-resistant way in.
              </InlineBanner>
            )}
            {keysState.status === 'error' && (
              <div className="mt-3">
                <Button type="button" variant="secondary" size="sm" className={TOUCH_MIN} onClick={() => { void reloadKeys(); }}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* 2. Passkeys */}
      <SettingsGroup
        title="Passkeys"
        headerAction={addButton('secondary')}
        footer="Sign in with Face ID, Touch ID or a security key."
      >
        {!supported && (
          <div className="p-3">
            <InlineBanner tone="info">{addDisabledReason}</InlineBanner>
          </div>
        )}
        {keysState.status === 'loading' && <RowSkeleton label="Loading your passkeys…" />}
        {keysState.status === 'error' && (
          <PageState
            kind="error"
            layout="page"
            compact
            title="Couldn't load your passkeys"
            description="Check your connection and try again."
            onRetry={() => { void reloadKeys(); }}
          />
        )}
        {keysState.status === 'ready' && keysState.stale && (
          <div className="p-3">
            <InlineBanner tone="warn" action={<Button type="button" size="sm" variant="secondary" className={TOUCH_MIN} onClick={() => { void reloadKeys(); }}>Retry</Button>}>
              Couldn&apos;t refresh this list. It may be out of date.
            </InlineBanner>
          </div>
        )}
        {keys && keys.length === 0 && (
          <PageState
            kind="empty"
            layout="page"
            compact
            icon={<KeyIcon width={24} height={24} />}
            title="No passkeys yet"
            description="Sign in with Face ID, Touch ID or a security key."
            action={supported ? addButton('primary') : undefined}
          />
        )}
        {keys?.map((k) => (
          <SettingsRow
            key={k.id}
            icon={<KeyIcon />}
            tone="green"
            title={passkeyTitle(k)}
            description={passkeyDescription(k)}
            trailing={
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className="ds-iconbtn" aria-label={`Options for ${passkeyTitle(k)}`}>
                    <MoreIcon />
                  </button>
                </MenuTrigger>
                <MenuContent aria-label="Passkey options" width={200} onCloseAutoFocus={(e) => e.preventDefault()}>
                  <MenuItem
                    tone="danger"
                    icon={<TrashIcon />}
                    onSelect={() => { setRemoveTarget(k); setRemoveOpen(true); }}
                  >
                    Remove
                  </MenuItem>
                </MenuContent>
              </Menu>
            }
          />
        ))}
      </SettingsGroup>

      {/* 3. Active sessions */}
      <SettingsGroup title="Active sessions" footer="Devices where you're currently signed in.">
        {sessState.status === 'loading' && <RowSkeleton label="Loading your sessions…" />}
        {sessState.status === 'error' && (
          <PageState
            kind="error"
            layout="page"
            compact
            title="Couldn't load your sessions"
            description="Check your connection and try again."
            onRetry={() => { void reloadSessions(); }}
          />
        )}
        {sessState.status === 'ready' && sessState.stale && (
          <div className="p-3">
            <InlineBanner tone="warn" action={<Button type="button" size="sm" variant="secondary" className={TOUCH_MIN} onClick={() => { void reloadSessions(); }}>Retry</Button>}>
              Couldn&apos;t refresh this list. It may be out of date.
            </InlineBanner>
          </div>
        )}
        {sess && sess.sessions.length === 0 && (
          <PageState kind="empty" layout="page" compact title="No active sessions found" description="Sign in again if this looks wrong." />
        )}
        {sess && (showAll ? sess.sessions : sess.sessions.slice(0, VISIBLE_SESSIONS)).map((s) => {
          const ua = parseUserAgent(s.userAgent);
          const label = ua.label;
          return (
            <SettingsRow
              key={s.id}
              dense
              icon={ua.device === 'phone' || ua.device === 'tablet' ? <PhoneIcon /> : <LaptopIcon />}
              tone={s.isCurrent ? 'green' : 'neutral'}
              title={
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  {label}
                  {s.isCurrent && <Badge status="active" size="md" label="This device" font="sans" />}
                </span>
              }
              description={sessionDescription(s)}
              meta={s.ipMasked ?? undefined}
              error={rowErrors[s.id]}
              loading={revokingId === s.id}
              trailing={!s.isCurrent && ep.session ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={TOUCH_MIN}
                  disabled={revokingId !== null}
                  aria-label={`Sign out ${label}`}
                  onClick={() => { void signOutSession(s); }}
                >
                  Sign out
                </Button>
              ) : undefined}
            />
          );
        })}
        {sess && sess.sessions.length > VISIBLE_SESSIONS && (
          <SettingsRow
            variant="button"
            title={showAll ? 'Show fewer' : `Show ${sess.sessions.length - VISIBLE_SESSIONS} more`}
            onClick={() => setShowAll((v) => !v)}
          />
        )}
      </SettingsGroup>

      {/* 4. Sign-out actions: the calm, recommended one first; the red card is only for the irreversible one */}
      {ep.revokeOthers && (
        <SettingsGroup title="Sign out" footer="Signed in somewhere you don't recognize? End those sessions first.">
          <SettingsRow
            title="Other devices"
            description="Keeps you signed in here and ends every other session."
            disabled={sessState.status === 'loading' || (!!sess && (!sess.currentKnown || otherCount === 0))}
            disabledReason={
              sessState.status === 'loading' ? 'Checking your sessions…'
                : sess && !sess.currentKnown ? "We couldn't tell which session is this device. Sign in again to use this."
                  : 'No other devices are signed in.'
            }
            stackTrailing
            trailing={(
              <Button
                type="button"
                variant="outline"
                size="md"
                className="ds-fill min-h-[44px]"
                disabled={sessState.status === 'loading' || (!!sess && (!sess.currentKnown || otherCount === 0))}
                onClick={() => setOthersOpen(true)}
              >
                Sign out other devices
              </Button>
            )}
          />
        </SettingsGroup>
      )}
      <DangerZone
        title="Sign out & reset"
        actions={[{
          id: 'everywhere',
          tone: 'danger' as const,
          title: 'Every device',
          description: "Ends every session, including this one. You'll need to sign in again.",
          actionLabel: 'Sign out everywhere',
          onAction: () => setEverywhereOpen(true),
        }]}
        footer="Averrow never stores your Google password. Sign-in is handled by Google."
      />

      {/* Dialogs */}
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove this passkey?"
        description="You won't be able to use it to sign in. You can add it again anytime."
        consequence={removeTarget && keys && keys.length === 1
          ? requiresPasskey
            ? "This is your only passkey. Your role requires one, so you'll be asked to add a new passkey the next time you sign in."
            : `This is your only passkey. After removing it you'll sign in with ${signInProvider}.`
          : undefined}
        confirmLabel="Remove passkey"
        onConfirm={confirmRemovePasskey}
        icon={<KeyIcon />}
      />
      <ConfirmDialog
        open={othersOpen}
        onOpenChange={setOthersOpen}
        tone="primary"
        title="Sign out other devices?"
        description="This signs out every other device where you're signed in."
        consequence="You'll stay signed in here."
        confirmLabel="Sign out other devices"
        onConfirm={confirmSignOutOthers}
      />
      <ConfirmDialog
        open={everywhereOpen}
        onOpenChange={setEverywhereOpen}
        title="Sign out of all devices?"
        description="This ends all your sessions, including this one."
        consequence="You'll need to sign in again."
        confirmLabel="Sign out everywhere"
        onConfirm={confirmSignOutEverywhere}
      />
    </div>
  );
}
