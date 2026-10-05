/**
 * NOVABALL AI — grid axes of the measured travel-time table (see travelTable.ts, generated).
 */
/** Start forward speed (m/s; negative = rolling backward). */
export const TT_V: ReadonlyArray<number> = [-8, -4, 0, 4, 8, 12, 16, 20, 23];
/** Target angle off the nose (degrees, symmetric left/right). */
export const TT_A: ReadonlyArray<number> = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180];
/** Horizontal distance car center → target (m). */
export const TT_D: ReadonlyArray<number> = [2, 4, 6, 9, 13, 18, 25, 33];
/** Boost in the tank. */
export const TT_B: ReadonlyArray<number> = [0, 30, 100];
