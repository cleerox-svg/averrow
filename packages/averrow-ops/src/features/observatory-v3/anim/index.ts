/** Observatory animation engine: GPU-driven, uniform-only-per-frame primitives. */

export { PulseExtension, type PulseExtensionProps } from './pulse-extension';
export { RingExtension, type RingExtensionProps } from './ring-extension';
export { RingMaskExtension, type RingMaskExtensionProps } from './ring-mask-extension';
export { DashFlowExtension, cumulativeDistances, type DashFlowExtensionProps } from './dash-flow-extension';
export { RingBuffer, ringBufferLayerProps, DEFAULT_RING_CAPACITY, type RingSpawn } from './ring-buffer';
export { ImpactRingSpawner, type ImpactRingOptions } from './impact-rings';
export { ArrivalScheduler, buildArrivalEvents, type ArrivalEvent } from './arrivals';
export { useDeckFrame, type DeckFrame, type UseDeckFrameOptions, type UseDeckFrameResult } from './use-deck-frame';
export {
  pulseRateForSeverity, pulseAmpForSeverity, phaseForKey, type PulseSeverity,
} from './pulse';
export {
  pulseScale, ringMaskVisible, RING_MASK_DASH_DUTY, ringState, ringScale, ringAlpha, ringActive, ringProgress, ringAge, easeOutCubic, dashVisible, glslMod,
  type RingState,
} from './shader-math';
export {
  greatCirclePath, greatCirclePath3D, greatCircleAngle, splitAtAntimeridian, normalizeLng,
  arcAltitude, arcPeakAltitude, MAX_GREAT_CIRCLE_SEGMENTS, EARTH_RADIUS_M, type LngLatAlt,
} from './great-circle';
export {
  COUNTRY_CODES, COUNTRY_COUNT, COUNTRY_POSITIONS, countryIndex, countryCodeAt, countryCentroidAt, countryValueArray,
} from './country-index';
