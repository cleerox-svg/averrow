import { useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Download } from 'lucide-react';
import { CopyField, Dialog, Tabs } from '@averrow/shared/ui';
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

/**
 * Display-only registrable-domain approximation (last two labels, three when
 * the second-to-last is a generic SLD under a 2-letter ccTLD, e.g. co.uk).
 * Not a Public Suffix List lookup; never use for security decisions.
 */
const GENERIC_SLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const take = labels[labels.length - 1].length === 2 && GENERIC_SLDS.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** True when the capture ended on a different site than the detection's own domain. */
export function isOffsiteHost(finalHost: string | null, detectionHost: string | null): boolean {
  if (!finalHost || !detectionHost) return false;
  return registrableDomain(finalHost) !== registrableDomain(detectionHost);
}

/** The scanner was bounced to a decoy page: the screenshot is not the kit. */
export function isDecoyCapture(c: PageCapture): boolean {
  return c.status === 'blocked' && c.anti_bot_wall === 'offsite_redirect';
}

const NOT_THE_KIT = 'so this capture may not show the suspected phishing page.';
function antiBotMessage(wall: string | null): string {
  switch (wall) {
    case 'cf_challenge': return `Our scanner hit a Cloudflare challenge, ${NOT_THE_KIT}`;
    case 'blank_page': return `The page returned blank content to our scanner (a common way kits hide from automated scans), ${NOT_THE_KIT}`;
    case null: return `The page hid behind an anti-bot check, ${NOT_THE_KIT}`;
    default: return `The page hid behind an anti-bot check (${wall}), ${NOT_THE_KIT}`;
  }
}

/** Form-action hosts on a different site (registrable domain) than the page's host. */
export function offDomainHosts(pageHost: string | null, hosts: string[]): string[] {
  if (!pageHost) return [];
  return hosts.filter((h) => isOffsiteHost(h.toLowerCase(), pageHost));
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
  const decoy = isDecoyCapture(capture);
  const [variant, setVariant] = useState<'mobile' | 'desktop'>(capture.screenshot_mobile_url ? 'mobile' : 'desktop');
  const path = variant === 'mobile' ? capture.screenshot_mobile_url : capture.screenshot_desktop_url;
  const img = useAuthedBlobUrl(path, open);
  const tabs = [
    ...(capture.screenshot_mobile_url ? [{ id: 'mobile', label: 'Mobile' }] : []),
    ...(capture.screenshot_desktop_url ? [{ id: 'desktop', label: 'Desktop' }] : []),
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={decoy ? 'Page capture — decoy page' : 'Page capture'}
      description={capture.final_url ? <span style={{ overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{capture.final_url}</span> : undefined}
      width="min(960px, calc(100vw - 32px))"
      presentation="dialog"
    >
      {tabs.length > 1 && (
        <div className="mb-3">
          <Tabs
            tabs={tabs}
            activeTab={variant}
            onChange={(id) => setVariant(id === 'desktop' ? 'desktop' : 'mobile')}
            variant="pills"
            size="md"
            activation="auto"
            aria-label="Screenshot size"
          />
        </div>
      )}
      <div className="flex justify-center overflow-auto" style={{ maxHeight: '70dvh' }}>
        {img.url ? (
          <img src={img.url} alt={`${variant === 'mobile' ? 'Mobile' : 'Desktop'} screenshot of ${decoy ? 'a decoy page (not the phishing kit)' : 'the captured page'}`} style={{ maxWidth: '100%', height: 'auto' }} />
        ) : img.error ? (
          <ImageError onRetry={img.retry} />
        ) : (
          <p className="m-0 text-[13px]" role="status" style={MUTED}>{img.loading ? 'Loading screenshot…' : 'No screenshot for this size.'}</p>
        )}
      </div>
    </Dialog>
  );
}

function ImageError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="text-[13px]" style={MUTED}>
      <p className="m-0 mb-1">Couldn't load the screenshot.</p>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  );
}

// ── Body of a finished capture ─────────────────────────────────────────────

function CaptureDetails({ capture, detectionHost }: { capture: PageCapture; detectionHost: string | null }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [dlError, setDlError] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const thumbPath = capture.screenshot_mobile_url ?? capture.screenshot_desktop_url;
  const thumb = useAuthedBlobUrl(thumbPath);
  const decoy = isDecoyCapture(capture);
  const finalHost = hostOf(capture.final_url);
  const showRedirectNote = !decoy && (capture.status === 'captured' || capture.status === 'blocked') && isOffsiteHost(finalHost, detectionHost);
  // Forms resolve against the page we landed on; a decoy's hosts are not the kit's.
  const pageHost = finalHost ?? detectionHost;
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
            <>
              <button
                type="button"
                onClick={() => setViewerOpen(true)}
                aria-label={decoy ? 'View decoy page screenshot full screen' : 'View page capture full screen'}
                className="block min-h-[44px] w-full cursor-pointer overflow-hidden rounded-lg bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
                style={{ border: '1px solid var(--border-base)' }}
              >
                <img
                  src={thumb.url}
                  alt={decoy ? 'Mobile screenshot of a decoy page (not the phishing kit)' : 'Mobile screenshot of the captured page'}
                  style={{ display: 'block', width: '100%', maxHeight: 240, objectFit: 'cover', objectPosition: 'top' }}
                />
              </button>
              <p className="m-0 mt-1 text-[12px]" style={MUTED}>{decoy ? 'Tap to enlarge (decoy page, not the kit)' : 'Tap to enlarge'}</p>
            </>
          ) : thumb.error ? (
            <ImageError onRetry={thumb.retry} />
          ) : (
            <p className="m-0 text-[13px]" role="status" style={MUTED}>Loading screenshot…</p>
          )}
          <Viewer capture={capture} open={viewerOpen} onOpenChange={setViewerOpen} />
        </div>
      )}
      <dl className="m-0">
        <Row label="Captured at"><When iso={capture.captured_at} /></Row>
        {capture.page_title && <Row label="Page title">{capture.page_title}</Row>}
        {capture.http_status !== null && <Row label="HTTP status">{capture.http_status}</Row>}
        <Row label={decoy ? 'Decoy URL (where the scanner landed)' : 'Final URL'}>
          {capture.final_url ?? '—'}
          {showRedirectNote && (
            <span data-redirect-note className="mt-1 block font-sans text-[12px]" style={MUTED}>
              Redirected to another site: <strong className="font-mono">{finalHost}</strong>
            </span>
          )}
        </Row>
        {!decoy && <Row label="Login form posts to">
          {capture.form_action_hosts.length === 0 ? 'No login form found' : (
            <>
              {off.length > 0 && (
                <div
                  role="note"
                  data-offdomain-note
                  className="mb-1 rounded-lg px-3 py-2 font-sans text-[13px]"
                  style={{ background: 'var(--sev-high-bg)', border: '1px solid var(--sev-high-border)', color: 'var(--sev-high-text)' }}
                >
                  <AlertTriangle aria-hidden="true" size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: '-2px' }} />
                  <strong className="font-mono">{off.join(', ')}</strong>
                  <span className="block">Credentials would be sent to a different site than this page.</span>
                </div>
              )}
              <ul className="m-0 list-none p-0">
                {capture.form_action_hosts.map((h) => {
                  const isOff = off.includes(h);
                  return (
                    <li key={h} data-offdomain={isOff || undefined} style={isOff ? { color: 'var(--sev-high-text)', fontWeight: 700 } : undefined}>
                      {h}{isOff && <span className="sr-only"> (different from the page host)</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Row>}
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
            <Download aria-hidden="true" size={14} /> Download HTML ({decoy ? 'decoy page' : 'evidence'})
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
  // Compare form hosts to the detection's own domain, not the final URL: a
  // cloaked kit redirects the scanner elsewhere, so final_url can be a decoy.
  const detectionHost = hostOf(d.domain);
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
          Your role can't queue captures. Ask an analyst or admin.
        </p>
      )}
      {errMsg && <p role="alert" className="m-0 mt-1 text-[13px]" style={{ color: 'var(--sev-critical-text)' }}>{errMsg}</p>}
    </div>
  );

  let body: ReactNode;
  if (!latest) {
    body = <p className="m-0 text-[13px]" style={MUTED}>No capture yet. Capture the page to preserve evidence.</p>;
  } else if (pending) {
    body = (
      <p className="m-0 text-[13px]" role="status" style={{ color: 'var(--text-primary)' }}>
        {latest.status === 'queued' ? 'Queued — capture starts shortly, usually within 10 min' : 'Capturing… usually within 10 min'}
      </p>
    );
  } else if (latest.status === 'failed') {
    body = <p className="m-0 text-[13px]" style={{ color: 'var(--sev-critical-text)', overflowWrap: 'anywhere' }}>Capture failed: {latest.error ?? 'unknown error'}</p>;
  } else if (latest.status === 'expired') {
    body = <p className="m-0 text-[13px]" style={MUTED}>Capture expired{latest.expires_at ? ` on ${formatDateTime(latest.expires_at)}` : ''}. Evidence has been deleted.</p>;
  } else {
    body = (
      <>
        {latest.status === 'blocked' && (
          <div
            role="note"
            data-blocked-note
            className="mb-2 rounded-lg px-3 py-2 text-[13px]"
            style={{ background: 'var(--sev-high-bg)', border: '1px solid var(--sev-high-border)', color: 'var(--sev-high-text)', overflowWrap: 'anywhere' }}
          >
            <AlertTriangle aria-hidden="true" size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: '-2px' }} />
            {isDecoyCapture(latest)
              ? <><strong>Decoy page captured.</strong> The site sent our scanner to <strong className="font-mono">{hostOf(latest.final_url) ?? 'another site'}</strong> instead of the suspected phishing page (a common cloaking trick). The screenshot shows the decoy, not the kit, and is not used as takedown evidence.</>
              : antiBotMessage(latest.anti_bot_wall)}
          </div>
        )}
        <CaptureDetails capture={latest} detectionHost={detectionHost} />
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
