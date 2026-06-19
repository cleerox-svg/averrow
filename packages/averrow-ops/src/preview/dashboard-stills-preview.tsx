// Standalone capture harness for the marketing dashboard stills.
// Renders the real ExposureGauge / ThreatMap / EventTicker with
// deterministic mock data so they can be screenshotted for the Astro
// marketing site. Dev-only (only index.html ships to prod). Mirrors the
// other src/preview/* harnesses.
//
// Usage: /preview-dashboard-stills.html?c=gauge|map|ticker&theme=dark|light

import ReactDOM from 'react-dom/client';
import { ExposureGauge } from '../features/brands/components/ExposureGauge';
import { ThreatMap } from '../features/observatory/components/ThreatMap';
import { EventTicker } from '../features/observatory/components/EventTicker';
import type { ThreatPoint, ArcData } from '../hooks/useObservatory';
import '../index.css';

const params = new URLSearchParams(window.location.search);
const which = params.get('c') ?? 'gauge';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.setAttribute('data-theme', theme);

// ─── Mock data ──────────────────────────────────────────────────────
const THREATS: ThreatPoint[] = [
  { lat: 40.7, lng: -74.0, threat_count: 42, top_severity: 'critical', critical: 20, high: 12, medium: 6, low: 4, country_code: 'US', top_threat_type: 'phishing' },
  { lat: 51.5, lng: -0.12, threat_count: 28, top_severity: 'high', critical: 6, high: 14, medium: 5, low: 3, country_code: 'GB', top_threat_type: 'malware_distribution' },
  { lat: 1.35, lng: 103.8, threat_count: 19, top_severity: 'high', critical: 4, high: 9, medium: 4, low: 2, country_code: 'SG', top_threat_type: 'phishing' },
  { lat: 55.75, lng: 37.6, threat_count: 33, top_severity: 'critical', critical: 18, high: 9, medium: 4, low: 2, country_code: 'RU', top_threat_type: 'c2' },
  { lat: 35.68, lng: 139.7, threat_count: 15, top_severity: 'medium', critical: 2, high: 5, medium: 6, low: 2, country_code: 'JP', top_threat_type: 'phishing' },
  { lat: -23.5, lng: -46.6, threat_count: 11, top_severity: 'medium', critical: 1, high: 4, medium: 4, low: 2, country_code: 'BR', top_threat_type: 'lookalike' },
  { lat: 22.3, lng: 114.2, threat_count: 24, top_severity: 'high', critical: 7, high: 11, medium: 4, low: 2, country_code: 'HK', top_threat_type: 'malware_distribution' },
];

const ARCS: ArcData[] = [
  { sourcePosition: [37.6, 55.75], targetPosition: [-74.0, 40.7], threat_type: 'phishing', severity: 'critical', source_region: 'RU', target_brand: 'b1', brand_name: 'Acme', volume: 18 },
  { sourcePosition: [103.8, 1.35], targetPosition: [-0.12, 51.5], threat_type: 'malware_distribution', severity: 'high', source_region: 'SG', target_brand: 'b2', brand_name: 'Globex', volume: 9 },
  { sourcePosition: [114.2, 22.3], targetPosition: [139.7, 35.68], threat_type: 'phishing', severity: 'high', source_region: 'HK', target_brand: 'b3', brand_name: 'Initech', volume: 11 },
  { sourcePosition: [-46.6, -23.5], targetPosition: [-74.0, 40.7], threat_type: 'lookalike', severity: 'medium', source_region: 'BR', target_brand: 'b1', brand_name: 'Acme', volume: 6 },
];

// EventTicker fetches its own data — stub fetch with canned rows.
if (which === 'ticker') {
  const now = Date.now();
  const activity = [
    { created_at: new Date(now - 4000).toISOString(), agent_id: 'sentinel', message: 'New lookalike domain detected: acme-login.com', severity: 'high' },
    { created_at: new Date(now - 9000).toISOString(), agent_id: 'cartographer', message: 'Enriched 1,204 threats with geo + provider data', severity: 'info' },
    { created_at: new Date(now - 14000).toISOString(), agent_id: 'nexus', message: 'Pivot detected — infrastructure cluster expanding', severity: 'warning' },
    { created_at: new Date(now - 21000).toISOString(), agent_id: 'analyst', message: 'Campaign scoring complete — 3 actors reprioritised', severity: 'info' },
  ];
  const outputs = [
    { created_at: new Date(now - 6000).toISOString(), agent_id: 'observer', summary: 'Critical: coordinated phishing wave targeting finance sector', severity: 'critical' },
    { created_at: new Date(now - 17000).toISOString(), agent_id: 'strategist', summary: 'High: threat actor APT-Nightjar shifting to new ASN', severity: 'high' },
  ];
  const orig = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/v1/agents/activity')) return new Response(JSON.stringify({ success: true, data: activity }), { headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/api/v1/agents/outputs')) return new Response(JSON.stringify({ success: true, data: outputs }), { headers: { 'Content-Type': 'application/json' } });
    return orig(input, init);
  }) as typeof window.fetch;
}

function Stage() {
  if (which === 'gauge') {
    return (
      <div id="stage" style={{ display: 'inline-flex', padding: 24, background: 'transparent' }}>
        <ExposureGauge score={72} size={240} />
      </div>
    );
  }
  if (which === 'map') {
    return (
      <div id="stage" style={{ width: 960, height: 600, position: 'relative' }}>
        <ThreatMap
          threats={THREATS}
          arcs={ARCS}
          showBeams
          showParticles={false}
          showNodes
          colorBy="severity"
          mapMode="global"
        />
      </div>
    );
  }
  return (
    <div id="stage" style={{ minHeight: 120 }}>
      <EventTicker />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Stage />);
