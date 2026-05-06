// Averrow Design System — StateMachineButtons
//
// Horizontal row of pill buttons that visualize an entity's
// state-machine transitions. Promoted from the Incident detail
// page's INVESTIGATING / IDENTIFIED / MONITORING / RESOLVED row;
// generalized so the same primitive can drive Takedown state
// (DRAFT / REQUESTED / SUBMITTED / TAKEN_DOWN), Alert state, or
// any other "current state + clickable transitions" pattern.
//
// Spec amendment from RESTRUCTURE_SPEC.md Bundle C.
//
// The current state renders filled (accent gradient); other states
// render outlined. States outside `reachable` (when provided) render
// disabled — the caller decides which transitions are valid from
// the current state.
//
// Keyboard a11y: each button is a real <button>, focusable in tab
// order, with role and aria-pressed reflecting current state.

import type { ReactNode } from 'react';

export interface StateMachineState<T extends string> {
  value:  T;
  label:  string;
  /** Optional icon rendered before the label. */
  icon?:  ReactNode;
}

export interface StateMachineButtonsProps<T extends string> {
  states:        ReadonlyArray<StateMachineState<T>>;
  current:       T;
  onTransition?: (next: T) => void | Promise<void>;
  /**
   * Subset of states reachable from `current`. States not in this
   * list render disabled. When omitted, all non-current states are
   * clickable.
   */
  reachable?:    ReadonlyArray<T>;
  size?:         'sm' | 'md';
  /**
   * Disables every button (use during in-flight transitions). The
   * current-state highlight is preserved.
   */
  busy?:         boolean;
  className?:    string;
}

const SIZE = {
  sm: { fontSize: 9,  padding: '5px 10px', gap: 4 },
  md: { fontSize: 10, padding: '7px 14px', gap: 6 },
} as const;

export function StateMachineButtons<T extends string>({
  states,
  current,
  onTransition,
  reachable,
  size = 'sm',
  busy = false,
  className,
}: StateMachineButtonsProps<T>) {
  const z = SIZE[size];

  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        gap: z.gap,
        padding: 4,
        borderRadius: 99,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid var(--border-base)',
      }}
      role="group"
      aria-label="State"
    >
      {states.map((s) => {
        const isCurrent  = s.value === current;
        const isAllowed  = !reachable || reachable.includes(s.value);
        const isDisabled = busy || !isAllowed;
        const clickable  = !isDisabled && !isCurrent && !!onTransition;

        return (
          <button
            key={s.value}
            type="button"
            aria-pressed={isCurrent}
            disabled={isDisabled || isCurrent}
            onClick={clickable ? () => void onTransition!(s.value) : undefined}
            style={{
              fontSize:      z.fontSize,
              fontFamily:    'var(--font-mono)',
              fontWeight:    700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              padding:       z.padding,
              borderRadius:  99,
              background:    isCurrent
                ? 'linear-gradient(135deg, var(--amber), var(--amber-dim))'
                : 'transparent',
              color:         isCurrent
                ? '#000'
                : isAllowed
                  ? 'var(--text-secondary)'
                  : 'var(--text-muted)',
              border:        isCurrent
                ? '1px solid var(--amber-border)'
                : '1px solid transparent',
              boxShadow:     isCurrent
                ? '0 4px 12px var(--amber-glow), inset 0 1px 0 rgba(255,255,255,0.30)'
                : 'none',
              cursor:        clickable ? 'pointer' : isCurrent ? 'default' : 'not-allowed',
              opacity:       isAllowed ? 1 : 0.4,
              transition:    'background 0.15s ease, color 0.15s ease',
              whiteSpace:    'nowrap',
              display:       'inline-flex',
              alignItems:    'center',
              gap:           4,
            }}
          >
            {s.icon}
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
