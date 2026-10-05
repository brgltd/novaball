/**
 * NOVABALL — one match (or the attract-mode exhibition): World + bot manager(s) + per-car views + snapshots + the
 * replay recorder. Created per match, disposed when leaving it. The persistent actors (ball, pads, VFX) live in
 * Game and are shared by every session (no shader recompiles between matches).
 *
 * Bots: one BotManager at the match difficulty — except 2v2 ROOKIE with a human player, where the human's wingman
 * is a PRO (its own manager) against ROOKIE opponents: a first match that a newcomer can actually win while still
 * touching the ball as much as with a rookie mate (measured in the headless newbie harness).
 */
import type { Object3D } from 'three';
import { BotManager } from '../ai/BotManager';
import type { IBotManager, IWorld } from '../contracts';
import { CarView } from '../render/CarView';
import { makeSnapshot } from '../sim/snapshot';
import type { ControlState, MatchConfig, SimEvent, Team, WorldSnapshot } from '../sim/types';
import { makeControlState } from '../sim/types';
import { World } from '../sim/world';
import { PAINTS } from '../theme';
import { ReplayBuffer } from './Replay';

/**
 * Bot body paints per team (trims are always the team color), disjoint so no body color is shared across teams:
 * cool / silver for VOLT, warm / dark for BLAZE.
 */
const BOT_PAINTS: Record<Team, readonly string[]> = {
  0: ['#e8eef7', '#1947c2', '#b9c3cf', '#7a2cff'],
  1: ['#0d0f14', '#b3122e', '#2a2f3a', '#ffcc33', '#ff4fa3'],
};

/** Several bot managers behind one IBotManager (updated in order, once per sim tick). */
export class BotGroup implements IBotManager {
  constructor(readonly managers: ReadonlyArray<BotManager>) {}

  update(world: IWorld, inputs: ControlState[]): void {
    for (let i = 0; i < this.managers.length; i++) this.managers[i].update(world, inputs);
  }

  debugInfo(): string {
    return this.managers.map((m) => m.debugInfo()).join(' | ');
  }
}

/** 2v2 ROOKIE vs bots: the human gets a PRO wingman (see the header). */
export function wantsProWingman(config: MatchConfig): boolean {
  return !!config.player && !config.freePlay && config.teamSize === 2 && config.difficulty === 'rookie';
}

export class MatchSession {
  readonly world: World;
  readonly config: MatchConfig;
  readonly bots: BotGroup | null;
  readonly cars: CarView[] = [];
  /** inputs[carId] — the player's controls are sampled into inputs[0]; bots write their own. */
  readonly inputs: ControlState[] = [];
  /** Previous / current tick snapshots (swapped each tick) and the interpolated render snapshot. */
  prev: WorldSnapshot;
  curr: WorldSnapshot;
  readonly view: WorldSnapshot;
  readonly replay: ReplayBuffer;
  /** Car id of the human player, -1 in attract mode. */
  readonly playerId: number;
  /** Sim tick of the most recent 'kickoff' event (replays never start before it). */
  lastKickoffTick = 0;
  /** Sim tick of the last goal (for the replay). */
  goalTick = -1;
  lastGoal: Extract<SimEvent, { type: 'goal' }> | null = null;
  /** The replay for the current goal phase has been played / skipped / is not wanted. */
  replayDone = true;
  /** Wall-clock (game real time) when the match ended (-1 while running). */
  endedAt = -1;
  endShown = false;
  /** world.hash() (unsigned) right after the tick that ended the match (null while running). */
  endHash: number | null = null;
  /** 'countdown' 3 events seen (the first one is the match start, later ones are kickoff resets). */
  countdownsSeen = 0;
  /** Kickoffs seen (the first one plays the musical "GO" stinger). */
  kickoffsSeen = 0;

  private readonly parent: Object3D;
  private disposed = false;

  /** Debug / soak tests: a bot drives the player's car (the player's input is ignored). */
  readonly autopilot: boolean;

  constructor(config: MatchConfig, parent: Object3D, opts: { autopilot?: boolean } = {}) {
    this.config = config;
    this.parent = parent;
    this.world = new World(config);
    const w = this.world;
    this.playerId = config.player ? 0 : -1;
    this.autopilot = !!opts.autopilot && this.playerId >= 0;
    for (let i = 0; i < w.cars.length; i++) this.inputs.push(makeControlState());
    const botIds = w.cars.filter((c) => c.isBot || (this.autopilot && c.id === this.playerId)).map((c) => c.id);
    if (botIds.length === 0) this.bots = null;
    else if (wantsProWingman(config)) {
      // same seeding as the per-team managers of the AI harness (tests/ai/harness.ts)
      const team = (t: Team) => botIds.filter((id) => w.cars[id].team === t);
      this.bots = new BotGroup([
        new BotManager(w, team(0), 'pro', (config.seed * 31 + 7) >>> 0),
        new BotManager(w, team(1), 'rookie', (config.seed * 57 + 3) >>> 0),
      ]);
    } else this.bots = new BotGroup([new BotManager(w, botIds, config.difficulty, config.seed)]);

    // bot paints: the team palette minus the player's paint, rotated by the seed (unique within a team)
    const playerPaint = config.player ? config.player.paint.toLowerCase() : '';
    const pal: Record<Team, string[]> = {
      0: BOT_PAINTS[0].filter((p) => p !== playerPaint),
      1: BOT_PAINTS[1].filter((p) => p !== playerPaint),
    };
    const slot: [number, number] = [0, 0];
    for (const c of w.cars) {
      const isPlayer = c.id === this.playerId;
      let paint: string;
      if (isPlayer && config.player) paint = config.player.paint;
      else {
        const p = pal[c.team];
        paint = p[(slot[c.team] + (config.seed >>> 3)) % p.length];
        slot[c.team]++;
      }
      const view = new CarView({ team: c.team, style: c.style, paint: isValidPaint(paint) ? paint : PAINTS[0].hex, isPlayer, name: c.name, nameplate: !isPlayer });
      this.cars.push(view);
      parent.add(view.object);
    }

    this.prev = makeSnapshot(w.cars.length, w.pads.length);
    this.curr = makeSnapshot(w.cars.length, w.pads.length);
    this.view = makeSnapshot(w.cars.length, w.pads.length);
    w.writeSnapshot(this.prev);
    w.writeSnapshot(this.curr);
    w.writeSnapshot(this.view);
    this.replay = new ReplayBuffer(w.cars.length, w.pads.length);
  }

  get isAttract(): boolean {
    return this.playerId < 0;
  }

  /** Swap prev/curr and write the latest state into curr (call after world.step). */
  captureTick(): void {
    const t = this.prev;
    this.prev = this.curr;
    this.curr = t;
    this.world.writeSnapshot(this.curr);
    this.replay.recordTick(this.world);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.cars) {
      this.parent.remove(c.object);
      c.dispose();
    }
    this.cars.length = 0;
    this.replay.reset();
  }
}

function isValidPaint(p: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(p);
}
