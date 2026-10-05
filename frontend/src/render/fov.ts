/**
 * NOVABALL render — gameplay field of view (Hor+).
 *
 * settings.fov is a HORIZONTAL fov defined for a 16:9 screen. Converting it with the live aspect ("Vert-") made
 * ultrawide screens zoom in (32:9 => 40° vertical: the player's own car is clipped) and narrow windows turn into a
 * fisheye (960×1000 => 107° vertical). Instead the vertical fov is the 16:9 one for every aspect >= 16:9 (wider
 * screens simply see more to the sides), and narrower windows widen vertically only up to 90°.
 * 16:9 output is identical by construction.
 */
import { horizontalToVerticalFov } from '../settings';

export const REFERENCE_ASPECT = 16 / 9;
export const MAX_VERTICAL_FOV = 90;

/** Vertical fov (degrees) for a gameplay horizontal fov `hfovDeg` (defined at 16:9) on a screen of `aspect`. */
export function gameplayVerticalFov(hfovDeg: number, aspect: number): number {
  const a = Math.min(Math.max(0.1, aspect), REFERENCE_ASPECT);
  return Math.min(horizontalToVerticalFov(hfovDeg, a), MAX_VERTICAL_FOV);
}
