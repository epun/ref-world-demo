/**
 * Shared Three.js layer assignments.
 *
 * OVERLAY_LAYER carries screen-reading marks that must not be mangled by the
 * ink composite (toon quantize, exposure ramp, fog/weather washes): today
 * that is the speech bubble, whose emoji render in native color — an
 * explicit user carve-out from the black-and-white ruling (TASTE §6 note).
 *
 * Contract: objects on this layer (and ONLY this layer — `layers.set`, not
 * `enable`) are invisible to the beauty and normal renders, and the ink pass
 * draws them once, unquantized and exposure-exempt, on top of its composite
 * before the grain pass. The full-frame paper grain still covers them, so
 * the frame stays one surface (TASTE §2.7).
 */

/** Layer index for ink-exempt overlay marks (default camera layer is 0). */
export const OVERLAY_LAYER = 1;
