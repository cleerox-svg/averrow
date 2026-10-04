import * as React from 'react';

/** Wiring a <Field> hands to its control so label/help/error associate by id. */
export interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
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
