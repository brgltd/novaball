/**
 * NOVABALL — boost pads (layout from constants.PAD_LAYOUT).
 */
import { Vector3 } from 'three';
import { BOOST_PADS, CAR, PAD_LAYOUT } from './constants';
import type { CarState, PadState, SimEvent } from './types';

export function createPads(): PadState[] {
  return PAD_LAYOUT.map((p, index) => ({
    index,
    big: p.big,
    pos: new Vector3(p.x, 0, p.z),
    active: true,
    timer: 0,
  }));
}

export function resetPads(pads: PadState[]): void {
  for (let i = 0; i < pads.length; i++) {
    pads[i].active = true;
    pads[i].timer = 0;
  }
}

/** Respawn timers + pickups (cars processed in id order ⇒ deterministic tie-breaks). */
export function updatePads(pads: PadState[], cars: ReadonlyArray<CarState>, dt: number, events: SimEvent[]): void {
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad.active) {
      pad.timer -= dt;
      if (pad.timer <= 0) {
        pad.timer = 0;
        pad.active = true;
      }
    }
  }
  for (let c = 0; c < cars.length; c++) {
    const car = cars[c];
    if (car.demolished || car.boost >= CAR.boostMax) continue;
    const p = car.pos;
    if (p.y > BOOST_PADS.pickupHeight) continue;
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad.active) continue;
      const r = pad.big ? BOOST_PADS.bigRadius : BOOST_PADS.smallRadius;
      const dx = p.x - pad.pos.x;
      const dz = p.z - pad.pos.z;
      if (dx * dx + dz * dz > r * r) continue;
      if (pad.big) {
        car.boost = CAR.boostMax;
        pad.timer = BOOST_PADS.bigRespawn;
      } else {
        car.boost = car.boost + BOOST_PADS.smallAmount;
        if (car.boost > CAR.boostMax) car.boost = CAR.boostMax;
        pad.timer = BOOST_PADS.smallRespawn;
      }
      pad.active = false;
      events.push({ type: 'boostPickup', carId: car.id, padIndex: pad.index, big: pad.big });
      if (car.boost >= CAR.boostMax) break;
    }
  }
}
