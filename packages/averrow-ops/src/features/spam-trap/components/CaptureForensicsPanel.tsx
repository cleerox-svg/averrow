import { useState, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useSpamTrapCaptures, useSpamTrapCapture } from '@/hooks/useSpamTrap';
import type { SpamTrapCapture, SpamTrapCaptureDetail } from '@/hooks/useSpamTrap';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/design-system/components';

const GLASS_CARD: CSSProperties = {
  background: 'rgba(15,23,42,0.50)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.07)',
  boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#f87171',
  high: '#fb923c',
  medium: '#fbbf24',
  low: '#78A0C8',
  clean: '#4ade80',
};

function AuthBadge({ label, result }: { label: string; result: string | null }) {
  const pass = result === 'pass';
  return pass
    ? <Badge status="active"     label={`${label} \u2713`} size="xs" />
    : <Badge severity="critical" label={`${label} \u2717`} size="xs" />;
}

function CaptureCard({ capture }: { capture: SpamTrapCapture }) {
  const [expanded, setExpanded] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const { data: detail } = useSpamTrapCapture(detailId);

  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);
  const [showBody, setShowBody] = useState(false);
  const [showAllUrls, setShowAllUrls] = useState(false);

  const handleExpand = () => {
    if (!expanded) setDetailId(capture.id);
    setExpanded(!expanded);
  };

  const runAiAnalysis = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await api.post<{ analysis?: string; result?: string }>(
        `/api/admin/sparrow/scan-capture/${capture.id}`,
      );
      setAiResult(res.data?.analysis ?? res.data?.result ?? 'Analysis complete');
    } catch {
      setAiError('AI analysis unavailable');
    } finally {
      setAiLoading(false);
    }
  };

  const captureDate = capture.captured_at
    ? new Date(capture.captured_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '—';

  const category = (capture.category ?? '—').toUpperCase();
  const severity = (capture.severity ?? '—').toUpperCase();
  const severityColor = SEVERITY_COLORS[(capture.severity ?? '').toLowerCase()] ?? '#78A0C8';

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        ...GLASS_CARD,
        ...(capture.category === 'phishing'
          ? { borderTop: '1px solid rgba(200,60,60,0.7)' }
          : {}),
      }}
    >
      {/* Collapsed header */}
      <button
        onClick={handleExpand}
        className="w-full text-left p-4 hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: severityColor }}
            />
            <span className="font-mono text-[10px] font-semibold uppercase" style={{ color: severityColor }}>
              {category}
            </span>
            <span className="text-white/40 text-[10px]">·</span>
            <span className="font-mono text-[10px] text-white/50 uppercase">{severity}</span>
          </div>
          <span className="font-mono text-[10px] text-white/50">{captureDate}</span>
        </div>
        <p className="text-[11px] text-white/70 truncate mb-1">
          &ldquo;{capture.subject ?? '(no subject)'}&rdquo;
        </p>
        <div className="flex items-center gap-2 text-[10px] text-white/40 font-mono">
          <span>FROM {capture.from_address ?? '—'}</span>
          <span>→</span>
          <span>{capture.trap_address ?? '—'}</span>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <AuthBadge label="SPF" result={capture.spf_result} />
          <AuthBadge label="DKIM" result={capture.dkim_result} />
          <AuthBadge label="DMARC" result={capture.dmarc_result} />
          <span className="text-white/40 text-[10px]">·</span>
          <span className="font-mono text-[10px] text-white/40">{capture.url_count ?? 0} URLs</span>
          <span className="ml-auto font-mono text-[10px] text-white/50">
            {expanded ? '[Collapse ▲]' : '[Expand ▼]'}
          </span>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-white/[0.06] p-4">
          {!detail ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          ) : (
            <ExpandedDetail
              detail={detail}
              showAllUrls={showAllUrls}
              setShowAllUrls={setShowAllUrls}
              showHeaders={showHeaders}
              setShowHeaders={setShowHeaders}
              showBody={showBody}
              setShowBody={setShowBody}
              aiResult={aiResult}
              aiLoading={aiLoading}
              aiError={aiError}
              onRunAi={runAiAnalysis}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedDetail({
  detail,
  showAllUrls,
  setShowAllUrls,
  showHeaders,
  setShowHeaders,
  showBody,
  setShowBody,
  aiResult,
  aiLoading,
  aiError,
  onRunAi,
}: {
  detail: SpamTrapCaptureDetail;
  showAllUrls: boolean;
  setShowAllUrls: (v: boolean) => void;
  showHeaders: boolean;
  setShowHeaders: (v: boolean) => void;
  showBody: boolean;
  setShowBody: (v: boolean) => void;
  aiResult: string | null;
  aiLoading: boolean;
  aiError: string | null;
  onRunAi: () => void;
}) {
  const urls = detail.urls ?? [];
  const urlsByDomain = useMemo(() => {
    const map: Record<string, number> = {};
    for (const u of urls) {
      try {
        const domain = new URL(u).hostname;
        map[domain] = (map[domain] ?? 0) + 1;
      } catch {
        map['(invalid)'] = (map['(invalid)'] ?? 0) + 1;
      }
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [urls]);

  const visibleUrls = showAllUrls ? urls : urls.slice(0, 5);
  const brandConfidence = detail.brand_confidence ?? 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* LEFT — Email Intelligence */}
      <div className="space-y-3">
        <div className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)]">
          Email Intelligence
        </div>
        <div className="space-y-1.5 text-[11px]">
          <Row label="From" value={detail.from_address ?? '—'} />
          <Row label="Reply-To" value={detail.reply_to ?? '—'} />
          <Row label="Via" value={detail.return_path ?? detail.helo_hostname ?? '—'} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <AuthBadge label="SPF" result={detail.spf_result} />
          <AuthBadge label="DKIM" result={detail.dkim_result} />
          <AuthBadge label="DMARC" result={detail.dmarc_result} />
        </div>
        {detail.spoofed_domain && (
          <div className="mt-2">
            <span className="text-[10px] text-white/40 font-mono">Brand spoofed: </span>
            <span
              className={`text-[11px] font-mono font-semibold ${brandConfidence > 70 ? 'text-red-400' : 'text-white/70'}`}
              style={brandConfidence > 70 ? { textShadow: '0 0 8px rgba(248,113,113,0.5)' } : undefined}
            >
              {detail.spoofed_domain} ({brandConfidence}%)
            </span>
          </div>
        )}
      </div>

      {/* CENTER — URLs */}
      <div className="space-y-3">
        <div className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)]">
          URLs
        </div>
        <div className="text-[32px] font-bold font-mono text-white leading-none">
          {urls.length}
        </div>
        {urlsByDomain.length > 0 && (
          <div className="space-y-1">
            {urlsByDomain.map(([domain, count]) => (
              <div key={domain} className="flex items-center justify-between text-[10px] font-mono">
                <span className="text-white/60 truncate max-w-[160px]">{domain}</span>
                <span className="text-white/50">{count}</span>
              </div>
            ))}
          </div>
        )}
        {visibleUrls.length > 0 && (
          <div className="space-y-0.5">
            {visibleUrls.map((u, i) => (
              <div key={i} className="text-[9px] font-mono text-white/50 truncate" title={u}>
                {u.length > 50 ? u.slice(0, 50) + '…' : u}
              </div>
            ))}
          </div>
        )}
        {urls.length > 5 && (
          <button
            onClick={() => setShowAllUrls(!showAllUrls)}
            className="text-[10px] font-mono text-[#E5A832] hover:text-[#D49A28] transition-colors"
          >
            {showAllUrls ? '[Show less]' : `[Show all ${urls.length}]`}
          </button>
        )}
      </div>

      {/* RIGHT — Actions */}
      <div className="space-y-3">
        <div className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)]">
          Actions
        </div>
        <button
          onClick={onRunAi}
          disabled={aiLoading}
          className="w-full px-3 py-2 rounded-lg bg-afterburner-muted border border-afterburner-border text-[#E5A832] text-[11px] font-mono hover:bg-afterburner-muted disabled:opacity-40 transition-colors"
        >
          {aiLoading ? 'Analyzing…' : 'Run AI Analysis'}
        </button>
        {aiResult && (
          <div className="rounded-lg p-3 text-[10px] text-white/70 font-mono whitespace-pre-wrap" style={GLASS_CARD}>
            {aiResult}
          </div>
        )}
        {aiError && (
          <div className="text-[10px] text-red-400/80 font-mono">{aiError}</div>
        )}
        <button
          onClick={() => setShowHeaders(!showHeaders)}
          className="w-full px-3 py-1.5 rounded-lg bg-white/5 text-white/50 text-[11px] font-mono hover:bg-white/10 transition-colors"
        >
          {showHeaders ? 'Hide Raw Headers' : 'View Raw Headers'}
        </button>
        {showHeaders && (
          <pre className="text-[9px] font-mono text-white/50 bg-black/30 rounded-lg p-3 max-h-[200px] overflow-auto whitespace-pre-wrap">
            {detail.raw_headers ?? 'No headers available'}
          </pre>
        )}
        <button
          onClick={() => setShowBody(!showBody)}
          className="w-full px-3 py-1.5 rounded-lg bg-white/5 text-white/50 text-[11px] font-mono hover:bg-white/10 transition-colors"
        >
          {showBody ? 'Hide Body' : 'View Body'}
        </button>
        {showBody && (
          <pre className="text-[9px] font-mono text-white/50 bg-black/30 rounded-lg p-3 max-h-[200px] overflow-auto whitespace-pre-wrap">
            {detail.body_preview ?? 'No body available'}
          </pre>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-white/40 font-mono w-[60px] shrink-0">{label}</span>
      <span className="text-white/70 font-mono truncate" title={value}>{value}</span>
    </div>
  );
}

export function CaptureForensicsPanel() {
  const { data: captures, isLoading, isError, refetch } = useSpamTrapCaptures({ limit: 50 });

  if (isError) {
    return (
      <div className="rounded-xl p-4 min-h-[400px] flex flex-col items-center justify-center gap-3" style={GLASS_CARD}>
        <span className="text-white/40 text-sm font-mono">Unable to load captures</span>
        <button
          onClick={() => refetch()}
          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-mono text-white/60 transition-colors"
        >
          RETRY
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-4 min-h-[400px]" style={GLASS_CARD}>
      <div className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)] mb-4">
        Capture Forensics
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : (captures ?? []).length === 0 ? (
        <div className="flex items-center justify-center h-[300px]">
          <span className="text-white/40 text-sm font-mono">
            No captures yet — honeypots are listening
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          {(captures ?? []).map((capture) => (
            <CaptureCard key={capture.id} capture={capture} />
          ))}
        </div>
      )}
    </div>
  );
}
