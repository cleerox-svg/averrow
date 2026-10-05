/**
 * Lookalike alert POLICY — when a `lookalike_domain_active` alert may
 * exist at all, and what it is allowed to carry.
 *
 * ── THE PRODUCERS, ENUMERATED ───────────────────────────────────────
 *
 * FOUR files call `createAlert` with `alertType:
 * 'lookalike_domain_active'`, across FIVE configured sources. Verified
 * by repo-wide grep, not by memory — this docstring has now been wrong
 * twice about its own count:
 *
 *   1. `scanners/lookalike-domains.ts:845`      registration checker
 *   2. `scanners/lookalike-page-analysis.ts:461` page-verdict pass
 *   3. `lib/alert-backfill.ts:186`               claim-time backfill
 *   4. `lib/phantom-matcher.ts:271`              phantom-hit matcher,
 *      reached from TWO of its three `SOURCE_CONFIG` entries
 *      (`nrd:117` and `lookalike:138`; the `ct` entry files
 *      `ct_certificate_issued` instead through the same call).
 *
 * The first three go through `clearsLookalikeAlertFloor` below. The
 * fourth is a DOCUMENTED EXEMPTION with a stated bound — see
 * `PHANTOM_MATCH_ALERT_SEVERITY`.
 *
 * Producer 1 has a SECOND documented exemption (owner decision
 * 2026-10-05): a CONFIRMED NEW REGISTRATION files at MEDIUM even below the
 * HIGH floor — see `NEW_REGISTRATION_ALERT_SEVERITY` and
 * `newRegistrationAlertSeverity`. Every other producer-1 path (first-contact
 * baseline, mx/web gains, the mail+web catch-up) still goes through
 * `clearsLookalikeAlertFloor`.
 *
 * Producer 3 was the previous correction: this docstring said "ONE
 * definition, imported by BOTH producers" and the floor's own text said
 * "on either producer path", and both were false — `alert-backfill.ts`
 * filed at a hardcoded `medium`, selected on `created_at` with no
 * `registered` filter, up to 100 per claimed brand, with
 * `bypassTierGate: true`. Widening the seeder to 1,867 brands turned
 * that into a burst of MEDIUM alerts about domains that were not even
 * registered, on the one surface a brand-new tenant sees first. It now
 * imports `clearsLookalikeAlertFloor` and derives its severity from the
 * row's already-composited `threat_level` rather than a constant. THERE
 * IS NO BACKFILL EXEMPTION, deliberately — see the note at that call
 * site for why a claim-time batch is the worst rather than the best case
 * for one.
 *
 * Producer 4 is this round's correction, and it makes the point sharper
 * than the sentence it replaces. That sentence read: "A FOURTH producer
 * is a contradiction in terms, not a possibility to plan for: whatever
 * files this alert type imports from here." `lib/phantom-matcher.ts`
 * was already in the repository, filing this type at a hardcoded
 * `severity: "low"` with no import from this module — so the claim was
 * falsified by a file that predated it. An assertion about a codebase is
 * not an invariant; the enumeration above and the tests that pin it are.
 *
 * ADDING A PRODUCER: import from here. Either call
 * `clearsLookalikeAlertFloor`, or add an exemption constant alongside
 * `PHANTOM_MATCH_ALERT_SEVERITY` that states its bound, and add yourself
 * to the list above. A producer that does neither is the defect.
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
 * A stored `lookalike_domains.threat_level` as a typed level.
 *
 * NULL / an unrecognised value floors to LOW rather than to the table's
 * `DEFAULT 'LOW'` by coincidence: both producers use this value as the
 * BASELINE a monotonic persist may never go below, so the safe default
 * is the one that cannot suppress a later escalation.
 *
 * Shared because both producers need it and a second copy would be the
 * third: `scanners/lookalike-page-analysis.ts` had a private
 * `normalizeLevel` and the checker's re-entrant compositor needs the
 * same function, which is how THREAT_LEVEL_RANK came to have three
 * copies before it moved here.
 */
export function normalizeThreatLevel(raw: string | null): PageThreatLevel {
  const v = (raw ?? 'LOW').toUpperCase();
  return v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL' ? (v as PageThreatLevel) : 'LOW';
}

/**
 * The severity floor for `lookalike_domain_active` alerts.
 *
 * Below this level NO alert row is created — on producers 1-3 of the
 * four listed in this module's docstring. Producer 4 is exempt; see
 * `PHANTOM_MATCH_ALERT_SEVERITY`. So is producer 1's confirmed-new-
 * registration path; see `NEW_REGISTRATION_ALERT_SEVERITY`.
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
 * exactly as it does to the widened 1,867-brand one. (This sentence
 * previously said "362-brand", a figure from the intermediate
 * `monitoring_status='active'` staging draft that never shipped.)
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
 * All three producers call THIS, never an inline comparison — a floor
 * written twice is a floor that drifts, and the failure mode of drift
 * here is silent (one path keeps filing MEDIUMs and nobody notices until
 * the queue does). That is not hypothetical: it is exactly what
 * `alert-backfill.ts` did for the whole first draft of this change.
 *
 * Lane 3: this can only ever WITHHOLD an alert, never dismiss one. A
 * withheld row keeps its persisted verdict and stays eligible for the
 * page-analysis producer to alert on later (spec §4.3).
 */
export function clearsLookalikeAlertFloor(level: PageThreatLevel): boolean {
  return THREAT_LEVEL_RANK[level] >= THREAT_LEVEL_RANK[LOOKALIKE_ALERT_SEVERITY_FLOOR];
}

/**
 * THE ONE DOCUMENTED EXEMPTION from `LOOKALIKE_ALERT_SEVERITY_FLOOR`:
 * the severity `lib/phantom-matcher.ts` (producer 4) files its
 * phantom-hit alerts at.
 *
 * Producer 4 does NOT call `clearsLookalikeAlertFloor`, and applying the
 * floor to it would be wrong in both available directions. Withholding
 * the alert would delete the phantom lane's only output — a `low`
 * monitoring alert is the entire deliverable of Wave 2 §6.1, and the
 * enumerator already never writes `threats` and never alerts. Raising
 * the severity to HIGH to clear the floor would contradict §6.2: a
 * phantom hit says "a domain our LLM predicted would be hallucinated for
 * this brand has now been independently observed", which is a
 * monitoring signal, not a confirmed active phish.
 *
 * ── THE BOUND, which is why the exemption is affordable ─────────────
 *
 * The floor's argument is queue arithmetic, not taste (see its
 * docstring): ~8,941 alerts already unworked, ~36/week intake, and no
 * triage rule that can ever auto-clear this family, so every alert it
 * files is permanent manual work. That argument applies to producers
 * 1-3 because their populations are unbounded in the relevant sense —
 * 56,010 candidate rows re-checked on a 24 h cadence, and up to 100 per
 * brand claim.
 *
 * Producer 4's is bounded by construction, twice over:
 *
 *   * AT MOST ONE alert per `phantom_domains` row, EVER. The alert is
 *     gated behind a guarded `UPDATE ... WHERE id = ? AND status =
 *     'predicted'` claim that runs BEFORE `createAlert`, so a second
 *     matcher pass, a second source hitting the same phantom, and a
 *     re-run of the endpoint all find 0 changed rows and file nothing.
 *   * The population is `phantom_domains` at `status = 'predicted'`,
 *     written only by `agents/phantomEnumerator.ts` — a `trigger:
 *     "manual"` agent with one bounded Haiku pass per monitored-tier
 *     brand. It is not a permutation table and it does not grow on a
 *     cron.
 *
 * So the lifetime ceiling on this producer is "one alert per phantom
 * ever enumerated", which an operator controls directly by choosing to
 * run the enumerator. That is a different kind of quantity from a
 * cron-driven re-check, and the reason this is an exemption rather than
 * a hole.
 *
 * Imported by the matcher instead of being a bare literal there so that
 * (a) a future change to the floor puts the reader in front of this
 * note, and (b) the exemption is visible from the policy module rather
 * than only discoverable by grep — which is exactly how producer 4 went
 * unnoticed while the docstring claimed it could not exist.
 */
export const PHANTOM_MATCH_ALERT_SEVERITY = 'low';

/**
 * THE SECOND DOCUMENTED EXEMPTION from `LOOKALIKE_ALERT_SEVERITY_FLOOR`
 * (owner decision 2026-10-05): the minimum severity of a CONFIRMED NEW
 * REGISTRATION alert, filed by the registration checker
 * (`scanners/lookalike-domains.ts`, producer 1) with the title "New
 * lookalike domain registered: <domain>".
 *
 * ── Why the floor was wrong for this one finding ────────────────────
 *
 * The floor withholds everything below HIGH, and a freshly registered
 * squat is almost never HIGH on the day it appears: it is parked, with no
 * mail and no web content yet, so the compositor puts it at LOW/MEDIUM.
 * Under the floor alone the platform therefore had NO "newly registered
 * lookalike" alert at all — the registration was recorded
 * (`first_seen`, `alerts_withheld_below_floor`) and nobody was told. A
 * registration is the earliest point at which a takedown or a block is
 * cheap, which is the whole reason to watch permutations.
 *
 * ── What counts as CONFIRMED ────────────────────────────────────────
 *
 * Exactly two pieces of evidence (`lookalike_domains.registration_
 * evidence`, migration 0282):
 *
 *   'observed'  the DNS checker saw `registered 0 -> 1` on a row it had
 *               ALREADY baselined as unregistered — a transition, not a
 *               first contact.
 *   'nrd'       the domain appeared in the registries' newly-registered
 *               list (`nrd_domains`, lib/lookalike-nrd-matcher.ts) no
 *               earlier than 30 days ago, on a row we had not already
 *               observed registered before that date.
 *
 * A first-contact baseline ("it resolves, we cannot say since when") is
 * NOT confirmed and stays under the floor — that is the seeder backlog the
 * floor exists for.
 *
 * NOT ALERTED even when confirmed: a row an analyst marked `benign` or
 * `taken_down` (same rule as the mail+web catch-up), and an NRD-dated row
 * while DNS answers NXDOMAIN (a registrar-deleted fraudulent registration,
 * or one not yet published) — held and retried within the 30-day window.
 *
 * ── THE BOUND ───────────────────────────────────────────────────────
 *
 *   * AT MOST ONE new-registration alert per lookalike row per
 *     registration event: `registration_alerted_at` is claimed with a
 *     guarded `WHERE ... IS NULL` UPDATE before `createAlert` runs, and
 *     is cleared only by an ANSWERED NXDOMAIN lapse (DoH Status 3 on a
 *     registered row; NODATA is not a lapse), which also clears
 *     `registration_evidence` — so a lapsed row can never re-read as a
 *     pending NRD registration, and a re-registration after a lapse
 *     (typically a new registrant, re-dated to the day we see it) is a new
 *     event, and nothing else is.
 *   * The population is real registrations of permutations of monitored
 *     brands, not the permutation table: a few per day platform-wide, not
 *     a re-check of 56K rows. And `createAlert`'s tier gate still applies
 *     (no alert for `tracked` brands).
 *
 * When the composed level already clears the floor (mail+web, BIMI, a
 * phishing page) the alert carries THAT level; MEDIUM is a floor for this
 * finding, never a cap.
 */
export const NEW_REGISTRATION_ALERT_SEVERITY: PageThreatLevel = 'MEDIUM';

/** Where a confirmed registration came from (migration 0282). */
export type RegistrationEvidence = 'nrd' | 'observed';

/**
 * The severity a confirmed-new-registration alert files at: the composed
 * level when it clears the HIGH floor, else `NEW_REGISTRATION_ALERT_SEVERITY`.
 * Never withholds — that is the exemption.
 */
export function newRegistrationAlertSeverity(effective: PageThreatLevel): PageThreatLevel {
  return THREAT_LEVEL_RANK[effective] >= THREAT_LEVEL_RANK[NEW_REGISTRATION_ALERT_SEVERITY]
    ? effective
    : NEW_REGISTRATION_ALERT_SEVERITY;
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
