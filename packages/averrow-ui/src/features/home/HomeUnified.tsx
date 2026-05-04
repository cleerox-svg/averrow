// Phase 2 of the unified Home rebuild — composes the first real
// content sections inside the Phase 1 container-query shell.
//
// Section order (subsequent phases plug in below the Stat grid):
//   1. HomeHeader   — greeting + AVERROW eyebrow + LIVE + bell + profile
//   2. StatusRow    — critical-alerts banner + PlatformStatusFlyout
//   3. StatGrid     — six accent-tinted stat tiles drilling to pages
//   4. (Phase 2.5)  — Threat Pulse chart
//   5. (Phase 3)    — Brand Movers (rising / cooling)
//   6. (Phase 4)    — Daily Briefing hero + Live Activity ticker
//   7. (Phase 5)    — Module Hub grid
//   8. (Phase 6)    — Provider Movers
//
// Container query foundation lives on the shell root (Phase 1).
// Each section uses @container home (min-width: …) for its own
// internal layout.

import { HomeHeader } from './sections/HomeHeader';
import { StatusRow } from './sections/StatusRow';
import { StatGrid } from './sections/StatGrid';
import { ThreatPulse } from './sections/ThreatPulse';
import { BrandMovers } from './sections/BrandMovers';

const SHELL_STYLE: React.CSSProperties = {
  containerType: 'inline-size' as React.CSSProperties['containerType'],
  containerName: 'home',
  width: '100%',
  minHeight: '100vh',
  paddingBottom: 24,
};

export function HomeUnified() {
  return (
    <div style={SHELL_STYLE}>
      <HomeHeader />
      <StatusRow />
      <StatGrid />
      <ThreatPulse />
      <BrandMovers />
    </div>
  );
}
