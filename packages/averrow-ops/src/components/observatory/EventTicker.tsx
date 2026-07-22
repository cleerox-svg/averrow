import { useEffect, useState, useRef } from 'react';
import { api } from '@/lib/api';

type ActivityRow = { created_at: string; agent_id: string; message: string; severity: string };
type OutputRow = { created_at: string; agent_id: string; summary: string; severity: string };

interface TickerEvent {
  id: string;
  agent_id: string;
  message: string;
  severity: 'critical' | 'high' | 'warning' | 'info' | 'success';
  created_at: string;
  type: 'activity' | 'output';
}

function formatTickerMessage(event: TickerEvent): string {
  let msg = event.message
    .replace(/\*\*/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (msg.length > 120) msg = msg.slice(0, 117) + '...';
  return msg;
}

function getAgentLabel(agentId: string): string {
  const labels: Record<string, string> = {
    flight_control: 'FC',
    sentinel: 'SNT',
    analyst: 'ANL',
    observer: 'OBS',
    nexus: 'NXS',
    cartographer: 'CART',
    sparrow: 'SPW',
    strategist: 'STR',
    feed_diagnostics: 'FEED',
  };
  return labels[agentId] ?? agentId.slice(0, 4).toUpperCase();
}

function getSeverityFromEvent(e: TickerEvent): TickerEvent['severity'] {
  if (e.severity === 'critical') return 'critical';
  if (e.severity === 'high' || e.severity === 'warning') return 'high';
  if (e.message.toLowerCase().includes('success') ||
      e.message.toLowerCase().includes('complete')) return 'success';
  if (e.message.toLowerCase().includes('pivot') ||
      e.message.toLowerCase().includes('accelerat')) return 'warning';
  return 'info';
}

export function EventTicker() {
  const [events, setEvents] = useState<TickerEvent[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  async function fetchEvents() {
    try {
      const [actData, outData] = await Promise.all([
        api.get<ActivityRow[]>('/api/v1/agents/activity?limit=15').catch(() => ({ data: [] as ActivityRow[] })),
        api.get<OutputRow[]>('/api/v1/agents/outputs?limit=10&severity=high,critical').catch(() => ({ data: [] as OutputRow[] })),
      ]);

      const actEvents: TickerEvent[] = (actData.data ?? []).map((e) => ({
        id: `act-${e.created_at}-${e.agent_id}`,
        agent_id: e.agent_id,
        message: e.message,
        severity: e.severity === 'warning' ? 'warning' as const :
                  e.severity === 'critical' ? 'critical' as const : 'info' as const,
        created_at: e.created_at,
        type: 'activity' as const,
      }));

      const outEvents: TickerEvent[] = (outData.data ?? []).map((e) => ({
        id: `out-${e.created_at}-${e.agent_id}`,
        agent_id: e.agent_id,
        message: e.summary,
        severity: e.severity === 'critical' ? 'critical' as const :
                  e.severity === 'high' ? 'high' as const : 'info' as const,
        created_at: e.created_at,
        type: 'output' as const,
      }));

      const all = [...actEvents, ...outEvents]
        .sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
        .slice(0, 20);

      setEvents(all);
    } catch {
      // Silent fail — ticker is non-critical
    }
  }

  useEffect(() => {
    fetchEvents();
    intervalRef.current = setInterval(fetchEvents, 30000);
    return () => clearInterval(intervalRef.current);
  }, []);

  if (events.length === 0) return null;

  // Fixed ticker speed — fast enough to feel like a news/stock ticker
  const duration = 18;

  // Double events for seamless loop
  const doubled = [...events, ...events];

  return (
    <div className="event-ticker fixed bottom-9 left-0 w-full z-30 bg-black/80 backdrop-blur-sm md:bottom-[52px] md:left-[200px] md:w-[calc(100%_-_200px)]">
      {/* Left label */}
      <div className="ticker-label">
        <span className="dot-pulse dot-pulse-teal" style={{ width: 5, height: 5 }} />
        INTEL FEED
      </div>

      {/* Scrolling content */}
      <div style={{ overflow: 'hidden', flex: 1 }}>
        <div className="ticker-track" style={{ animationDuration: `${duration}s` }}>
          {doubled.map((event, idx) => {
            const sev = getSeverityFromEvent(event);
            return (
              <span key={`${event.id}-${idx}`} className={`ticker-item ticker-item-${sev}`}>
                <span className={`ticker-dot ticker-dot-${sev}`} />
                <span className="ticker-agent">{getAgentLabel(event.agent_id)}</span>
                <span className="ticker-bullet">{'\u25B8'}</span>
                <span>{formatTickerMessage(event)}</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
