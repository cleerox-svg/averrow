/**
 * Type classes for the Observatory's chrome (toolbar, lens strip, legends, stats bar, map controls).
 *
 * One source for what used to be four copies of a 10px uppercase mono label. The rule (facelift Phase 6):
 *   - sans for labels and prose, mono ONLY for facts (counts, periods like 7D, IDs / IPs / ASNs, coordinates, kbd);
 *   - sentence case, no letter-spaced capitals;
 *   - 12px is the floor in the chrome (`text-type-label`); nothing in these files is set at 10 or 11px.
 * Colour is not part of these: callers set it with a token (`--text-tertiary` for labels, `--text-secondary` for prose).
 */

/** A section heading / field label: sans, 12px, semibold, sentence case. Callers colour it --text-secondary (tertiary is for notes and hints). */
export const LABEL = 'text-type-label font-semibold';

/** Prose and descriptions in dense chrome (legend rows, hints, notes): sans, 12px, regular weight. */
export const BODY = 'text-type-label font-normal';

/** A fact: a count, a period token (7D), an ID, a coordinate, a key hint. Mono, 12px, tabular figures. */
export const FACT = 'font-mono text-type-label font-normal';

/** A fact that is also a control label (period segments, the filter trigger's period). */
export const FACT_STRONG = 'font-mono text-type-label font-semibold';

/** Coarse pointers (touch, stylus) get 44px targets without a JS breakpoint. */
export const COARSE_TARGET = '[@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]';
