// Phase 7 cutover: pages/Home.tsx is now a thin wrapper around the
// unified Home shell. All legacy logic — the desktop HomeDashboard,
// LatestIntelFeed, the mobile dispatch via useMobile, the home_v2
// feature flag — has moved into features/home/HomeUnified.tsx and
// its sections.
//
// Kept as a separate file so the existing route declaration in
// App.tsx (`/` → Home) doesn't need to change.

import { HomeUnified } from '@/features/home';

export function Home() {
  return <HomeUnified />;
}
