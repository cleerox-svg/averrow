// Backward-compat alias around the generic VersionToggle.
// Existing call sites (Observatory, ObservatoryV3) keep using this
// import; new surfaces should reach for VersionToggle directly.

import { VersionToggle } from './VersionToggle';

export function ObservatoryVersionToggle() {
  return <VersionToggle surface="observatory" ariaLabel="Observatory engine" />;
}
