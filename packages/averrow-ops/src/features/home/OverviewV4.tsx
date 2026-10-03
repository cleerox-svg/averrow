// v4 Overview: the landing page shown at "/" for every staff user.
//
// Top to bottom:
//   1. Hero            greeting + "N items need you" (the top bar already shows LIVE)
//   2. InstallAppBanner (CLAUDE.md §5, stays here)
//   3. Threat tempo    current hourly rate vs the 7d baseline
//   4. Needs you now   ranked queue, role-gated at the hook layer
//   5. Briefing        Observer's daily briefing | platform pulse
//   6. Digest          one row of links for everything else
//
// Replaces the 12 equal-weight sections of the pre-PR7 Home.

import { useAuth } from '@/lib/auth';
import { InstallAppBanner } from '@/components/InstallAppBanner';
import { Briefing } from '@/features/briefing/Briefing';
import { useHomeQueue } from '@/features/home/useHomeQueue';
import { NeedsYouNow } from '@/features/home/NeedsYouNow';
import { TempoBand } from '@/features/home/TempoBand';
import { PlatformPulse } from '@/features/home/PlatformPulse';
import { Digest } from '@/features/home/Digest';
import type { HomeQueue } from '@/lib/home-queue';
import '@/features/console/console.css';
import '@/features/home/home.css';

const SHELL_STYLE: React.CSSProperties = {
  containerType: 'inline-size' as React.CSSProperties['containerType'],
  containerName: 'home',
  width: '100%',
  minHeight: '100vh',
  paddingBottom: 24,
};

export interface HeroParts {
  /** The primary message ("3 items need you"), emphasised. */
  count: string | null;
  /** Trailing text (or the whole message when there is no count). */
  text: string;
}

export function heroParts(queue: HomeQueue): HeroParts | null {
  const n = queue.items.length;
  const unchecked = queue.failed.length;
  if (queue.enabled === 0) return null;
  if (queue.loading.length > 0 && n === 0 && unchecked === 0) return { count: null, text: 'Checking what needs you…' };
  const sources = `${unchecked} ${unchecked === 1 ? 'source' : 'sources'} couldn't be checked`;
  // Zero items with an unchecked source must not read as reassurance.
  if (n === 0 && unchecked > 0) return { count: null, text: `Can't confirm nothing needs you: ${sources}` };
  const count = `${n} ${n === 1 ? 'item needs' : 'items need'} you`;
  return { count, text: unchecked > 0 ? `, and ${sources}` : '' };
}

function Hero({ queue }: { queue: HomeQueue }) {
  const { user } = useAuth();
  const name = (user?.display_name ?? user?.name ?? '').split(' ')[0] || 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const parts = heroParts(queue);

  return (
    <div className="console-v4" style={{ paddingBottom: 6 }}>
      <div className="console-head">
        <div>
          <div className="console-crumb">COMMAND CENTER</div>
          <h1 className="console-title">{greeting}, {name}</h1>
          {parts && (
            <p className="home-hero-sub" aria-live="polite">
              {parts.count && <strong style={{ color: 'var(--amber-text)' }}>{parts.count}</strong>}
              {parts.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function OverviewV4() {
  const { queue, retry } = useHomeQueue();

  return (
    <div style={SHELL_STYLE}>
      <Hero queue={queue} />
      <InstallAppBanner />
      <section className="home-section" aria-label="Threat tempo"><TempoBand /></section>
      <section className="home-section"><NeedsYouNow queue={queue} onRetry={retry} /></section>
      <div className="home-section home-split">
        <Briefing source="intelligence" />
        <PlatformPulse />
      </div>
      <section className="home-section"><Digest /></section>
    </div>
  );
}
