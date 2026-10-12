import { useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Download } from 'lucide-react';
import { CopyField, Dialog } from '@averrow/shared/ui';
import { Badge, Button } from '@/design-system/components';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { formatDateTime, relativeTime } from '@/lib/time';
import { CaptureError, useCaptureNow } from './useIdentityThreats';
import { downloadAuthedFile, useAuthedBlobUrl } from './useCaptureBlob';
import type { IdentityDetectionDetail, PageCapture, PageCaptureStatus } from './types';

const LABEL_CLS = 'font-mono text-[11px] font-bold uppercase tracking-[0.18em]';
const MUTED = { color: 'var(--text-secondary)' } as const;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase(); } catch { return null; }
}

/** Form-action hosts that differ from the page's own host (case-insensitive). */
export function offDomainHosts(pageHost: string | null, hosts: string[]): string[] {
  if (!pageHost) return [];
  return hosts.filter((h) => h.toLowerCase() !== pageHost);
}

export function captureBadge(status: PageCaptureStatus): ReactNode {
  switch (status) {
    case 'queued': return <Badge status="pending">Queued</Badge>;
    case 'capturing': return <Badge status="running" pulse>Capturing</Badge>;
    case 'captured': return <Badge status="success">Captured</Badge>;
    case 'blocked': return <Badge status="warning">Blocked</Badge>;
    case 'failed': return <Badge status="failed">Failed</Badge>;
    case 'expired': return <Badge status="inactive">Expired</Badge>;
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0 py-1 text-[13px] sm:grid-cols-[140px_1fr] sm:gap-2">
      <dt style={MUTED}>{label}</dt>
      <dd className="m-0 min-w-0 font-mono" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{children}</dd>
    </div>
  );
}

function When({ iso }: { iso: string | null }) {
  if (!iso) return <>—</>;
  return <span title={formatDateTime(iso)}>{relativeTime(iso)}</span>;
}

// ── Viewer ─────────────────────────────────────────────────────────────────

function Viewer({ capture, open, onOpenChange }: { capture: PageCapture; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [variant, setVariant] = useState<'mobile' | 'desktop'>(capture.screenshot_mobile_url ? 'mobile' : 'desktop');
  const path = variant === 'mobile' ? capture.screenshot_mobile_url : capture.screenshot_desktop_url;
  const img = useAuthedBlobUrl(path, open);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Page capture"
      description={capture.final_url ?? undefined}
      width="min(960px, calc(100vw - 32px))"
      presentation="dialog"
    >
      <div role="group" aria-label="Screenshot size" className="mb-3 flex gap-2">
        {(['mobile', 'desktop'] as const).map((v) => {
          const has = v === 'mobile' ? capture.screenshot_mobile_url : capture.screenshot_desktop_url;
          return (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={variant === v ? 'primary' : 'secondary'}
              aria-pressed={variant === v}
              disabled={!has}
              onClick={() => setVariant(v)}
            >
              {v === 'mobile' ? 'Mobile' : 'Desktop'}
            </Button>
          );
        })}
      </div>
      <div className="flex justify-center overflow-auto" style={{ maxHeight: '70dvh' }}>
        {img.url ? (
          <img src={img.url} alt={`${variant} screenshot of ${capture.final_url ?? 'captured page'}`} style={{ maxWidth: '100%', height: 'auto' }} />
        ) : (
          <p className="m-0 text-[13px]" role="status" style={MUTED}>
            {img.error ? "Couldn't load the screenshot." : img.loading ? 'Loading screenshot…' : 'No screenshot for this size.'}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ── Body of a finished capture ─────────────────────────────────────────────

function CaptureDetails({ capture, pageHost }: { capture: PageCapture; pageHost: string | null }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [dlError, setDlError] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const thumbPath = capture.screenshot_mobile_url ?? capture.screenshot_desktop_url;
  const thumb = useAuthedBlobUrl(thumbPath);
  const off = offDomainHosts(pageHost, capture.form_action_hosts);
  const chain = capture.redirect_chain;
  const chainCollapsible = chain.length > 2;
  const sha = capture.sha256.html ?? capture.sha256.mobile ?? capture.sha256.desktop;
  const shaLabel = capture.sha256.html ? 'HTML SHA-256' : 'SHA-256';

  const onDownload = async () => {
    if (!capture.html_download_url) return;
    setDlBusy(true);
    setDlError(false);
    try { await downloadAuthedFile(capture.html_download_url, `capture-${capture.id}.html.txt`); } catch { setDlError(true); } finally { setDlBusy(false); }
  };

  return (
    <div>
      {thumbPath && (
        <div className="mb-2">
          {thumb.url ? (
            <button
              type="button"
              onClick={() => setViewerOpen(true)}
              aria-label="View page capture full screen"
              className="block cursor-pointer rounded-lg border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
              style={{ border: '1px solid var(--border-base)' }}
            >
              <img src={thumb.url} alt={`Screenshot of ${capture.final_url ?? 'captured page'}`} style={{ display: 'block', width: '100%', maxWidth: 200, height: 'auto', borderRadius: 8 }} />
            </button>
          ) : (
            <p className="m-0 text-[13px]" role="status" style={MUTED}>
              {thumb.error ? "Couldn't load the screenshot." : 'Loading screenshot…'}
            </p>
          )}
          <Viewer capture={capture} open={viewerOpen} onOpenChange={setViewerOpen} />
        </div>
      )}
      <dl className="m-0">
        <Row label="Captured at"><When iso={capture.captured_at} /></Row>
        {capture.page_title && <Row label="Page title">{capture.page_title}</Row>}
        {capture.http_status !== null && <Row label="HTTP status">{capture.http_status}</Row>}
        <Row label="Final URL">{capture.final_url ?? '—'}</Row>
        <Row label="Login form posts to">
          {capture.form_action_hosts.length === 0 ? 'No login form found' : (
            <ul className="m-0 list-none p-0">
              {capture.form_action_hosts.map((h) => {
                const isOff = off.includes(h);
                return (
                  <li key={h} data-offdomain={isOff || undefined} style={isOff ? { color: 'var(--sev-high-text)' } : undefined}>
                    {isOff && <AlertTriangle aria-hidden="true" size={13} style={{ display: 'inline', marginRight: 4, verticalAlign: '-2px' }} />}
                    {h}
                    {isOff && <span className="font-sans"> — differs from the page host</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </Row>
        {chain.length > 0 && (
          <Row label="Redirects">
            {chainCollapsible && (
              <button
                type="button"
                aria-expanded={chainOpen}
                onClick={() => setChainOpen((o) => !o)}
                className="mb-1 inline-flex min-h-[44px] cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-sans text-[13px]"
                style={{ color: 'var(--amber-text)' }}
              >
                <ChevronRight aria-hidden="true" size={14} style={{ transform: chainOpen ? 'rotate(90deg)' : 'none' }} />
                {chainOpen ? 'Hide' : 'Show'} {chain.length} redirects
              </button>
            )}
            {(!chainCollapsible || chainOpen) && (
              <ol className="m-0 list-decimal pl-5">
                {chain.map((u, i) => <li key={`${i}-${u}`}>{u}</li>)}
              </ol>
            )}
          </Row>
        )}
        {capture.expires_at && <Row label="Expires"><span title={formatDateTime(capture.expires_at)}>{formatDateTime(capture.expires_at)}</span></Row>}
      </dl>
      {capture.html_download_url && (
        <div className="my-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => { void onDownload(); }} loading={dlBusy}>
            <Download aria-hidden="true" size={14} /> Download HTML (evidence)
          </Button>
          {dlError && <p role="alert" className="m-0 mt-1 text-[13px]" style={{ color: 'var(--sev-critical-text)' }}>Download failed. Try again.</p>}
        </div>
      )}
      {sha && <CopyField value={sha} label={shaLabel} />}
    </div>
  );
}

// ── Group ──────────────────────────────────────────────────────────────────

export function PageCaptureGroup({ d }: { d: IdentityDetectionDetail }) {
  const { user } = useAuth();
  const canCapture = roleHasPermission(user?.role, 'edit_alerts');
  const mutation = useCaptureNow(d.threat_id);
  const captures = d.captures ?? [];
  const latest = captures[0];
  const older = captures.slice(1, 5);
  const pageHost = hostOf(latest?.final_url) ?? hostOf(d.domain);
  const pending = latest?.status === 'queued' || latest?.status === 'capturing';

  const errMsg = mutation.error
    ? (mutation.error instanceof CaptureError ? mutation.error.message : "Couldn't queue the capture")
    : null;

  const actionLabel = latest?.status === 'failed' ? 'Retry capture' : 'Capture now';
  const action = !pending && (
    <div className="mt-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => mutation.mutate()}
        loading={mutation.isPending}
        disabled={!canCapture}
        aria-describedby={!canCapture ? 'capture-perm-reason' : undefined}
      >
        {actionLabel}
      </Button>
      {!canCapture && (
        <p id="capture-perm-reason" className="m-0 mt-1 text-[12px]" style={MUTED}>
          Requires the edit alerts permission.
        </p>
      )}
      {errMsg && <p role="alert" className="m-0 mt-1 text-[13px]" style={{ color: 'var(--sev-critical-text)' }}>{errMsg}</p>}
    </div>
  );

  let body: ReactNode;
  if (!latest) {
    body = <p className="m-0 text-[13px]" style={MUTED}>No page capture yet.</p>;
  } else if (pending) {
    body = <p className="m-0 text-[13px]" role="status" style={{ color: 'var(--text-primary)' }}>Capturing… usually within 10 min</p>;
  } else if (latest.status === 'failed') {
    body = <p className="m-0 text-[13px]" style={{ color: 'var(--sev-critical-text)', overflowWrap: 'anywhere' }}>{latest.error ?? 'The capture failed.'}</p>;
  } else if (latest.status === 'expired') {
    body = <p className="m-0 text-[13px]" style={MUTED}>Capture expired{latest.expires_at ? ` on ${formatDateTime(latest.expires_at)}` : ''}. Evidence has been deleted.</p>;
  } else {
    body = (
      <>
        {latest.status === 'blocked' && (
          <p className="m-0 mb-2 text-[13px]" style={{ color: 'var(--sev-high-text)' }}>
            Page hid behind an anti-bot check{latest.anti_bot_wall ? ` (${latest.anti_bot_wall})` : ''}.
          </p>
        )}
        <CaptureDetails capture={latest} pageHost={pageHost} />
      </>
    );
  }

  return (
    <section className="mb-3" aria-label="Page capture">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h4 className={LABEL_CLS} style={{ ...MUTED, margin: 0 }}>Page capture</h4>
        {latest && captureBadge(latest.status)}
      </div>
      {body}
      {action}
      {older.length > 0 && (
        <div className="mt-3">
          <h5 className={`${LABEL_CLS} m-0 mb-1`} style={MUTED}>Earlier captures</h5>
          <ul className="m-0 list-none p-0">
            {older.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 py-1 text-[13px]">
                {captureBadge(c.status)}
                <span className="font-mono" style={MUTED}><When iso={c.captured_at ?? c.queued_at} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
