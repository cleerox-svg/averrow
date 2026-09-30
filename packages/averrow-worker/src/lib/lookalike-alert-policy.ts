/**
 * Lookalike alert POLICY — when a `lookalike_domain_active` alert may
 * exist at all, and what it is allowed to carry.
 *
 * ONE definition, imported by BOTH producers:
 *   - `scanners/lookalike-domains.ts`      (the registration checker)
 *   - `scanners/lookalike-page-analysis.ts` (the page-verdict pass)
 *
 * ── Why lib/ and not beside either producer ─────────────────────────
 *
 * Same hazard `lib/monitored-brands.ts` was created for, and the same
 * answer. `scanners/lookalike-domains.ts` already imports
 * `runPageAnalysisForDomain` from `scanners/lookalike-page-analysis.ts`,
 * so exporting policy from the page-analysis module would make the
 * dependency bidirectional. TypeScript accepts such a cycle and it would
 * work today — every use below sits inside a function body, where ESM
 * live bindings have resolved by call time — but a module-scope read of
 * `LOOKALIKE_ALERT_SEVERITY_FLOOR` on the wrong side of the cycle would
 * see `undefined` in its temporal dead zone, and a floor that silently
 * reads `undefined` fails OPEN: every comparison against it is false, so
 * every alert is withheld and nothing throws. A neutral module removes
 * the hazard instead of documenting it.
 *
 * It is also the better conceptual home. The floor is not a
 * page-analysis concept — the checker path has no page in it at all —
 * and it is not a scoring concept either, which is why it does not live
 * in `page-phishing-scorer.ts` (that module is pure page -> verdict and
 * must stay ignorant of what we do with the verdict).
 *
 * Everything here is PURE: no env, no DB, no fetch, no clock.
 */

import { escalateThreatLevelForPage } from './page-phishing-scorer';
import type { PagePhishingResult, PageThreatLevel } from './page-phishing-scorer';

/** Rank for ordered comparisons between threat levels. */
export const THREAT_LEVEL_RANK: Record<PageThreatLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/**
 * The severity floor for `lookalike_domain_active` alerts.
 *
 * Below this level NO alert row is created — on either producer path.
 * Everything else is still persisted: `threat_level`, `ai_assessment`,
 * and the whole page-analysis column family. THE DATA IS THE
 * DELIVERABLE; THE ALERT IS THE NOTIFICATION, and the two had been
 * conflated.
 *
 * ── This CHANGES EXISTING BEHAVIOUR ─────────────────────────────────
 *
 * MEDIUM alerts on genuine `registered 0 -> 1` transitions stop being
 * created. That is not a side effect of widening the population, it is
 * the requested change, and it applies to the 3-brand legacy population
 * exactly as it does to the 362-brand one.
 *
 * The reason is queue arithmetic, not taste. Measured in production:
 * 8,941 alerts already unworked, platform-wide intake ~36/week, and
 * all 56 lookalike alerts ever created still sitting at `status='new'`.
 * `createAlert` has no dedupe, and `lookalike_domain_active` matches no
 * branch of `createAlert`'s triage dispatch (that switches on
 * `sourceType === 'threat'` or on the three impersonation types; this
 * family is `sourceType: 'lookalike_scanner'`), so there is no rule that
 * can ever clear one automatically — see spec §11.1's verified note.
 * Every alert this family files is permanent manual work. A MEDIUM
 * finding does not earn that; it earns a row in the table an analyst can
 * sort and filter, which it still gets.
 *
 * HIGH is where the checker's own compositor already places "mail AND
 * web on a domain that exists to be mistaken for someone else's", and
 * where `escalateThreatLevelForPage` places a strong page score.
 * CRITICAL is credential harvest. Those are the two statements worth
 * waking someone for.
 */
export const LOOKALIKE_ALERT_SEVERITY_FLOOR: PageThreatLevel = 'HIGH';

/**
 * May a `lookalike_domain_active` alert be created at this severity?
 *
 * Both producers call THIS, never an inline comparison — a floor written
 * twice is a floor that drifts, and the failure mode of drift here is
 * silent (one path keeps filing MEDIUMs and nobody notices until the
 * queue does).
 *
 * Lane 3: this can only ever WITHHOLD an alert, never dismiss one. A
 * withheld row keeps its persisted verdict and stays eligible for the
 * page-analysis producer to alert on later (spec §4.3).
 */
export function clearsLookalikeAlertFloor(level: PageThreatLevel): boolean {
  return THREAT_LEVEL_RANK[level] >= THREAT_LEVEL_RANK[LOOKALIKE_ALERT_SEVERITY_FLOOR];
}

/**
 * Does a page verdict clear the bar `escalateThreatLevelForPage` already
 * treats as PHISHING, as opposed to merely suspicious?
 *
 * Derived by CALLING that function rather than restating its numbers: it
 * is the single source of truth for what a page score means, and a
 * threshold copied to a second site would drift from it. Escalating from
 * the LOW floor isolates the page verdict from whatever level the row
 * already carries — otherwise a row that is already HIGH for unrelated
 * infrastructure reasons would "clear the bar" on a page score of zero.
 *
 * The MEDIUM branches are deliberately NOT the bar. A moderate score and
 * a bare anti-bot wall both mean "worth looking at", which is what the
 * row's own `threat_level` records.
 *
 * Lane 3: reads `score` / `credentialHarvest` / the fired `anti_bot_wall`
 * key only — never `aiSignals`, never `scoreDelta`. Shadow stays shadow
 * (spec §4.3), and the only thing this predicate can do is RAISE.
 */
export function pageVerdictClearsPhishingBar(phishing: PagePhishingResult): boolean {
  const fromFloor = escalateThreatLevelForPage('LOW', {
    score: phishing.score,
    credentialHarvest: phishing.credentialHarvest,
    antiBotWall: phishing.signals.includes('anti_bot_wall'),
  });
  return THREAT_LEVEL_RANK[fromFloor] >= THREAT_LEVEL_RANK.HIGH;
}

/**
 * Page-analysis evidence carried on a `lookalike_domain_active` alert
 * (Lane 3 Phase 3 step 16).
 *
 * Purely descriptive — the alert's severity is the composed
 * `threat_level`, and nothing here is read by `createAlert`'s auto-triage
 * dispatch (see the floor's docstring for why that dispatch never
 * reaches this family). The Lane 3 shadow fields remain shadow:
 * `page_score` below is the pre-Lane-3 score and `page_score_delta` is
 * NOT folded into it.
 */
export interface PageEvidenceDetails {
  /** Fired scored-signal keys — closed vocabulary (`SIGNAL_WEIGHTS`). */
  page_signals: string[];
  /** 0-100 deterministic page score. */
  page_score: number;
  /** `turnstile|recaptcha|hcaptcha|cf_challenge|js_challenge`, or null. */
  page_anti_bot_wall: string | null;
  /** Fired Lane 3 shadow-signal keys — closed vocabulary (`ShadowSignalKey`). */
  page_ai_signals: string[];
  /** Shadow-only would-be contribution. NEVER added to `page_score`. */
  page_score_delta: number;
}

/**
 * Build the page-evidence slice of an alert's `details`.
 *
 * Returns an EMPTY object when page analysis didn't run (no web server,
 * inline budget exhausted) or failed (SSRF block, non-HTML, network
 * error) — `phishing` is null in all of those cases. Alert creation must
 * never depend on this having fired, so the caller spreads the result.
 *
 * Deliberately carries KEYS ONLY. `phishing.evidence` (matched literals
 * lifted verbatim from attacker-controlled page content), `exfilSink`
 * (attacker-controlled hostname) and `exfilSinkId` are omitted: alert
 * `details` fans out to customer-facing surfaces and email digests, and
 * every field above has a closed vocabulary that those sinks can render
 * without escaping concerns. The full evidence stays staff-only on
 * `lookalike_domains` (see `handlers/tenantDomainModule.ts`).
 */
export function buildPageEvidenceDetails(
  phishing: PagePhishingResult | null,
): Partial<PageEvidenceDetails> {
  if (!phishing) return {};
  return {
    page_signals:       phishing.signals,
    page_score:         phishing.score,
    page_anti_bot_wall: phishing.antiBotWallFamily,
    page_ai_signals:    phishing.aiSignals,
    page_score_delta:   phishing.scoreDelta,
  };
}
