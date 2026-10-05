// Per-field write versions for optimistic settings saves. Every optimistic
// write bumps the version of the fields it touches; a failing write only
// rolls back fields whose version is still its own, so it can never undo a
// newer pending or successful write. Used by the ops and tenant hosts.

export interface FieldVersions {
  /** Stamp `fields`; returns the stamps to hand back to `isLatest`. */
  bump(fields: string[]): Record<string, number>;
  isLatest(field: string, stamps: Record<string, number> | undefined): boolean;
}

export function createFieldVersions(): FieldVersions {
  const versions = new Map<string, number>();
  return {
    bump(fields) {
      const stamps: Record<string, number> = {};
      for (const f of fields) {
        const n = (versions.get(f) ?? 0) + 1;
        versions.set(f, n);
        stamps[f] = n;
      }
      return stamps;
    },
    isLatest(field, stamps) {
      return stamps !== undefined && versions.get(field) === stamps[field];
    },
  };
}
