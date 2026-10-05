import * as React from 'react';

/** Wiring a <Field> hands to its control so label/help/error associate by id. */
export interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  /** A control that carries its own `id` registers it so label/help/error follow it. */
  setControlId?: (id: string | undefined) => void;
}

export const FieldContext = React.createContext<FieldContextValue | null>(null);

export function useFieldContext(): FieldContextValue | null {
  return React.useContext(FieldContext);
}

/** Join aria-describedby tokens, dropping empties. */
export function joinIds(...ids: Array<string | undefined | false>): string | undefined {
  const out = ids.filter((v): v is string => typeof v === 'string' && v.length > 0).join(' ');
  return out.length > 0 ? out : undefined;
}

/**
 * Resolve a control's id inside a <Field>. A custom `id` is registered back to
 * the Field so `<label for>` and the help/error ids point at the real control.
 */
export function useFieldControlId(ownId: string | undefined): string | undefined {
  const field = useFieldContext();
  const register = field?.setControlId;
  React.useLayoutEffect(() => {
    if (!register || !ownId) return undefined;
    register(ownId);
    return () => register(undefined);
  }, [register, ownId]);
  return ownId ?? field?.id;
}
