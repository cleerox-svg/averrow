// @averrow/shared/ui motion kit (P3-4). All moves no-op without data-accent.
export {
  MOTION, EASE_STANDARD, SPRING_LINEAR, springEasing,
  isMotionOn, prefersReducedMotion, useMotionOn, play, fadeIn,
} from './motion';
export { useGlideIndicator, type GlideOptions } from './useGlideIndicator';
export { NavIndicator, type NavIndicatorProps } from './NavIndicator';
export { usePageSlide } from './usePageSlide';
export { useArrivalFlash } from './useArrivalFlash';
