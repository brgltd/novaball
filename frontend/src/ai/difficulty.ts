/**
 * NOVABALL AI — difficulty profiles. Every skill-dependent number the bots use lives here.
 *
 *   ROOKIE  — late reactions, sloppy aim, occasional whiffs, throttle-heavy (rarely supersonic), no flips / aerials,
 *             ball-chases a bit, ignores the CORE CHARGE, shows off NOVA PULSE now and then (saves and pushes).
 *   PRO     — solid fundamentals: flips into the ball, jump & double-jump shots, modest aerials (≤ ~6 m), rotates,
 *             shadows, uses NOVA PULSE for saves and the odd redirect; human-like reactions and some sloppiness.
 *   LEGEND  — near-instant reactions, precise far-post shooting, aerials up to the ceiling, wall play, flip kickoffs,
 *             clutch pulses, opportunistic demolitions, tight rotations and boost control.
 */
import type { Difficulty } from '../sim/types';

export interface SkillProfile {
  difficulty: Difficulty;
  /** Perception delay (s): trajectory changes (touches, bounces off cars) are noticed this late. */
  reaction: number;
  /** Std-dev (rad) of the shot-direction error, resampled per approach. */
  aimNoise: number;
  /** Std-dev (m) of the chosen aim point inside the goal mouth. */
  aimSpread: number;
  /** Chance per approach to misjudge the touch (lateral contact offset / early jump). */
  whiff: number;
  /** Planning / driving speed cap (m/s). */
  speedCap: number;
  /** 0..1 willingness to boost (probability-like; 1 = whenever useful). */
  boostUse: number;
  /** Boost kept in reserve for emergencies (no casual boosting below this). */
  boostReserve: number;
  /** Flip (dodge) into ground balls for power. */
  dodgeShots: boolean;
  /** Single-jump shots for bouncing / low air balls. */
  jumpShots: boolean;
  /** Highest ball (center, m) the bot tries to meet with a single jump. */
  jumpMaxHeight: number;
  /** Double-jump shots. */
  doubleJumps: boolean;
  /** Highest ball (center, m) the bot will go for with an aerial; 0 = no aerials. */
  aerialMaxHeight: number;
  /** Minimum boost to start an aerial. */
  aerialMinBoost: number;
  /** Drive up walls for wall balls. */
  wallPlay: boolean;
  /** Highest wall ball (m) the bot plays. */
  wallMaxHeight: number;
  /** Probability to notice a clutch NOVA PULSE save opportunity (per situation). */
  pulseSave: number;
  /** Probability to take an offensive NOVA PULSE redirect when lined up (per situation). */
  pulseShot: number;
  /** Opportunistic supersonic demolitions. */
  demos: boolean;
  /** Kickoff style. */
  kickoffBoost: boolean;
  kickoffFlip: boolean;
  /** Random start delay after GO (s): [min, max]. */
  kickoffDelay: readonly [number, number];
  /**
   * 0..1 game sense. Scales how far the bot swings around the ball to line up a real shot when it has time (attack);
   * at ≥ 0.5 it also plays the CORE CHARGE (controlled touches while its team is charged, pressing harder with a charged
   * core, sitting deeper against the enemy's). Rotations / shadowing / double-commit avoidance are NOT skill-scaled.
   */
  discipline: number;
  /** Steering gains (heading PD on the local-frame angle). */
  steerKp: number;
  steerKd: number;
  /** 0..1 low-pass on the steering output (0 = crisp). */
  steerSmoothing: number;
  /** Max change of the steering output per tick (a thumb on a stick, not a switch): removes visible wobble. */
  steerSlew: number;
  /** Seconds by which an opponent must beat the bot to the ball before it backs off to shadow. */
  challengeMargin: number;
  /** Detours through small pads. */
  smallPads: boolean;
  /** Max lateral offset (m) of the contact point in a whiff. */
  whiffOffset: number;
  /** Max angle (rad) the bot will cut a ground shot away from its approach line. */
  maxCut: number;
}

export const SKILLS: Readonly<Record<Difficulty, SkillProfile>> = {
  rookie: {
    difficulty: 'rookie',
    reaction: 0.45,
    aimNoise: 0.2,
    aimSpread: 5,
    whiff: 0.35,
    speedCap: 15,
    boostUse: 0.15,
    boostReserve: 0,
    dodgeShots: false,
    jumpShots: true,
    jumpMaxHeight: 3.3,
    doubleJumps: false,
    aerialMaxHeight: 0,
    aerialMinBoost: 100,
    wallPlay: false,
    wallMaxHeight: 0,
    pulseSave: 0.5,
    pulseShot: 0.2,
    demos: false,
    kickoffBoost: false,
    kickoffFlip: false,
    kickoffDelay: [0.12, 0.45],
    discipline: 0.25,
    steerKp: 2.6,
    steerKd: 0.05,
    steerSmoothing: 0.45,
    steerSlew: 0.06,
    challengeMargin: 1.5,
    smallPads: false,
    whiffOffset: 1.1,
    maxCut: 0.75,
  },
  // PRO sits between the two (re-spaced after scripted-human play: the old pro — 0.15 s reactions, 23 m/s, 4 % whiffs —
  // beat a casual scripted player 94 % of the time, legend barely beat it). Now: casual ≈ 25 %, novice ≈ 12 % wins.
  pro: {
    difficulty: 'pro',
    reaction: 0.28,
    aimNoise: 0.1,
    aimSpread: 3,
    whiff: 0.14,
    speedCap: 20,
    boostUse: 0.55,
    boostReserve: 8,
    dodgeShots: true,
    jumpShots: true,
    jumpMaxHeight: 4.2,
    doubleJumps: true,
    aerialMaxHeight: 6,
    aerialMinBoost: 30,
    wallPlay: true,
    wallMaxHeight: 6,
    pulseSave: 0.6,
    pulseShot: 0.35,
    demos: false,
    kickoffBoost: true,
    kickoffFlip: true,
    kickoffDelay: [0.05, 0.2],
    discipline: 0.7,
    steerKp: 3.4,
    steerKd: 0.1,
    steerSmoothing: 0.1,
    steerSlew: 0.08,
    challengeMargin: 1.5,
    smallPads: true,
    whiffOffset: 1.0,
    maxCut: 0.9,
  },
  legend: {
    difficulty: 'legend',
    reaction: 0.05,
    aimNoise: 0.02,
    aimSpread: 1.2,
    whiff: 0,
    speedCap: 23,
    boostUse: 1,
    boostReserve: 0,
    dodgeShots: true,
    jumpShots: true,
    jumpMaxHeight: 4.2,
    doubleJumps: true,
    aerialMaxHeight: 15,
    aerialMinBoost: 20,
    wallPlay: true,
    wallMaxHeight: 14,
    pulseSave: 0.85,
    pulseShot: 0.75,
    demos: true,
    kickoffBoost: true,
    kickoffFlip: true,
    kickoffDelay: [0, 0],
    discipline: 0.9,
    steerKp: 4,
    steerKd: 0.12,
    steerSmoothing: 0,
    steerSlew: 0.14,
    challengeMargin: 0.8,
    smallPads: true,
    whiffOffset: 0,
    maxCut: 1.1,
  },
};

/**
 * ZERO-G SURGE behaviour (exported for the tuning tools). While the BALL's gravity is low it floats high and slowly
 * (the cars fall at carGravityScaleFor(): 0.55 g), so pro / legend aerial higher — cap += aerialExtra × (1 − ball
 * gravity scale), at most aerialCap — and leave with less boost (× aerialBoostK). Measured (3v3 pro, 36 × 300 s):
 * surge touches 75 → 81 % of normal play, time without a touch for > 3 s 37 → 25 %, surge goals 0.29 → 0.45 / min.
 * `jumpReach*`: let DESCENDING balls count as jump / double-jump balls up to the real low-gravity reach — measured
 * worse for aerial bots (3v3 pro: 81 → 72 % touches) and it makes rookies stronger against newcomers without more
 * action in the air (scripted novice 1v1: 9/24 → 5/24 wins, surge touches 6.3 → 5.7 / min), so both are off.
 */
export const SURGE_TUNING = {
  aerialExtra: 12,
  aerialCap: 18.5,
  aerialBoostK: 0.6,
  jumpReach: false,
  jumpReachNoAerial: false,
};

export function skillFor(d: Difficulty): SkillProfile {
  return SKILLS[d] ?? SKILLS.pro;
}
