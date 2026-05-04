// Phase 2.5 of the unified Home rebuild — Threat Pulse section.
//
// Reuses the ThreatInflowChart from /threats so we have one source
// of truth for the inflow visualization. Same default window (24h)
// across Home, /threats, and any future surface — operators flip to
// 7D in the chart's segmented control when they want the wider view.
// Section padding aligns with the rest of the unified Home.

import { ThreatInflowChart } from '@/features/threats/ThreatInflowChart';

export function ThreatPulse() {
  return (
    <section className="home-threat-pulse">
      <ThreatInflowChart />
      <style>{`
        .home-threat-pulse {
          padding: 20px 24px 0;
        }
        @container home (min-width: 480px) {
          .home-threat-pulse { padding: 22px 32px 0; }
        }
      `}</style>
    </section>
  );
}
