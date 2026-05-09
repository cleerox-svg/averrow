// Thin wrapper around useVersionToggle for the Observatory surface.
// Preserved as its own export to avoid touching the 5 existing call
// sites (Sidebar, MobileNav, Observatory, ObservatoryV3, the toggle
// component). New surfaces should call useVersionToggle directly.

import { useVersionToggle, pathForVersion } from './useVersionToggle';
import type { Version } from './useVersionToggle';

export type ObservatoryVersion = Version;

export function pathForObservatoryVersion(version: ObservatoryVersion): string {
  return pathForVersion('observatory', version);
}

export function useObservatoryVersion() {
  return useVersionToggle('observatory');
}
