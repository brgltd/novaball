/**
 * NOVABALL — attract-mode camera director (the live AI exhibition behind the main menu).
 *
 * Cycles cinematic shots: TV broadcast → chase-cam on the car nearest the ball → low "replay-style" ball follow
 * toward the goal the ball is heading for → a short high orbit → … Chase and ball-follow shots dominate (that's
 * where the action reads); orbits are brief establishing shots.
 * Goal threats: every 0.25 s the ball's free flight is predicted (the sim's predictGoal); when it would go in
 * within 2.5 s the director cuts to the ball-follow shot toward that goal and holds it (≥ 2 s) so the goal is on
 * screen when it happens. A wide shot (broadcast / orbit) that loses the ball for LOST_CUT seconds (ball under the
 * broadcast camera's own wall, high in a surge) cuts to the next chase shot. Goals cut to the hero 'goal' shot of
 * the explosion; kickoff resets cut back to the broadcast view.
 */
import { Vector3 } from 'three';
import type { CameraContext, CameraMode } from '../contracts';
import { ARENA } from '../sim/constants';
import { predictGoal } from '../sim/predict';
import type { CarSnapshot, Team, Vec3Like, WorldSnapshot } from '../sim/types';

type ShotKind = 'broadcast' | 'follow' | 'orbit' | 'ballFollow' | 'goal';

interface Shot {
  kind: ShotKind;
  dur: number;
}

const CYCLE: ReadonlyArray<Shot> = [
  { kind: 'broadcast', dur: 9 },
  { kind: 'follow', dur: 9 },
  { kind: 'ballFollow', dur: 7 },
  { kind: 'orbit', dur: 6 },
  { kind: 'follow', dur: 8 },
  { kind: 'broadcast', dur: 8 },
  { kind: 'ballFollow', dur: 7 },
  { kind: 'follow', dur: 8 },
  { kind: 'orbit', dur: 6 },
];

const GOAL_SHOT_SEC = 3.4;
/** Goal-threat check period (s), prediction horizon (s) and the minimum hold of a threat cut (s). */
const THREAT_EVERY = 0.25;
const THREAT_HORIZON = 2.5;
const THREAT_HOLD = 2;
/** A wide shot that has not shown the (live) ball for this long (s) gives way to a chase shot. */
const LOST_CUT = 0.8;

export class AttractDirector {
  private idx = 0;
  private t = 0;
  private followId = -1;
  private cut = true;
  private goalT = -1;
  private readonly goalPos = new Vector3();
  private attackTeam: Team = 0;
  private readonly focus = { x: 0, y: 0, z: 0 };
  /** Goal-threat shot: time held (-1 = none), predicted scoring team, time since the last prediction. */
  private threatT = -1;
  private threatTeam: Team = 0;
  private sinceCheck = 0;
  /** Seconds the current wide shot has not shown the ball. */
  private lostT = 0;
  /** The last prediction saw a goal coming (the game holds a pending re-seed meanwhile). */
  goalThreat = false;

  /** New attract match: start from the broadcast shot. */
  reset(): void {
    this.idx = 0;
    this.t = 0;
    this.followId = -1;
    this.goalT = -1;
    this.threatT = -1;
    this.sinceCheck = 0;
    this.lostT = 0;
    this.goalThreat = false;
    this.cut = true;
  }

  onGoal(pos: Vec3Like): void {
    this.goalT = 0;
    this.threatT = -1;
    this.goalThreat = false;
    this.cut = true; // broadcast-style hard cut to the hero shot of the explosion
    this.goalPos.set(pos.x, Math.max(1.5, pos.y), pos.z);
  }

  /** Kickoff reset (cars teleported): cut to a wide shot. */
  onKickoffReset(): void {
    this.goalT = -1;
    this.threatT = -1;
    this.goalThreat = false;
    this.idx = 0;
    this.t = 0;
    this.followId = -1;
    this.cut = true;
  }

  /**
   * Fill the camera context for this frame. Returns true when the rig should snap (hard cut) instead of
   * blending into the new shot. `gScale`: the ball's gravity multiplier (ZERO-G SURGE) for the goal prediction;
   * `ballOnScreen`: the ball was inside the last rendered frame.
   */
  update(dt: number, ctx: CameraContext, snap: WorldSnapshot, gScale = 1, ballOnScreen = true): boolean {
    let snapCut = false;
    ctx.focus = undefined;
    ctx.team = undefined;
    ctx.target = null;
    ctx.ballCam = true;

    if (this.goalT >= 0) {
      this.goalT += dt;
      if (this.goalT < GOAL_SHOT_SEC) {
        ctx.mode = 'goal';
        this.focus.x = this.goalPos.x;
        this.focus.y = this.goalPos.y;
        this.focus.z = this.goalPos.z;
        ctx.focus = this.focus;
        return this.takeCut();
      }
      this.goalT = -1;
      this.advance(snap);
      snapCut = true;
    }

    // ---- goal threat: predict the ball's free flight a few times per second
    this.sinceCheck += dt;
    if (this.sinceCheck >= THREAT_EVERY) {
      this.sinceCheck = 0;
      const b = snap.ball;
      const g = b.visible && snap.phase === 'playing' ? predictGoal(b.pos, b.vel, b.angVel, gScale, THREAT_HORIZON) : -1;
      this.goalThreat = g !== -1;
      if (g !== -1) {
        const kind = this.threatT >= 0 ? 'ballFollow' : CYCLE[this.idx].kind;
        if (this.threatT < 0 && kind !== 'ballFollow') {
          // cut to the goal-mouth follow shot toward the goal that is about to fall
          this.threatT = 0;
          this.threatTeam = g;
          snapCut = true;
        } else if (this.threatT >= 0) {
          this.threatTeam = g; // (held below while the threat lasts)
        } else {
          this.attackTeam = g; // already on a ball-follow shot: aim it at the right goal
        }
      }
    }
    if (this.threatT >= 0) {
      this.threatT += dt;
      if (this.threatT < THREAT_HOLD || this.goalThreat) {
        ctx.mode = 'replay';
        ctx.team = this.threatTeam;
        this.attackTeam = this.threatTeam;
        return this.takeCut() || snapCut;
      }
      // threat over: back to the cycle on its next shot (blend)
      this.threatT = -1;
      this.advance(snap);
    }

    // a wide shot that lost the ball: cut to the next chase shot
    const cur = CYCLE[this.idx].kind;
    this.lostT = (cur === 'broadcast' || cur === 'orbit') && !ballOnScreen && snap.ball.visible && snap.phase === 'playing' ? this.lostT + dt : 0;
    if (this.lostT >= LOST_CUT) {
      this.lostT = 0;
      do this.advance(snap);
      while (CYCLE[this.idx].kind !== 'follow');
      snapCut = true;
    }

    this.t += dt;
    if (this.t >= CYCLE[this.idx].dur) {
      this.advance(snap);
      // chase shots are hard cuts (TV style); the wide shots blend
      snapCut = snapCut || CYCLE[this.idx].kind === 'follow';
    }
    const shot = CYCLE[this.idx];
    let mode: CameraMode;
    switch (shot.kind) {
      case 'follow': {
        let car = findCar(snap, this.followId);
        if (!car || car.demolished) {
          this.followId = pickFollow(snap, this.followId);
          car = findCar(snap, this.followId);
          snapCut = true;
        }
        if (car && !car.demolished) {
          mode = 'car';
          ctx.target = car;
        } else mode = 'broadcast';
        break;
      }
      case 'ballFollow': {
        mode = 'replay';
        // goal the ball is threatening (hysteresis on the field half to avoid flip-flopping)
        const b = snap.ball;
        if (b.visible) {
          if (b.pos.z > 6) this.attackTeam = 0;
          else if (b.pos.z < -6) this.attackTeam = 1;
        }
        ctx.team = this.attackTeam;
        break;
      }
      case 'orbit':
        mode = 'orbit';
        break;
      default:
        mode = 'broadcast';
    }
    ctx.mode = mode;
    return this.takeCut() || snapCut;
  }

  private takeCut(): boolean {
    const c = this.cut;
    this.cut = false;
    return c;
  }

  private advance(snap: WorldSnapshot): void {
    this.idx = (this.idx + 1) % CYCLE.length;
    this.t = 0;
    if (CYCLE[this.idx].kind === 'follow') this.followId = pickFollow(snap, this.followId);
  }
}

function findCar(snap: WorldSnapshot, id: number): CarSnapshot | null {
  if (id < 0) return null;
  for (let i = 0; i < snap.cars.length; i++) if (snap.cars[i].id === id) return snap.cars[i];
  return null;
}

/** The live car closest to the ball (not `avoid` when there is a choice). */
function pickFollow(snap: WorldSnapshot, avoid: number): number {
  const b = snap.ball.pos;
  let best = -1;
  let bestD = Infinity;
  for (const c of snap.cars) {
    if (c.demolished) continue;
    let d = c.pos.distanceToSquared(b);
    if (c.id === avoid) d *= 4;
    // prefer cars on the floor near the middle (nicer chase shots than a car stuck in a corner)
    if (Math.abs(c.pos.z) > ARENA.halfLength - 6) d *= 1.5;
    if (d < bestD) {
      bestD = d;
      best = c.id;
    }
  }
  return best;
}
