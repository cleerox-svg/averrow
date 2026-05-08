import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Badge } from '@/components/ui/Badge';
import {
  useWebhookConfig, useUpdateWebhook, useRegenerateWebhookSecret, useTestWebhook,
  useWebhookDeliveries,
} from '@/hooks/useOrganization';

const WEBHOOK_EVENTS = [
  { key: 'threat.detected', label: 'New threat detected' },
  { key: 'threat.critical', label: 'New CRITICAL severity threat detected' },
  { key: 'threat.high', label: 'New HIGH severity threat detected' },
  { key: 'threat.any', label: 'Any new threat' },
  { key: 'severity.escalation', label: 'Severity escalation' },
  { key: 'takedown.requested', label: 'Takedown requested' },
  { key: 'takedown.submitted', label: 'Takedown request submitted' },
  { key: 'takedown.completed', label: 'Takedown completed' },
  { key: 'takedown.resolved', label: 'Takedown resolved' },
  { key: 'email.grade_change', label: 'Email security grade change' },
  { key: 'briefing.daily', label: 'Daily briefing' },
  { key: 'alert.new', label: 'New alert generated' },
  { key: 'alert.acknowledged', label: 'Alert acknowledged' },
  { key: 'feed.degraded', label: 'Feed ingestion degraded' },
  { key: 'member.invited', label: 'Team member invited' },
];

export function WebhookConfig() {
  const { data: webhook, isLoading } = useWebhookConfig();
  const { data: deliveries } = useWebhookDeliveries();
  const updateWebhook = useUpdateWebhook();
  const regenSecret = useRegenerateWebhookSecret();
  const testWebhook = useTestWebhook();

  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [showSecret, setShowSecret] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (webhook) {
      setUrl(webhook.webhook_url ?? '');
      setEvents(webhook.webhook_events ?? []);
    }
  }, [webhook]);

  const toggleEvent = (key: string) => {
    setEvents((prev) =>
      prev.includes(key) ? prev.filter((e) => e !== key) : [...prev, key],
    );
  };

  const handleSaveUrl = async () => {
    await updateWebhook.mutateAsync({ webhook_url: url });
  };

  const handleSaveEvents = async () => {
    await updateWebhook.mutateAsync({ webhook_events: events });
  };

  const handleRegenerate = async () => {
    const res = await regenSecret.mutateAsync();
    if (res.data?.webhook_secret) {
      setNewSecret(res.data.webhook_secret);
      setShowSecret(true);
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    const res = await testWebhook.mutateAsync();
    setTestResult({ ok: !!res.success, msg: res.success ? 'Test payload sent successfully' : (res.error ?? 'Test failed') });
  };

  if (isLoading) {
    return <div className="text-sm text-white/55 font-mono py-8 text-center">Loading webhook config...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Endpoint URL */}
      <Card hover={false}>
        <SectionLabel className="mb-3">Webhook Configuration</SectionLabel>

        <div className="space-y-4">
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Endpoint URL
            </label>
            <div className="flex gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-system.com/averrow-webhook"
                className="flex-1"
              />
              <Button
                variant="secondary"
                size="md"
                onClick={handleSaveUrl}
                disabled={updateWebhook.isPending}
              >
                Save
              </Button>
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Secret (HMAC-SHA256 signing key)
            </label>
            <div className="flex gap-2 items-center">
              <div className="flex-1 bg-[color:var(--bg-page)] border border-white/10 rounded-md px-3 py-2 text-xs font-mono text-[color:var(--text-secondary)] truncate">
                {showSecret && newSecret ? newSecret : (webhook?.has_secret ? '••••••••••••••••••••••••••••••••' : 'Not configured')}
              </div>
              {webhook?.has_secret && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowSecret(!showSecret)}
                >
                  {showSecret ? 'Hide' : 'Show'}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRegenerate}
                disabled={regenSecret.isPending}
              >
                Regenerate
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Subscribed Events */}
      <Card hover={false}>
        <SectionLabel className="mb-3">Subscribed Events</SectionLabel>
        <div className="space-y-2">
          {WEBHOOK_EVENTS.map((evt) => (
            <label key={evt.key} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={events.includes(evt.key)}
                onChange={() => toggleEvent(evt.key)}
                className="w-3.5 h-3.5 mt-0.5 rounded border-white/20 bg-[color:var(--bg-page)] accent-[color:var(--amber)]"
              />
              <div>
                <span className="text-[11px] font-mono text-[color:var(--text-primary)]">{evt.key}</span>
                <span className="text-[10px] text-white/55 ml-2">{evt.label}</span>
              </div>
            </label>
          ))}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSaveEvents}
          disabled={updateWebhook.isPending}
          className="mt-4"
        >
          Save Event Subscriptions
        </Button>
      </Card>

      {/* Test + Deliveries */}
      <Card hover={false}>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="md"
            onClick={handleTest}
            disabled={testWebhook.isPending || !url}
          >
            {testWebhook.isPending ? 'Testing...' : 'Test Webhook'}
          </Button>
          {testResult && (
            <span className={`text-[11px] font-mono ${testResult.ok ? 'text-positive' : 'text-accent'}`}>
              {testResult.msg}
            </span>
          )}
        </div>

        <div className="mt-4">
          <SectionLabel className="mb-2">Recent Deliveries</SectionLabel>
          {!deliveries || deliveries.length === 0 ? (
            <p className="text-[11px] text-white/55">No deliveries yet.</p>
          ) : (
            <div className="space-y-1.5">
              {deliveries.slice(0, 10).map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between py-2 px-3 bg-[color:var(--bg-page)] border border-white/[0.06] rounded-lg text-[11px] font-mono"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge variant={d.success ? 'success' : 'critical'}>
                      {d.status_code}
                    </Badge>
                    <span className="text-[color:var(--text-secondary)] truncate">{d.event}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-white/55">
                    <span>{d.response_time_ms}ms</span>
                    <span>{new Date(d.delivered_at).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Webhook Payload Example */}
      <Card hover={false}>
        <SectionLabel className="mb-2">Payload Example</SectionLabel>
        <pre className="bg-[color:var(--bg-page)] border border-white/10 rounded-lg p-3 text-[10px] font-mono text-[color:var(--text-secondary)] overflow-x-auto">
{`{
  "event": "threat.critical",
  "timestamp": "2026-03-28T13:17:15Z",
  "delivery_id": "uuid",
  "org_id": 1,
  "data": {
    "threat_id": "...",
    "domain": "paypal-secure.xyz",
    "severity": "CRITICAL",
    "type": "phishing"
  }
}`}
        </pre>
      </Card>

      {/* STIX Export */}
      <Card hover={false}>
        <SectionLabel className="mb-2">STIX 2.1 Export</SectionLabel>
        <p className="text-[11px] text-[color:var(--text-tertiary)] mb-3">
          Export threat indicators in STIX 2.1 format for SIEM ingestion.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={() => window.open('/api/export/stix/brand_docusign_net', '_blank')}>
            Export STIX for Docusign
          </Button>
          <Button variant="secondary" size="sm" onClick={() => window.open('/api/export/stix', '_blank')}>
            Export All Brands
          </Button>
        </div>
      </Card>
    </div>
  );
}
