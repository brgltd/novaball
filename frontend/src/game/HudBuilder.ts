/**
 * NOVABALL — builds the per-frame HudState from the live world, the player's car and the render camera.
 * Allocation-free after construction (one HudState, reused scoreboard lines; stats objects are the sim's own,
 * read-only).
 */
import { Vector3, type PerspectiveCamera } from 'three';
import type { HudState, PlayerLine } from '../contracts';
import { CHARGE, PULSE, SIM_HZ } from '../sim/constants';
import type { SimMatchState } from '../sim/match';
import type { WorldSnapshot } from '../sim/types';
import type { World } from '../sim/world';
import { TEAMS } from '../theme';

const _v = new Vector3();
const _vv = new Vector3();
const CHARGE_DECAY_TICKS = CHARGE.decayTime * SIM_HZ;

export interface HudInputs {
  world: World;
  /** Interpolated snapshot being rendered this frame. */
  snap: WorldSnapshot;
  playerId: number;
  camera: PerspectiveCamera;
  ballCam: boolean;
  replay: boolean;
  fps: number;
  showFps: boolean;
  /** Viewport size in CSS px. */
  width: number;
  height: number;
  /** Show the off-screen ball arrow (live car camera only). */
  indicator: boolean;
}

export class HudBuilder {
  readonly state: HudState;
  private readonly lines: PlayerLine[] = [];
  private linesFor: World | null = null;

  constructor() {
    this.state = {
      freePlay: false,
      teamNames: [TEAMS[0].name, TEAMS[1].name],
      playerTeam: 0,
      score: [0, 0],
      clock: 0,
      overtime: false,
      overtimeElapsed: 0,
      phase: 'countdown',
      countdown: 0,
      boost: 0,
      speed: 0,
      supersonic: false,
      pulseEnabled: true,
      pulseReady01: 1,
      chargeEnabled: true,
      charge: 0,
      chargeTeam: -1,
      chargeDecay01: 0,
      surge: { state: 'idle', timeLeft: 0 },
      ballCam: true,
      ballIndicator: { visible: false, x: 0, y: 0, angle: 0 },
      replay: false,
      fps: 60,
      showFps: false,
      respawnIn: 0,
      scoreboard: this.lines,
    };
  }

  /** Scoreboard lines for a world (rebuilt only when the world changes; stats are live references). */
  scoreboard(world: World, playerId: number): PlayerLine[] {
    if (this.linesFor !== world) {
      this.linesFor = world;
      this.lines.length = 0;
      for (const c of world.cars) {
        this.lines.push({ id: c.id, name: c.name, team: c.team, isPlayer: c.id === playerId, isBot: c.isBot, stats: c.stats });
      }
    }
    return this.lines;
  }

  build(p: HudInputs): HudState {
    const h = this.state;
    const w = p.world;
    const m = w.match;
    const cfg = w.config;
    h.freePlay = cfg.freePlay;
    h.playerTeam = 0;
    h.score[0] = m.score[0];
    h.score[1] = m.score[1];
    h.clock = cfg.freePlay ? 0 : m.clock;
    h.overtime = m.overtime;
    h.overtimeElapsed = m.overtimeElapsed;
    h.phase = m.phase;
    h.countdown = m.countdown;
    h.pulseEnabled = cfg.mutators.pulse;
    h.chargeEnabled = cfg.mutators.charge;
    // from the rendered snapshot: during an instant replay the pill matches the replayed ball
    h.charge = p.snap.ball.charge;
    h.chargeTeam = p.snap.ball.chargeTeam;
    // CORE CHARGE decay window (live ball only; a replayed ball has no live timer)
    const idle = (m as SimMatchState).chargeIdleTicks;
    h.chargeDecay01 = !p.replay && w.ball.charge > 0 && typeof idle === 'number' ? Math.min(1, Math.max(0, idle / CHARGE_DECAY_TICKS)) : 0;
    h.surge.state = m.surge.state;
    h.surge.timeLeft = m.surge.timeLeft;
    h.ballCam = p.ballCam;
    h.replay = p.replay;
    h.fps = p.fps;
    h.showFps = p.showFps;

    const car = p.playerId >= 0 ? w.cars[p.playerId] : null;
    if (car) {
      h.boost = car.boost;
      h.speed = car.vel.length();
      h.supersonic = car.supersonic;
      h.pulseReady01 = cfg.mutators.pulse ? 1 - car.pulseCooldown / PULSE.cooldown : 0;
      h.respawnIn = car.demolished ? Math.max(0, car.respawnTimer) : 0;
    } else {
      h.boost = 0;
      h.speed = 0;
      h.supersonic = false;
      h.pulseReady01 = 0;
      h.respawnIn = 0;
    }
    h.scoreboard = this.scoreboard(w, p.playerId);
    this.ballIndicator(p);
    return h;
  }

  /** Off-screen ball arrow: project the ball; when outside a margin (or behind), pin it to the screen edge. */
  private ballIndicator(p: HudInputs): void {
    const ind = this.state.ballIndicator;
    const ball = p.snap.ball;
    const phase = p.world.match.phase;
    if (!p.indicator || !ball.visible || phase === 'ended' || p.width < 2 || p.height < 2) {
      ind.visible = false;
      return;
    }
    const cam = p.camera;
    // view space: camera looks down -Z
    _vv.copy(ball.pos).applyMatrix4(cam.matrixWorldInverse);
    const behind = _vv.z > -0.1;
    _v.copy(ball.pos).project(cam);
    let nx = _v.x;
    let ny = _v.y;
    if (behind) {
      // mirror through the center so the arrow points the right way when the ball is behind the camera
      nx = -nx;
      ny = -ny;
      const l = Math.hypot(nx, ny);
      if (l < 1e-3) {
        nx = 0;
        ny = -1;
      } else {
        // push to the border
        nx /= l;
        ny /= l;
      }
    }
    const inside = !behind && Math.abs(nx) < 0.9 && Math.abs(ny) < 0.86;
    if (inside) {
      ind.visible = false;
      return;
    }
    // screen-space direction from the center (y down)
    const dx = nx * p.width * 0.5;
    const dy = -ny * p.height * 0.5;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // pin to an inset rectangle
    const hw = p.width * 0.5 - 70;
    const hh = p.height * 0.5 - 70;
    const k = Math.min(hw / Math.max(1e-6, Math.abs(ux)), hh / Math.max(1e-6, Math.abs(uy)));
    ind.visible = true;
    ind.x = p.width * 0.5 + ux * k;
    ind.y = p.height * 0.5 + uy * k;
    ind.angle = Math.atan2(uy, ux);
  }
}
