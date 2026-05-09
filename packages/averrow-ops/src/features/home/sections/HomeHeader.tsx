// Phase 2 of the unified Home rebuild — Header band.
//
// Greeting, "AVERROW · COMMAND CENTER" eyebrow, today's date, LIVE
// indicator, notifications bell, profile pill. Identical content to
// the mobile Command Center header — promoted to all sizes via
// container queries on the parent shell.
//
// Layout: stacks under 480px (greeting block above the controls row),
// single row above. The controls row keeps all interactive affordances
// at the trailing edge so they remain easily reachable on touch.

import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { parseInitials, SELF_AVATAR_COLOR } from '@/lib/avatar';
import { NotificationBell } from '@/components/NotificationBell';
import { M } from '@/design-system/tokens';
import { formatDate } from '@/lib/time';

function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function HomeHeader() {
  const navigate = useNavigate();
  const { user } = useAuth();

  // Service-account JWTs surface display_name = 'MCP' / 'service' / etc.
  // Greeting "Good evening, MCP" reads bot-ish — fall back to "there" when
  // the role identifies the user as a service account. Audit L1.
  const isServiceAccount = user?.role === 'service_account';
  const fullName   = (user?.display_name ?? user?.name ?? '').trim();
  const firstName  = !isServiceAccount && fullName
    ? (fullName.split(/\s+/)[0] || 'there')
    : 'there';
  const initials   = parseInitials(user?.display_name ?? user?.name ?? null, user?.email ?? null);
  const today      = new Date();
  const greeting   = greetingFor(today);
  const dateLabel  = formatDate(today, 'long');

  return (
    <header className="home-header">
      <div className="home-header-greeting">
        <div className="home-header-eyebrow">AVERROW · COMMAND CENTER</div>
        <h1 className="home-header-title">
          {greeting},{' '}
          <span style={{ color: M.AMBER, textShadow: `0 0 20px ${M.AMBER}50` }}>
            {firstName}
          </span>
        </h1>
        <div className="home-header-date">{dateLabel}</div>
      </div>

      <div className="home-header-controls">
        <div className="home-header-live" aria-label="Live data feed">
          <div className="home-header-live-dot">
            <div className="home-header-live-ping" />
            <div className="home-header-live-core" />
          </div>
          <span className="home-header-live-label">LIVE</span>
        </div>

        <NotificationBell />

        <button
          type="button"
          onClick={() => navigate('/profile')}
          aria-label={`Open profile — ${user?.display_name ?? user?.name ?? user?.email ?? 'user'}`}
          className="home-header-profile"
        >
          {initials}
        </button>
      </div>

      <style>{`
        .home-header {
          display: flex;
          flex-direction: row;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          padding: 22px 24px 18px;
          border-bottom: 1px solid var(--border-base);
        }
        .home-header-greeting {
          flex: 1;
          min-width: 0;
        }
        .home-header-eyebrow {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.22em;
          color: ${M.AMBER};
          text-shadow: 0 0 12px ${M.AMBER}60;
          margin-bottom: 6px;
        }
        .home-header-title {
          font-size: 24px;
          font-weight: 900;
          line-height: 1.1;
          letter-spacing: -0.6px;
          color: var(--text-primary);
          margin: 0;
        }
        .home-header-date {
          font-size: 11px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          letter-spacing: 0.06em;
          margin-top: 6px;
        }
        .home-header-controls {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-shrink: 0;
        }
        .home-header-live {
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .home-header-live-dot {
          position: relative;
          width: 8px;
          height: 8px;
        }
        .home-header-live-ping {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: #4ade80;
          opacity: 0.65;
          animation: home-header-ping 1.6s ease-in-out infinite;
        }
        .home-header-live-core {
          position: relative;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #22c55e;
          box-shadow: 0 0 8px rgba(34,197,94,0.8);
        }
        .home-header-live-label {
          font-size: 8px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          letter-spacing: 0.18em;
        }
        .home-header-profile {
          width: 36px;
          height: 36px;
          border-radius: 11px;
          background: ${SELF_AVATAR_COLOR};
          color: var(--text-on-amber, #0A0F1E);
          border: 1px solid var(--border-strong);
          box-shadow: 0 4px 14px rgba(0,0,0,0.6), inset 0 1px 0 var(--text-muted), inset 0 -1px 0 rgba(0,0,0,0.30);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 900;
          cursor: pointer;
          padding: 0;
        }
        @keyframes home-header-ping {
          0%, 100% { transform: scale(1);   opacity: 0.65; }
          50%      { transform: scale(2.5); opacity: 0;    }
        }
        @media (prefers-reduced-motion: reduce) {
          .home-header-live-ping { animation: none; }
        }

        /* Wider containers get more breathing room around the band. */
        @container home (min-width: 480px) {
          .home-header { padding: 24px 32px 20px; }
          .home-header-title { font-size: 26px; }
          .home-header-controls { padding-top: 4px; }
        }
      `}</style>
    </header>
  );
}
