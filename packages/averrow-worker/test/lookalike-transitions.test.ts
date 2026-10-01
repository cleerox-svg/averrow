/**
 * `classifyLookalikeTransitions` — the pure core of the detection fix,
 * and Flight Control's pure backlog predicate.
 *
 * Both are value-in / value-out, so they are tested directly rather
 * than through a D1 mock that would only re-assert itself. The
 * end-to-end behaviour each one drives lives in
 * `test/lookalike-first-contact.test.ts` (transitions) and is driven by
 * the real scanner there; this file pins the decisions themselves,
 * including the combinations a live fixture would be tedious to reach.
 */

import { describe, it, expect } from "vitest";
import {
  classifyLookalikeTransitions,
  type LookalikeStoredState,
  type LookalikeObservedState,
} from "../src/scanners/lookalike-domains";
import {
  lookalikeDrainFallingBehind,
  lookalikeParkedSetTooLarge,
} from "../src/agents/flightControl";
import {
  LOOKALIKE_PARKED_WARN_THRESHOLD,
  LOOKALIKE_UNPARK_PER_RUN,
} from "../src/lib/lookalike-budget";

/** A baselined, registered, mail+web row. */
const stored = (over: Partial<LookalikeStoredState> = {}): LookalikeStoredState => ({
  baselineEstablished: true,
  registered: true,
  hasMx: true,
  hasWeb: true,
  ...over,
});

const seen = (over: Partial<LookalikeObservedState> = {}): LookalikeObservedState => ({
  registered: true,
  hasMx: true,
  hasWeb: true,
  ...over,
});

describe("classifyLookalikeTransitions", () => {
  it("first contact short-circuits EVERYTHING", () => {
    // On a never-baselined row the stored `registered` / `has_mx` /
    // `has_web` are the seeder's INSERT DEFAULTS, not observations, so
    // every comparison against them is meaningless. Reading them as "it
    // was absent and now it is present" is the false 0 -> 1 registration
    // migration 0267 exists to prevent — and the reason this branch
    // returns before any of the others can fire.
    for (const observed of [
      seen(),
      seen({ registered: false, hasMx: false, hasWeb: false }),
      seen({ hasMx: false }),
    ]) {
      expect(
        classifyLookalikeTransitions(stored({ baselineEstablished: false, registered: false, hasMx: false, hasWeb: false }), observed),
      ).toEqual(["first_contact"]);
    }
  });

  it("first contact wins even when the stored state looks like a transition", () => {
    // A row with no baseline but a stored `registered = 1` (only
    // reachable by hand, or by a writer that bypassed the checker) must
    // still read as first contact: the discriminator is the baseline
    // column and nothing else.
    expect(
      classifyLookalikeTransitions(
        stored({ baselineEstablished: false, registered: false }),
        seen(),
      ),
    ).toEqual(["first_contact"]);
  });

  it("a 0 -> 1 registration SUBSUMES the mx/web facts", () => {
    // A domain that did not resolve had no MX and no web server by
    // definition, so "it gained MX" is not a separate finding on the
    // pass that saw it appear — it is part of the appearance. Reporting
    // both would double-count, and the mx/web lanes exist specifically
    // for a row that was ALREADY registered when the capability showed
    // up.
    expect(
      classifyLookalikeTransitions(stored({ registered: false, hasMx: false, hasWeb: false }), seen()),
    ).toEqual(["registration_gained"]);
  });

  it("a 1 -> 0 lapse is reported alone", () => {
    expect(
      classifyLookalikeTransitions(stored(), seen({ registered: false, hasMx: false, hasWeb: false })),
    ).toEqual(["registration_lost"]);
  });

  it("reports mx and web gains independently, and both together", () => {
    expect(classifyLookalikeTransitions(stored({ hasMx: false }), seen()))
      .toEqual(["mx_gained"]);
    expect(classifyLookalikeTransitions(stored({ hasWeb: false }), seen()))
      .toEqual(["web_gained"]);
    expect(classifyLookalikeTransitions(stored({ hasMx: false, hasWeb: false }), seen()))
      .toEqual(["mx_gained", "web_gained"]);
  });

  it("reports mx and web losses", () => {
    expect(classifyLookalikeTransitions(stored(), seen({ hasMx: false })))
      .toEqual(["mx_lost"]);
    expect(classifyLookalikeTransitions(stored(), seen({ hasWeb: false })))
      .toEqual(["web_lost"]);
    expect(classifyLookalikeTransitions(stored(), seen({ hasMx: false, hasWeb: false })))
      .toEqual(["mx_lost", "web_lost"]);
  });

  it("reports a gain and a loss on the same pass", () => {
    // A squat that moved its mail off and its web on. Both are real
    // observations and both are persisted; only the gain re-opens the
    // compositor.
    expect(classifyLookalikeTransitions(stored({ hasWeb: false }), seen({ hasMx: false })))
      .toEqual(["web_gained", "mx_lost"]);
  });

  it("an unchanged row is 'none', in both registered states", () => {
    expect(classifyLookalikeTransitions(stored(), seen())).toEqual(["none"]);
    expect(
      classifyLookalikeTransitions(
        stored({ registered: false, hasMx: false, hasWeb: false }),
        seen({ registered: false, hasMx: false, hasWeb: false }),
      ),
    ).toEqual(["none"]);
  });

  it("an UNREGISTERED row's mx/web differences are NOT transitions", () => {
    // A domain that does not resolve cannot meaningfully "have MX". The
    // guard is `stored.registered && observed.registered`, so a stale
    // mx/web flag on an unregistered row does not generate a lane.
    expect(
      classifyLookalikeTransitions(
        stored({ registered: false }),
        seen({ registered: false, hasMx: false, hasWeb: false }),
      ),
    ).toEqual(["none"]);
  });

  it("never returns an empty array — the caller's dispatch is exhaustive", () => {
    // Every branch of the dispatch in `runCheckRows` is reached through
    // an `includes` check, so an empty result would silently skip the
    // row rather than falling through to 'none'.
    for (const r of [true, false]) {
      for (const m of [true, false]) {
        for (const w of [true, false]) {
          for (const b of [true, false]) {
            const out = classifyLookalikeTransitions(
              stored({ baselineEstablished: b, registered: r, hasMx: m, hasWeb: w }),
              seen({ registered: !r, hasMx: !m, hasWeb: !w }),
            );
            expect(out.length, `${b}/${r}/${m}/${w}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe("lookalikeDrainFallingBehind", () => {
  // Newest first, exactly as `ORDER BY recorded_at DESC` returns it.
  const rising = [900, 800, 700, 600];

  it("fires on three consecutive rises while saturated", () => {
    expect(lookalikeDrainFallingBehind({ samples: rising, drainPerTick: 50 })).toBe(true);
  });

  it("does NOT fire when the drain is not saturated", () => {
    // Below the per-tick drain the checker is keeping up with what it is
    // offered, so a rising backlog is a SELECTION problem rather than a
    // capacity one — a different failure class, addressed by the cohort
    // split and its plan assertions, and one this message would
    // misreport.
    expect(lookalikeDrainFallingBehind({ samples: [40, 30, 20, 10], drainPerTick: 50 })).toBe(false);
    // Exactly at the drain is not saturation either: one tick clears it.
    expect(lookalikeDrainFallingBehind({ samples: [50, 40, 30, 20], drainPerTick: 50 })).toBe(false);
  });

  it("does NOT fire when a sample shows the backlog SHRINKING", () => {
    // One dip mid-window is enough to clear the warning: the drain made
    // ground at some point in the last four fresh samples, so "it is
    // taking everything it can and still not getting anywhere" is not a
    // true statement about it. The seeder's inflow is lumpy (~300 rows
    // on the tick it runs, 0 on a tick where every brand it picked was
    // already seeded), which is exactly the jitter this rules out.
    expect(lookalikeDrainFallingBehind({ samples: [900, 800, 850, 860], drainPerTick: 50 })).toBe(false);
  });

  it("DOES fire on a saturated plateau — the gauge is a bounded probe", () => {
    // A deliberate inversion of the previous behaviour, and the reason
    // for it is the gauge, not the predicate. `backlog.lookalike_dns_due`
    // is now `COUNT(*) FROM (SELECT 1 ... LIMIT 51)` per cohort —
    // 102 index reads instead of one per due row, which during the
    // seeder drain was 300K-600K reads/day to produce a boolean.
    //
    // A bounded probe PLATEAUS at its ceiling under real saturation, so
    // requiring a strict rise would have made this predicate dead code
    // in exactly the regime it exists for: pegged, hour after hour,
    // reporting nothing. "Saturated and not shrinking" is what "falling
    // behind" meant all along; the strict rise was a proxy available
    // only while the gauge was unbounded.
    expect(lookalikeDrainFallingBehind({ samples: [102, 102, 102, 102], drainPerTick: 50 })).toBe(true);
    // ...and a plateau BELOW the drain still says nothing, because
    // saturation is still required.
    expect(lookalikeDrainFallingBehind({ samples: [50, 50, 50, 50], drainPerTick: 50 })).toBe(false);
  });

  it("does NOT fire on a draining backlog", () => {
    expect(lookalikeDrainFallingBehind({ samples: [600, 700, 800, 900], drainPerTick: 50 })).toBe(false);
  });

  it("needs enough history, and says so by staying quiet", () => {
    // During the first three ticks after a deploy there is nothing to
    // compare against. Silence is the correct output, not a guess.
    for (const n of [0, 1, 2, 3]) {
      expect(lookalikeDrainFallingBehind({ samples: rising.slice(0, n), drainPerTick: 50 }), `${n} samples`)
        .toBe(false);
    }
  });

  it("minSamples is tunable, and a stricter setting needs more history", () => {
    expect(lookalikeDrainFallingBehind({ samples: rising, drainPerTick: 50, minSamples: 1 })).toBe(true);
    // `rising` holds 4 samples, so 4 comparisons need 5 — silence, not a
    // guess, when the history is short.
    expect(lookalikeDrainFallingBehind({ samples: rising, drainPerTick: 50, minSamples: 4 })).toBe(false);
  });
});

describe("lookalikeParkedSetTooLarge", () => {
  // `backlog.lookalike_parked` had a gauge and NO threshold, so a
  // growing parked set was visible only to an operator who thought to
  // read the number — while the one warning that did exist is keyed on
  // the DUE backlog, which PARKING REDUCES. A DNS outage severe enough
  // to park a cohort therefore pushed the only alarm in the silencing
  // direction.

  it("is quiet at and below the threshold, and warns above it", () => {
    const threshold = LOOKALIKE_PARKED_WARN_THRESHOLD;
    expect(lookalikeParkedSetTooLarge({ parked: 0, threshold })).toBe(false);
    expect(lookalikeParkedSetTooLarge({ parked: threshold, threshold })).toBe(false);
    expect(lookalikeParkedSetTooLarge({ parked: threshold + 1, threshold })).toBe(true);
  });

  it("the production threshold sits below a DAY of un-park capacity", () => {
    // The arithmetic behind the number, asserted rather than left in
    // prose: below the threshold the sweep turns the whole parked set
    // over inside a day, so crossing it genuinely means the set is
    // growing faster than the lane that recovers it. If either constant
    // moves, this is what notices the relationship broke.
    expect(LOOKALIKE_PARKED_WARN_THRESHOLD)
      .toBeLessThan(LOOKALIKE_UNPARK_PER_RUN * 24);
  });
});
