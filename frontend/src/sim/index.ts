/**
 * NOVABALL — simulation public entry point.
 *
 * Quick reference (details in each module):
 *   const world = new World(config);            // emits 'countdown' {value: 3} immediately (not in free play)
 *   world.step(inputs);                          // one fixed 1/120 s tick; inputs[carId] (missing ⇒ neutral)
 *   world.drainEvents();                         // SimEvent[] since the last drain (plain-object payloads)
 *   world.writeSnapshot(snap);                   // no allocation; lerpSnapshot(prev, curr, alpha, out) for rendering
 *   world.match / world.cars / world.ball / world.pads   // live state (treat as read-only outside src/sim)
 *   world.hash();                                // FNV-1a over the full state (replay / on-chain verification)
 *   new BallPredictor(4, 1/60).update(world.ball, world.match.surge.gravityScale)  // AI ball path
 *
 * ZERO-G SURGE gravity: match.surge.gravityScale (= world.gravityScale) is the BALL's multiplier (0.3 in a surge).
 * Cars use carGravityScaleFor(ballScale) (= world.carGravityScale; 0.55 in a surge, exactly 1 otherwise):
 * car kinematics (jump / aerial / landing predictions) must use GRAVITY × carGravityScaleFor(gScale).
 *
 * Extra (non-contract) state for bots / tools — cast `world.cars[i] as SimCar`:
 *   fwd / up / left (cached world axes; right = −left), jumpTimer, airJumpTimer, flipActive, jumpLock …
 *   carCanAirJump(car) — can it still double-jump / dodge right now?
 *   (world.match as SimMatchState).kickoffPending — true from a kickoff reset until the first touch.
 */
export { World } from './world';
export type { SimBall } from './world';
export type { SimCar } from './car';
export { carCanAirJump, CAR_BOUND_RADIUS } from './car';
export type { SimMatchState } from './match';
export { carGravityScaleFor } from './match';
export { BallPredictor, predictGoal } from './predict';
export { stepBall, integrateBall, collideBallArena } from './ball';
export type { BallBody } from './ball';
export { lerpSnapshot, copySnapshot, cloneSnapshot, makeSnapshot, copyCarSnapshot, copyBallSnapshot } from './snapshot';
export { Rng } from './rng';
export { curve, integrateQuat, quatForward, quatUp, quatLeft, quatFromHeading } from './vmath';
export * from './constants';
export * from './types';
export * from './arena';
