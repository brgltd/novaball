/**
 * NOVABALL — routes sim events to every presentation system:
 *   VFX one-shots, force-field / floor ripples, goal celebrations, screen flash, camera shake, gamepad rumble and
 *   HUD notifications (with the match copy). Audio gets the whole event batch separately (Game.ts).
 *
 * Three contexts:
 *   live     — a real match: everything, notifications for the player's perspective, rumble for the player's own
 *              actions / goals only;
 *   replay   — re-emitted events during an instant replay: visuals only (no UI, no rumble, softer shake/flash);
 *   attract  — the exhibition behind the main menu: visuals, soft flashes, no UI / rumble.
 *
 * Notification policy (live): while play is stopped for a goal (goal phase, incl. events fast-forwarded after a
 * replay) only goal banners are big — everything else goes to the side feed, so nothing lands on the replay or the
 * next kickoff. Routine cues are feed items (surge warning, charge II, core fading / stolen); SUPERNOVA is a big
 * banner only the first time in a match and the first time the player's team reaches it.
 */
import { Vector3 } from 'three';
import type { HudNotification } from '../contracts';
import type { InputSystem } from '../input/InputSystem';
import type { RenderSystem } from '../render/RenderSystem';
import type { VFXSystem } from '../render/VFXSystem';
import { arenaNormal, arenaSDF } from '../sim/arena';
import { STAT_POINTS } from '../sim/constants';
import type { SimEvent, Team, Vec3Like, WorldSnapshot } from '../sim/types';
import { TEAMS } from '../theme';
import type { UIManager } from '../ui/UIManager';
import type { MatchSession } from './MatchSession';

export type RouteMode = 'live' | 'replay' | 'attract';

const KMH = 3.6;
const _p = new Vector3();
const _n = new Vector3();
const _cam = new Vector3();
const UP: Vec3Like = { x: 0, y: 1, z: 0 };

const ROMAN = ['', 'I', 'II', 'III'];

export interface RouterHooks {
  /** A goal happened (live or attract): start the slow motion, schedule the replay. */
  onGoal(e: Extract<SimEvent, { type: 'goal' }>, mode: RouteMode): void;
  /** Kickoff reset (a 'countdown' 3 after the start): snap cameras, clear VFX. */
  onKickoffReset(mode: RouteMode): void;
  onKickoff(mode: RouteMode): void;
  onOvertime(): void;
  onMatchEnd(e: Extract<SimEvent, { type: 'matchEnd' }>): void;
  /** The local player's car respawned after a demolition (live): cut the camera to it. */
  onRespawn?(): void;
}

/** Per-match notification bookkeeping (reset whenever the routed session changes). */
interface MatchNotes {
  /** Team owning the charge chain according to the live event stream (-1 = neutral). */
  chargeTeam: Team | -1;
  /** SUPERNOVAs reached this match / big SUPERNOVA banner already shown for the player's team. */
  supernovas: number;
  mineSupernovaBig: boolean;
  /** Play is stopped for a goal: non-goal banners go to the feed. */
  stoppage: boolean;
  /** "LAST MINUTE" was already announced (inside the ZERO-G SURGE banner). */
  lastMinute: boolean;
}

/** Match-clock window (s) in which a surge start also announces the last minute. */
const LAST_MINUTE_SURGE_WINDOW = 3;

export class EventRouter {
  /** Screen-flash multiplier (prefers-reduced-motion: much softer flashes). */
  private flashScale = 1;
  private notesFor: MatchSession | null = null;
  /**
   * Attract goals: the director hard-cuts to the hero shot in this frame's camera update, and the explosion scales its
   * brightness with the camera distance — so its VFX wait until the views have sampled the new camera
   * (flushDeferredVfx, one frame later than the flash / ripples).
   */
  private readonly deferredVfx: SimEvent[] = [];
  private readonly notes: MatchNotes = { chargeTeam: -1, supernovas: 0, mineSupernovaBig: false, stoppage: false, lastMinute: false };

  constructor(
    private readonly render: RenderSystem,
    private readonly vfx: VFXSystem,
    private readonly ui: UIManager,
    private readonly input: InputSystem,
    private readonly hooks: RouterHooks,
  ) {
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const apply = () => {
        this.flashScale = mq.matches ? 0.35 : 1;
      };
      apply();
      mq.addEventListener?.('change', apply);
    } catch {
      /* no matchMedia (tests) */
    }
  }

  route(events: ReadonlyArray<SimEvent>, snap: WorldSnapshot, session: MatchSession, mode: RouteMode): void {
    _cam.copy(this.render.camera.position);
    const notes = this.notesOf(session);
    // safety net: whenever the live sim is back in play, the goal stoppage is over (free play has no countdown)
    if (mode === 'live' && session.world.match.phase === 'playing') notes.stoppage = false;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (mode === 'attract' && e.type === 'goal') this.deferredVfx.push(e);
      else this.vfx.handleEvent(e, snap);
      try {
        this.one(e, snap, session, mode);
      } catch (err) {
        console.error('[game] event routing failed', e.type, err);
      }
    }
  }

  /** Emit the VFX held back by route() (call after the camera and the views updated). */
  flushDeferredVfx(snap: WorldSnapshot): void {
    for (let i = 0; i < this.deferredVfx.length; i++) this.vfx.handleEvent(this.deferredVfx[i], snap);
    this.deferredVfx.length = 0;
  }

  /** Session switch: forget held-back VFX. */
  dropDeferredVfx(): void {
    this.deferredVfx.length = 0;
  }

  /** "LAST MINUTE" was already announced for this match (by the surge banner that started with it). */
  lastMinuteAnnounced(session: MatchSession): boolean {
    return this.notesOf(session).lastMinute;
  }

  private notesOf(s: MatchSession): MatchNotes {
    if (this.notesFor !== s) {
      this.notesFor = s;
      const n = this.notes;
      n.chargeTeam = -1;
      n.supernovas = 0;
      n.mineSupernovaBig = false;
      n.stoppage = false;
      n.lastMinute = false;
    }
    return this.notes;
  }

  // --------------------------------------------------------------------------------------------------------------

  private one(e: SimEvent, snap: WorldSnapshot, s: MatchSession, mode: RouteMode): void {
    const live = mode === 'live';
    const pid = s.playerId;
    const arena = this.render.arena;
    const rig = this.render.cameraRig;
    this.cur = s;
    const name = this.name;
    const teamOf = this.teamOf;
    const camDist = camDistance;

    switch (e.type) {
      case 'ballHit': {
        const k = Math.min(1, e.strength / 40);
        const near = 1 - Math.min(1, camDist(e.pos) / 18);
        if (e.carId === pid && live) {
          this.input.rumble(0.2 + 0.6 * k, 0.35 + 0.5 * k, 60 + 110 * k);
          if (e.strength > 14) rig.shake(0.1 + 0.25 * k);
        } else if (near > 0 && e.strength > 18) rig.shake(0.18 * k * near);
        if (e.strength > 30 && live && (e.carId === pid || near > 0)) this.flash(TEAMS[e.team].secondary, 0.06 + 0.1 * k);
        return;
      }
      case 'ballBounce': {
        if (e.speed < 3) return;
        const b = snap.ball;
        const color = b.charge > 0 && b.chargeTeam !== -1 ? TEAMS[b.chargeTeam].secondary : undefined;
        arena.onImpact(e.pos, e.normal, Math.min(1, e.speed / 22), color);
        return;
      }
      case 'carImpact': {
        if (e.normal.y < 0.7) arena.onImpact(e.pos, e.normal, Math.min(1, e.speed / 24), TEAMS[teamOf(e.carId)].primary);
        if (e.carId === pid && live) {
          const k = Math.min(1, e.speed / 20);
          this.input.rumble(0.35 * k + 0.1, 0.4 * k + 0.1, 90);
          rig.shake(0.08 + 0.2 * k);
        }
        return;
      }
      case 'carBump': {
        const mine = e.aId === pid || e.bId === pid;
        if (mine && live) {
          const k = Math.min(1, e.speed / 20);
          this.input.rumble(0.4 + 0.4 * k, 0.5 + 0.3 * k, 130);
          rig.shake(0.15 + 0.3 * k);
        }
        return;
      }
      case 'dodge': {
        if (e.carId === pid && live) this.input.rumble(0.05, 0.22, 45);
        return;
      }
      case 'land': {
        if (e.carId === pid && live && e.speed > 5) this.input.rumble(0.15, 0.25, 50);
        return;
      }
      case 'boostPickup': {
        if (e.carId === pid && live && e.big) this.input.rumble(0, 0.28, 70);
        return;
      }
      case 'demolish': {
        const d = camDist(e.pos);
        const near = 1 - Math.min(1, d / 40);
        this.surfaceImpact(e.pos, 0.9, TEAMS[teamOf(e.attackerId)].secondary);
        if (mode === 'attract') {
          if (near > 0) rig.shake(0.3 * near);
          return;
        }
        rig.shake(Math.max(0.15, (mode === 'replay' ? 0.35 : 0.6) * near));
        if (!live) return;
        if (e.victimId === pid) {
          this.input.rumble(1, 1, 380);
          this.flash('#ffffff', 0.35);
          this.notify({ kind: 'demolished', title: 'DEMOLISHED', subtitle: `BY ${name(e.attackerId)}`, team: teamOf(e.attackerId), big: true });
        } else if (e.attackerId === pid) {
          this.input.rumble(0.7, 0.9, 220);
          this.flash(TEAMS[teamOf(pid)].secondary, 0.2);
          this.notify({ kind: 'demolition', title: 'DEMOLITION!', subtitle: `${name(e.victimId)} DESTROYED`, team: teamOf(pid), points: STAT_POINTS.demo, big: true });
        } else {
          this.notify({ kind: 'demolition', title: 'DEMOLITION', subtitle: `${name(e.attackerId)} → ${name(e.victimId)}`, team: teamOf(e.attackerId) });
        }
        return;
      }
      case 'respawn': {
        if (live && e.carId === pid) this.hooks.onRespawn?.();
        return;
      }
      case 'pulse': {
        const team = teamOf(e.carId);
        this.surfaceImpact(e.pos, 1, TEAMS[team].secondary);
        const near = 1 - Math.min(1, camDist(e.pos) / 16);
        if (e.carId === pid && live) {
          this.input.rumble(0.55, 0.75, 170);
          rig.shake(0.35);
          this.flash(TEAMS[team].secondary, 0.14);
        } else if (near > 0) rig.shake(0.25 * near);
        if (live && pid >= 0 && e.hitCarIds.includes(pid) && e.carId !== pid) this.input.rumble(0.6, 0.5, 160);
        return;
      }
      case 'chargeChange': {
        // The chain owner is tracked from the live event stream: a decay keeps the team (or drops to neutral), a
        // steal hands the core to the other team at level I. (Replayed / attract events never touch the tracker.)
        const notes = this.notes;
        const prevTeam = notes.chargeTeam;
        if (live) {
          notes.chargeTeam = e.level > 0 ? e.team : -1;
          // a SUPERNOVA banner is stale news once the core drops below III (stolen, decayed, kickoff reset)
          if (e.prevLevel >= 3 && e.level < 3) this.ui.dismissBanner?.('supernova');
        }
        if (e.team === -1 || e.level <= 0) return; // neutral again (decay I → 0 / kickoff): silent
        const team = e.team;
        if (e.level >= 3 && e.prevLevel < 3) {
          this.flash(TEAMS[team].secondary, mode === 'attract' ? 0.15 : 0.3);
          if (live) {
            const mine = pid >= 0 && team === teamOf(pid);
            // big banner: the match's first SUPERNOVA (teaches the rule) and the player's team's first one
            const big = notes.supernovas === 0 || (mine && !notes.mineSupernovaBig);
            notes.supernovas++;
            if (big && mine) notes.mineSupernovaBig = true;
            this.notify({ kind: 'supernova', title: 'SUPERNOVA!', subtitle: `${TEAMS[team].name} CORE AT LEVEL III · GOALS WORTH 3`, team, big });
            if (mine) this.input.rumble(0.3, 0.6, 250);
          }
          return;
        }
        if (!live) return;
        if (e.level < e.prevLevel && team === prevTeam) {
          // 10 s without a counted touch: the chain loses a level (teaches the decay rule)
          this.notify({ kind: 'charge', title: 'CORE FADING', subtitle: `${TEAMS[team].name} ${ROMAN[e.prevLevel]} → ${ROMAN[e.level]} · TOUCH IT TO KEEP IT`, team });
        } else if (e.level === 1 && e.prevLevel >= 2 && prevTeam !== -1 && team !== prevTeam) {
          // a charged core stolen by the other team (level-I possession changes are routine: no call-out)
          this.notify({ kind: 'charge', title: 'CORE STOLEN', subtitle: `${TEAMS[team].name} BREAKS ${TEAMS[prevTeam].name}'S ${ROMAN[e.prevLevel]} CHAIN`, team });
        } else if (e.level === 2 && e.prevLevel === 1) {
          this.notify({ kind: 'charge', title: `CORE CHARGE ${ROMAN[2]}`, subtitle: `${TEAMS[team].name} · GOALS WORTH 2`, team });
        }
        return;
      }
      case 'goal': {
        if (live) this.notes.stoppage = true;
        arena.onGoal(e.team, e.pos);
        if (mode === 'replay') {
          this.flash(TEAMS[e.team].secondary, 0.15);
          rig.shake(0.35);
          return;
        }
        this.flash(TEAMS[e.team].secondary, mode === 'attract' ? 0.45 : 0.85);
        rig.shake(mode === 'attract' ? 0.35 : 0.8);
        this.hooks.onGoal(e, mode);
        if (!live) return;
        const pt = teamOf(pid);
        const kmh = Math.round(e.ballSpeed * KMH);
        if (pid >= 0) {
          if (e.team === pt) this.input.rumble(0.8, 1, e.scorerId === pid ? 520 : 380);
          else this.input.rumble(0.35, 0.25, 220);
        }
        if (e.ownGoal) {
          const last = s.world.ball.lastTouchCarId;
          this.notify({ kind: 'ownGoal', title: 'OWN GOAL', subtitle: last >= 0 ? `${name(last)} · ${kmh} KM/H` : `${kmh} KM/H`, team: e.team, points: e.points, big: true });
          return;
        }
        const scorer = name(e.scorerId);
        const sc = e.scorerId >= 0 ? s.world.cars[e.scorerId] : null;
        const hatTrick = !!sc && sc.stats.goals === 3;
        // (the hat trick rides in the goal banner: a second big banner would be queued onto the instant replay)
        const prefix = (e.points >= 3 ? 'SUPERNOVA ×3 · ' : e.points === 2 ? 'CHARGED ×2 · ' : '') + (hatTrick ? 'HAT TRICK · ' : '');
        const who = e.scorerId === pid ? 'YOU SCORED' : `${scorer} SCORES`;
        this.notify({ kind: 'goal', title: 'GOAL!', subtitle: `${prefix}${who} · ${kmh} KM/H`, team: e.team, points: e.points, big: true });
        if (e.assistId >= 0) this.notify({ kind: 'assist', title: 'ASSIST', subtitle: name(e.assistId), team: e.team, points: STAT_POINTS.assist });
        if (hatTrick) this.notify({ kind: 'hatTrick', title: 'HAT TRICK', subtitle: `${scorer} · 3 GOALS`, team: e.team });
        return;
      }
      case 'save': {
        if (!live) return;
        const team = teamOf(e.carId);
        if (e.carId === pid) {
          if (e.epic) this.notify({ kind: 'epicSave', title: 'EPIC SAVE!', subtitle: name(e.carId), team, points: STAT_POINTS.epicSave, big: true });
          else this.notify({ kind: 'save', title: 'SAVE', subtitle: name(e.carId), team, points: STAT_POINTS.save });
          this.input.rumble(0.3, 0.5, 140);
        } else {
          this.notify({ kind: e.epic ? 'epicSave' : 'save', title: e.epic ? 'EPIC SAVE' : 'SAVE', subtitle: name(e.carId), team, points: e.epic ? STAT_POINTS.epicSave : STAT_POINTS.save });
        }
        return;
      }
      case 'shot': {
        if (live && e.carId === pid) this.notify({ kind: 'shot', title: 'SHOT ON GOAL', subtitle: name(e.carId), team: teamOf(pid), points: STAT_POINTS.shot });
        return;
      }
      case 'countdown': {
        if (live) {
          this.ui.showCountdown(e.value);
          if (e.value >= 3) {
            // kickoff reset: play resumes, the core is neutral
            this.notes.stoppage = false;
            this.notes.chargeTeam = -1;
          }
        }
        // the first 'countdown' 3 is the match start; later ones follow a kickoff reset (goal / overtime)
        if (e.value >= 3 && s.countdownsSeen > 1) this.hooks.onKickoffReset(mode);
        return;
      }
      case 'kickoff': {
        if (live) this.ui.showCountdown('GO');
        this.hooks.onKickoff(mode);
        return;
      }
      // (surge news during a goal stoppage is dropped: the HUD surge widget and the purple grade carry it once play
      // resumes, and nothing stale lands on the instant replay)
      case 'surgeWarning': {
        // the HUD surge widget counts 3-2-1 and the alarm sounds: a feed line is enough
        if (live && !this.notes.stoppage) this.notify({ kind: 'surge', title: `ZERO-G SURGE IN ${Math.round(e.seconds)}…`, subtitle: 'BRACE FOR LOW GRAVITY' });
        return;
      }
      case 'surgeStart': {
        rig.shake(mode === 'attract' ? 0.12 : 0.28);
        this.flash('#b44dff', mode === 'attract' ? 0.12 : 0.25);
        if (live) {
          this.input.rumble(0.25, 0.4, 300);
          if (this.notes.stoppage) return;
          // (cars fall at 55 % gravity and the ball floats at 30 %: no single percentage in the copy)
          const m = s.world.match;
          const lastMinute =
            !m.freePlay && !m.overtime && s.config.durationSec > 60 && !this.notes.lastMinute && Math.abs(m.clock - 60) <= LAST_MINUTE_SURGE_WINDOW;
          if (lastMinute) this.notes.lastMinute = true;
          this.notify({ kind: 'surge', title: 'ZERO-G SURGE!', subtitle: lastMinute ? 'LOW GRAVITY · 10 SECONDS · LAST MINUTE' : 'LOW GRAVITY · 10 SECONDS · TAKE FLIGHT', big: true });
        }
        return;
      }
      case 'surgeEnd': {
        if (live && !this.notes.stoppage) this.notify({ kind: 'surge', title: 'GRAVITY RESTORED', subtitle: 'ZERO-G SURGE OVER' });
        return;
      }
      case 'overtime': {
        // the banner is shown by the game after the overtime kickoff countdown (it would cover the 3-2-1)
        if (live) this.hooks.onOvertime();
        return;
      }
      case 'matchEnd': {
        if (live) this.notes.stoppage = false;
        if (live || mode === 'attract') this.hooks.onMatchEnd(e);
        return;
      }
      default:
        return;
    }
  }

  private cur: MatchSession | null = null;
  private readonly name = (id: number): string => {
    const cars = this.cur ? this.cur.world.cars : null;
    return cars && id >= 0 && id < cars.length ? cars[id].name : '—';
  };
  private readonly teamOf = (id: number): Team => {
    const cars = this.cur ? this.cur.world.cars : null;
    return cars && id >= 0 && id < cars.length ? cars[id].team : 0;
  };

  /** Live notifications. While play is stopped for a goal only the goal banners stay big (no banner lands on the
   * instant replay or on the next kickoff countdown). */
  private notify(n: HudNotification): void {
    if (n.big && this.notes.stoppage && n.kind !== 'goal' && n.kind !== 'ownGoal') n = { ...n, big: false };
    this.ui.notify(n);
  }

  private flash(color: string, strength: number): void {
    this.render.flash(color, strength * this.flashScale);
  }

  /** Ripple on the nearest arena surface below / beside a point (pulses, demolitions). */
  private surfaceImpact(p: Vec3Like, strength: number, color: string): void {
    const d = arenaSDF(p.x, p.y, p.z);
    if (d > 6) {
      // mid-air: ripple on the floor right below
      _p.set(p.x, 0.02, p.z);
      this.render.arena.onImpact(_p, UP, strength * 0.8, color);
      return;
    }
    arenaNormal(p.x, p.y, p.z, _n);
    _p.set(p.x, p.y, p.z).addScaledVector(_n, -d);
    this.render.arena.onImpact(_p, _n, strength, color);
  }
}

/** Distance from the camera (captured at the start of route()) to a point. */
function camDistance(p: Vec3Like): number {
  const dx = p.x - _cam.x;
  const dy = p.y - _cam.y;
  const dz = p.z - _cam.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
