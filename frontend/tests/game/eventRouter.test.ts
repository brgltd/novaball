/**
 * EventRouter notification policy: CORE CHARGE steal vs decay, SUPERNOVA banner rules, no big banners while play is
 * stopped for a goal, surge / last-minute copy. Driven with synthetic sim events and stub presentation systems.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { HudNotification, NotificationKind } from '../../src/contracts';
import { EventRouter, type RouterHooks } from '../../src/game/EventRouter';
import type { MatchSession } from '../../src/game/MatchSession';
import type { InputSystem } from '../../src/input/InputSystem';
import type { RenderSystem } from '../../src/render/RenderSystem';
import type { VFXSystem } from '../../src/render/VFXSystem';
import type { SimEvent, Team, WorldSnapshot } from '../../src/sim/types';
import type { UIManager } from '../../src/ui/UIManager';

interface Rig {
  router: EventRouter;
  notes: HudNotification[];
  dismissed: NotificationKind[];
  session: MatchSession;
  respawns: number;
}

function makeSession(): MatchSession {
  return {
    playerId: 0,
    countdownsSeen: 1,
    config: { durationSec: 120, freePlay: false },
    world: {
      cars: [
        { id: 0, name: 'PLAYER', team: 0, stats: { goals: 0 } },
        { id: 1, name: 'VEGA', team: 0, stats: { goals: 0 } },
        { id: 2, name: 'ORION', team: 1, stats: { goals: 0 } },
        { id: 3, name: 'LYRA', team: 1, stats: { goals: 0 } },
      ],
      ball: { lastTouchCarId: -1 },
      match: { phase: 'playing', clock: 100, overtime: false, freePlay: false },
    },
  } as unknown as MatchSession;
}

function makeRig(): Rig {
  const notes: HudNotification[] = [];
  const dismissed: NotificationKind[] = [];
  const noop = () => {};
  const render = { camera: { position: new Vector3() }, arena: { onImpact: noop, onGoal: noop }, cameraRig: { shake: noop }, flash: noop };
  const ui = { notify: (n: HudNotification) => notes.push(n), dismissBanner: (k: NotificationKind) => dismissed.push(k), showCountdown: noop };
  const rig = { notes, dismissed, session: makeSession(), respawns: 0 } as Rig;
  const hooks: RouterHooks = { onGoal: noop, onKickoffReset: noop, onKickoff: noop, onOvertime: noop, onMatchEnd: noop, onRespawn: () => rig.respawns++ };
  rig.router = new EventRouter(render as unknown as RenderSystem, { handleEvent: noop } as unknown as VFXSystem, ui as unknown as UIManager, { rumble: noop } as unknown as InputSystem, hooks);
  return rig;
}

const SNAP = { ball: { charge: 0, chargeTeam: -1 } } as unknown as WorldSnapshot;
const cc = (team: Team | -1, level: number, prevLevel: number): SimEvent => ({ type: 'chargeChange', team, level, prevLevel });
const route = (r: Rig, evs: SimEvent[], mode: 'live' | 'replay' | 'attract' = 'live', s = r.session) => r.router.route(evs, SNAP, s, mode);
const titles = (r: Rig) => r.notes.map((n) => n.title);

describe('EventRouter · CORE CHARGE messages', () => {
  it('a II chain decaying to I is CORE FADING, never CORE STOLEN (also with no opponents around)', () => {
    const r = makeRig();
    route(r, [cc(0, 1, 0), cc(0, 2, 1)]);
    route(r, [cc(0, 1, 2)]);
    expect(titles(r)).toEqual(['CORE CHARGE II', 'CORE FADING']);
    expect(r.notes[1].subtitle).toContain('VOLT II → I');
    expect(r.notes[1].big).toBeFalsy();
    route(r, [cc(-1, 0, 1)]); // I → 0: silent
    expect(r.notes).toHaveLength(2);
  });

  it('a real steal of a II chain names the right teams', () => {
    const r = makeRig();
    route(r, [cc(0, 1, 0), cc(0, 2, 1), cc(1, 1, 2)]);
    expect(titles(r)).toEqual(['CORE CHARGE II', 'CORE STOLEN']);
    expect(r.notes[1].subtitle).toBe("BLAZE BREAKS VOLT'S II CHAIN");
    expect(r.notes[1].team).toBe(1);
  });

  it('dropping from III (steal, decay or kickoff reset) dismisses the SUPERNOVA banner', () => {
    const r = makeRig();
    route(r, [cc(1, 1, 0), cc(1, 2, 1), cc(1, 3, 2)]);
    expect(r.notes.at(-1)).toMatchObject({ kind: 'supernova', big: true, team: 1 });
    route(r, [cc(0, 1, 3)]);
    expect(r.dismissed).toEqual(['supernova']);
    expect(r.notes.at(-1)).toMatchObject({ title: 'CORE STOLEN', subtitle: "VOLT BREAKS BLAZE'S III CHAIN" });
    route(r, [cc(0, 2, 1), cc(0, 3, 2), cc(0, 2, 3)]);
    expect(r.dismissed).toEqual(['supernova', 'supernova']);
    expect(r.notes.at(-1)).toMatchObject({ title: 'CORE FADING' });
    expect(r.notes.at(-1)!.subtitle).toContain('VOLT III → II');
  });

  it('big SUPERNOVA banners: the match first and the player team first only (≤ 2 per match)', () => {
    const r = makeRig();
    const nova = (t: Team) => route(r, [cc(t, 1, 0), cc(t, 2, 1), cc(t, 3, 2), cc(-1, 0, 3)]);
    nova(1); // first of the match (opponents): big
    nova(1); // opponents again: feed
    nova(0); // player's team, first time: big
    nova(0); // player's team again: feed
    const novas = r.notes.filter((n) => n.kind === 'supernova');
    expect(novas.map((n) => !!n.big)).toEqual([true, false, true, false]);
  });

  it('replayed and attract charge events never touch the live chain tracker', () => {
    const r = makeRig();
    route(r, [cc(0, 1, 0), cc(0, 2, 1)]);
    route(r, [cc(1, 1, 0)], 'replay'); // replay of an older possession
    route(r, [cc(0, 1, 2)]); // live decay of VOLT's chain
    expect(titles(r)).toEqual(['CORE CHARGE II', 'CORE FADING']);
    // a new session starts from a neutral tracker
    const other = makeSession();
    route(r, [cc(1, 1, 2)], 'live', other);
    expect(titles(r)).toEqual(['CORE CHARGE II', 'CORE FADING']);
  });
});

describe('EventRouter · banners around goals, surges and respawns', () => {
  const demolished: SimEvent = { type: 'demolish', victimId: 0, attackerId: 2, pos: { x: 0, y: 0.5, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
  const goal: SimEvent = { type: 'goal', team: 1, scorerId: 2, assistId: -1, points: 1, charge: 0, ballSpeed: 20, pos: { x: 0, y: 2, z: -51 }, ownGoal: false };

  it('while play is stopped for a goal only the goal banner is big', () => {
    const r = makeRig();
    const m = (r.session.world.match as { phase: string });
    route(r, [goal]);
    m.phase = 'goal';
    route(r, [demolished]);
    expect(r.notes.map((n) => [n.kind, !!n.big])).toEqual([
      ['goal', true],
      ['demolished', false],
    ]);
    // replay-end fast-forward: goal-phase events are routed with the next countdown in the same batch
    route(r, [demolished, { type: 'countdown', value: 3 }]);
    expect(r.notes.at(-1)).toMatchObject({ kind: 'demolished', big: false });
    m.phase = 'playing';
    route(r, [demolished]);
    expect(r.notes.at(-1)).toMatchObject({ kind: 'demolished', big: true });
  });

  it('surge warning is a feed line; the 1:00 surge banner carries LAST MINUTE', () => {
    const r = makeRig();
    const m = r.session.world.match as { clock: number };
    m.clock = 63;
    route(r, [{ type: 'surgeWarning', seconds: 3 }]);
    expect(r.notes.at(-1)).toMatchObject({ kind: 'surge', title: 'ZERO-G SURGE IN 3…' });
    expect(r.notes.at(-1)!.big).toBeFalsy();
    expect(r.router.lastMinuteAnnounced(r.session)).toBe(false);
    m.clock = 60;
    route(r, [{ type: 'surgeStart' }]);
    expect(r.notes.at(-1)).toMatchObject({ kind: 'surge', big: true, subtitle: 'LOW GRAVITY · 10 SECONDS · LAST MINUTE' });
    expect(r.router.lastMinuteAnnounced(r.session)).toBe(true);
    m.clock = 120;
    const r2 = makeRig();
    (r2.session.world.match as { clock: number }).clock = 120;
    route(r2, [{ type: 'surgeStart' }]);
    expect(r2.notes.at(-1)!.subtitle).toBe('LOW GRAVITY · 10 SECONDS · TAKE FLIGHT');
    expect(r2.router.lastMinuteAnnounced(r2.session)).toBe(false);
  });

  it('surge news during a goal stoppage is dropped (no stale line on the replay)', () => {
    const r = makeRig();
    const m = r.session.world.match as { phase: string; clock: number };
    m.clock = 61;
    route(r, [goal]);
    m.phase = 'goal';
    route(r, [{ type: 'surgeStart' }, { type: 'surgeEnd' }]);
    expect(r.notes.map((n) => n.kind)).toEqual(['goal']);
    // it did not announce the last minute either: the game's own LAST MINUTE cue still fires at 1:00
    expect(r.router.lastMinuteAnnounced(r.session)).toBe(false);
  });

  it("the player's respawn asks for a camera cut (live only)", () => {
    const r = makeRig();
    route(r, [{ type: 'respawn', carId: 2 }]);
    route(r, [{ type: 'respawn', carId: 0 }], 'replay');
    expect(r.respawns).toBe(0);
    route(r, [{ type: 'respawn', carId: 0 }]);
    expect(r.respawns).toBe(1);
  });
});
