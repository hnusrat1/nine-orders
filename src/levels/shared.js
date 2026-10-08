// Story timing shared by neighbouring levels so cross-fades line up.
import { smooth } from '../journey.js';

// The chosen photon is frozen this far (mm) up its path when time stops.
export const PHOTON_R0 = 300;
// Photon travel in room-story time: leaves at 24 s, reaches the interaction at 44 s.
export const PHOTON_T0 = 24, PHOTON_T1 = 44;
export function photonRemaining(Troom) {
  return PHOTON_R0 * (1 - smooth((Troom - PHOTON_T0) / (PHOTON_T1 - PHOTON_T0)));
}
