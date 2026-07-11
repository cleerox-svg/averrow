// ─── Canonical "agent online" predicate ────────────────────────────────
//
// Single source of truth for what counts as an "online" / "operational"
// agent. Historically this diverged: the Agents page (Agents.tsx) used
// `status !== 'error'`, StatGrid matched it (per audit C4, 2026-05-06),
// but ModuleHub kept an older, stricter `healthy | running | active`
// check — so the Home page showed two different "agents online" numbers
// for the same `agents` array (design-review finding, 2026-07-11).
//
// This is now the ONLY place that definition may live. Every surface
// that needs an online/operational count — Agents.tsx, StatGrid.tsx,
// ModuleHub.tsx, or any future one — must import from here instead of
// re-deriving the filter inline.
import type { Agent } from '@/hooks/useAgents';

/** True for any agent status other than 'error'. Mirrors the Agents
 *  page's original "operational" definition — an agent is considered
 *  online unless it's actively erroring, regardless of whether it's
 *  currently idle/running/healthy. */
export function isAgentOnline(agent: Pick<Agent, 'status'>): boolean {
  return agent.status !== 'error';
}

/** Count of online agents in a list, per `isAgentOnline`. */
export function countAgentsOnline(agents: ReadonlyArray<Pick<Agent, 'status'>>): number {
  return agents.filter(isAgentOnline).length;
}
