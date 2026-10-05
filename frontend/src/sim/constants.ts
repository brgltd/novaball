/**
 * NOVABALL — simulation constants. SINGLE SOURCE OF TRUTH for gameplay tuning.
 *
 * Units: meters, seconds, kilograms, radians.
 * World frame: +Y up. Field long axis = Z (goals at z = ±ARENA.halfLength), width = X.
 * Team 0 (VOLT, cyan) defends the -Z goal and attacks +Z.
 * Team 1 (BLAZE, orange) defends the +Z goal and attacks -Z.
 * Car local frame: +Z forward, +Y up, +X left  (so right = forward × up = -X).
 *
 * The sim agent may tune numeric VALUES here, but must not rename or remove keys
 * (render / AI / UI code reads them).
 */

export const SIM_HZ = 120;
export const DT = 1 / SIM_HZ;

/** Downward gravity acceleration (m/s²), applied along -Y. */
export const GRAVITY = 6.5;

export const ARENA = {
  halfWidth: 36, // side walls at x = ±36
  halfLength: 50, // end walls / goal lines at z = ±50
  height: 20, // ceiling at y = 20
  cornerRadius: 14, // top-down rounding of the 4 vertical corners
  edgeRadius: 4, // fillet (drive-up ramp) between floor/ceiling and walls
  goalHalfWidth: 8.5, // goal mouth spans x ∈ [-8.5, 8.5]
  goalHeight: 6.5, // goal mouth spans y ∈ [0, 6.5]
  goalDepth: 8, // goal box extends 8 m behind the goal line
  goalInnerRadius: 1.2, // interior fillet radius inside the goal box
  goalFrameRadius: 0.3, // radius of the (collidable) goal frame tubes: crossbar, posts, base arcs
} as const;

export const BALL = {
  radius: 1.0,
  mass: 30,
  maxSpeed: 60,
  maxAngularSpeed: 6,
  airDrag: 0.03, // v *= (1 - airDrag * dt)
  restitution: 0.6, // normal bounce coefficient against the arena
  surfaceFriction: 0.35, // Coulomb friction coefficient against the arena (drives spin/rolling)
  rollingDrag: 0.25, // extra linear deceleration (m/s²) while rolling on a surface
  /** Kickoff: ball rests at the center of the field. */
  spawn: { x: 0, y: 1.0, z: 0 },
} as const;

export const CAR = {
  /** Hitbox half extents in car local space: x = half width, y = half height, z = half length. */
  halfExtents: { x: 0.46, y: 0.2, z: 0.66 },
  mass: 180,
  /** Distance from the car origin (hitbox center) to the surface when hovering at rest. Hover gap = rideHeight - halfExtents.y. */
  rideHeight: 0.45,
  /** Hover field acts while the surface is within rideHeight + hoverReach. */
  hoverReach: 0.35,
  /** Hover spring (acceleration per meter of compression, 1/s²) and damping (1/s). */
  hoverStiffness: 1000,
  hoverDamping: 60,
  /** Mag-grip: acceleration pulling a grounded car toward its surface (< GRAVITY so cars fall off ceilings). */
  stickyAccel: 3.25,
  /** Rate (1/s²-ish) at which a grounded car's up axis is aligned to the surface normal, and its damping. */
  alignStiffness: 180,
  alignDamping: 24,

  maxSpeed: 23,
  supersonicSpeed: 21.5, // becomes supersonic at/above this speed
  supersonicHoldSpeed: 20.5, // stays supersonic while above this (hysteresis)
  maxThrottleSpeed: 14.1, // throttle alone can't exceed this
  /** Ground throttle acceleration as a function of forward speed: [speed, accel] pairs (linear interpolation). */
  throttleAccelCurve: [
    [0, 16],
    [14, 1.6],
    [14.1, 0],
  ] as ReadonlyArray<readonly [number, number]>,
  brakeAccel: 35,
  coastDecel: 5.25,
  reverseMaxSpeed: 14,
  boostAccel: 10.5, // ground and air
  airThrottleAccel: 0.67,
  boostConsumption: 33.3, // per second
  boostMax: 100,
  boostStart: 33,
  /** Turning curvature (1/m) as a function of forward speed: [speed, curvature]. Yaw rate = speed × curvature × steer. */
  steerCurvature: [
    [0, 0.69],
    [5, 0.398],
    [10, 0.235],
    [15, 0.1375],
    [17.5, 0.11],
    [23, 0.088],
  ] as ReadonlyArray<readonly [number, number]>,
  /** Max lateral (sideways) friction acceleration on a surface; reduced while powersliding. */
  lateralGrip: 60,
  powerslideGrip: 9,

  jumpImpulse: 2.92, // m/s along car up, on jump press
  jumpHoldAccel: 14.58, // m/s² along car up while jump is held...
  jumpHoldTime: 0.2, // ...for at most this long
  jumpMinTime: 0.025, // hover field stays disabled at least this long after a jump
  doubleJumpWindow: 1.25, // seconds after leaving the ground in which a 2nd jump / dodge is allowed
  dodgeImpulse: 5.0, // horizontal m/s added in the dodge direction
  dodgeDuration: 0.65, // flip rotation / air-control lockout duration
  dodgeDeadzone: 0.5, // min stick magnitude for a 2nd jump to become a dodge

  airPitchTorque: 12.46, // rad/s²
  airYawTorque: 9.11,
  airRollTorque: 38.34,
  airPitchDamp: 2.8, // 1/s (applied scaled by 1 - |input|)
  airYawDamp: 1.9,
  airRollDamp: 4.47,
  maxAngularSpeed: 5.5,

  /** Seconds a demolished car waits before respawning. */
  respawnTime: 3,
  /**
   * A turtled car (on its roof / side, any speed) self-rights on a jump press (or automatically after a short wait):
   * it hops off the surface at this speed (m/s; × √(gravity scale) in ZERO-G SURGEs) while rolling back onto its wheels.
   */
  selfRightImpulse: 2.4,
} as const;

/** Car–ball interaction tuning ("strike assist" — makes hits feel punchy and aimable). */
export const HIT = {
  /** Car–ball physical restitution (low: the extra impulse does the work). */
  restitution: 0.05,
  /** Vertical component of the car→ball direction is scaled by this before normalizing (flatter shots). */
  verticalScale: 0.4,
  /** Blend of car-forward into the hit direction (aim assist). 0 = pure positional, 1 = pure forward. */
  forwardBias: 0.2,
  /** Extra ball speed = relSpeed × factor(relSpeed): [relSpeed, factor] pairs. */
  factorCurve: [
    [0, 0.35],
    [3, 0.6],
    [6, 0.9],
    [23, 0.8],
    [46, 0.45],
  ] as ReadonlyArray<readonly [number, number]>,
  maxRelSpeed: 46,
  /** Multiplier on the extra impulse while the car is dodging (flip hits hit harder). */
  dodgeBonus: 1.35,
  /** Multiplier per ball charge level (level 3 → 1 + 3 × 0.06). */
  chargeBonusPerLevel: 0.06,
  /** Min seconds between two extra impulses from the same car. */
  minInterval: 0.1,
} as const;

export const CAR_CAR = {
  /** Bump: velocity added to the bumped car (m/s) scaled by closing speed / maxSpeed. */
  bumpSpeed: 12,
  bumpUp: 4.5,
  restitution: 0.3,
  /** Demolition requires the attacker to be supersonic and hit with its front (cos of max angle). */
  demoFrontCos: 0.5,
} as const;

/** Original mechanic #1: CORE CHARGE — consecutive touches by the same team charge the ball; goals are worth the charge level. */
export const CHARGE = {
  maxLevel: 3,
  /** A touch only counts toward the chain if at least this long after the previous counted touch. */
  minTouchInterval: 0.5,
  /** ...and if the car–ball closing speed (m/s) was at least this. */
  minTouchSpeed: 3,
  /** Charge drops one level after this many seconds without a counted touch. */
  decayTime: 10,
} as const;

/**
 * Original mechanic #2: NOVA PULSE — a radial shockwave ability on a cooldown: blasts the ball away and shoves nearby
 * rivals (never teammates).
 */
export const PULSE = {
  cooldown: 10,
  radius: 8,
  /** Ball speed added at distance 0 (falls off linearly to 40% at the edge of the radius). */
  ballImpulse: 18,
  ballLift: 3,
  carImpulse: 9,
  carLift: 3,
} as const;

/** Original mechanic #3: ZERO-G SURGE — timed low-gravity events. */
export const SURGE = {
  /** A surge starts each time the match clock crosses a multiple of `interval` seconds (not at the start, not in the last `minClock` seconds). In overtime: every `interval` seconds of overtime. */
  interval: 60,
  minClock: 20,
  warning: 3, // seconds of warning before it starts
  duration: 10,
  /** BALL gravity multiplier during an active surge (this is what MatchState.surge.gravityScale reports). */
  gravityScale: 0.3,
  /**
   * CAR gravity multiplier during an active surge (carGravityScaleFor() in match.ts maps the ball scale to it).
   * Higher than the ball's so jumps stay playable (full jump ≈ 5 m / 3 s instead of 9 m / 6 s) and a stopped car still
   * drops off the ceiling (car gravity must beat CAR.stickyAccel), while the floating ball keeps the aerial chaos.
   */
  carGravityScale: 0.55,
} as const;

export const BOOST_PADS = {
  smallAmount: 12,
  bigAmount: 100,
  smallRespawn: 4,
  bigRespawn: 10,
  smallRadius: 1.3, // horizontal pickup radius (car origin within this of the pad center, and within pickupHeight above the floor)
  bigRadius: 2.0,
  pickupHeight: 2.5,
} as const;

/** Boost pad layout (x, z) on the floor. Mirror-symmetric in X and Z. */
export const PAD_LAYOUT: ReadonlyArray<{ x: number; z: number; big: boolean }> = [
  // big "core cells"
  { x: -30, z: 0, big: true },
  { x: 30, z: 0, big: true },
  { x: -28, z: -40, big: true },
  { x: 28, z: -40, big: true },
  { x: -28, z: 40, big: true },
  { x: 28, z: 40, big: true },
  // small pads
  { x: 0, z: -12, big: false },
  { x: 0, z: 12, big: false },
  { x: 0, z: -26, big: false },
  { x: 0, z: 26, big: false },
  { x: 0, z: -42, big: false },
  { x: 0, z: 42, big: false },
  { x: -18, z: 0, big: false },
  { x: 18, z: 0, big: false },
  { x: -10, z: -20, big: false },
  { x: 10, z: -20, big: false },
  { x: -10, z: 20, big: false },
  { x: 10, z: 20, big: false },
  { x: -20, z: -30, big: false },
  { x: 20, z: -30, big: false },
  { x: -20, z: 30, big: false },
  { x: 20, z: 30, big: false },
  { x: -24, z: -14, big: false },
  { x: 24, z: -14, big: false },
  { x: -24, z: 14, big: false },
  { x: 24, z: 14, big: false },
  { x: -8, z: -40, big: false },
  { x: 8, z: -40, big: false },
  { x: -8, z: 40, big: false },
  { x: 8, z: 40, big: false },
  { x: -30, z: -22, big: false },
  { x: 30, z: -22, big: false },
  { x: -30, z: 22, big: false },
  { x: 30, z: 22, big: false },
];

/**
 * Kickoff spawn spots for TEAM 0 (x, z); cars face the ball at the center.
 * Team 1 uses the point-mirrored spots (-x, -z).
 * The sim picks spots per kickoff with its seeded RNG:
 *   1v1: one random spot; 2v2: two distinct spots; 3v3: three distinct spots (always including one diagonal).
 */
export const KICKOFF_SPOTS: ReadonlyArray<{ x: number; z: number; kind: 'diagonal' | 'offcenter' | 'back' }> = [
  { x: -20, z: -26, kind: 'diagonal' },
  { x: 20, z: -26, kind: 'diagonal' },
  { x: -4, z: -36, kind: 'offcenter' },
  { x: 4, z: -36, kind: 'offcenter' },
  { x: 0, z: -44, kind: 'back' },
];

/** Respawn spots for TEAM 0 after a demolition (facing +Z). Team 1 uses (-x, -z) facing -Z. */
export const RESPAWN_SPOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -24, z: -44 },
  { x: -12, z: -45 },
  { x: 12, z: -45 },
  { x: 24, z: -44 },
];

export const MATCH = {
  countdown: 3, // seconds of 3-2-1 before GO
  goalPhase: 3.0, // seconds after a goal before the next kickoff countdown (sim time; the game layer pauses the sim during the replay)
  defaultDuration: 180,
  lastSecondsTick: 10, // emit clockTick events during the final N seconds
} as const;

/** Per-car stat scoring (points shown on the scoreboard, like a "match score"). */
export const STAT_POINTS = {
  goal: 100,
  assist: 50,
  save: 50,
  epicSave: 75,
  shot: 20,
  demo: 25,
  touch: 2,
  pulseHit: 5,
} as const;

export const BOT_NAMES: ReadonlyArray<string> = [
  'ZEPHYR', 'QUASAR', 'VEGA', 'LYRA', 'ION', 'RIGEL', 'HALO', 'NEBULA', 'ORION', 'COMET', 'ASTRA', 'NOVA-9',
];
