# NOVABALL — Game Design & Architecture

> **Hover-car football at the edge of the galaxy.**
> Mag-lev strikers, a living plasma ball that gets more valuable the longer your team keeps it, shockwave pulses,
> and zero-gravity surges in a holographic stadium floating above a ringed gas giant.

Single-player vs AI (1v1 / 2v2 / 3v3) in the browser, with an on-chain economy on Arbitrum (NOVA rewards, NFT
cosmetics — see "On-chain layer"). Multiplayer comes later; the architecture is built for it.

---

## 1. Pitch — what's familiar, what's new

Familiar (inspired by car-soccer): cars that drive, boost, jump, double-jump, dodge-flip, air-roll and ride the walls;
a big ball; two goals; kickoffs; short matches (2:00 by default); boost pads; demolitions; ball-cam.

New in NOVABALL:

| Mechanic | Rule | Why it's fun |
|---|---|---|
| **CORE CHARGE** | The ball ("Nova Core") charges with each *consecutive* touch by the same team: I → II → III (**SUPERNOVA**). A goal is worth the charge level (1–3 points). An opponent touch steals the core back to level I for their team. Charge decays one level after 10 s without a counted touch. Touches only count if ≥ 0.5 s apart and with ≥ 3 m/s closing speed (no dribble-farming). | Possession & passing matter; every touch has stakes; comebacks are always possible; "SUPERNOVA incoming!" creates huge tension. |
| **NOVA PULSE** | Press **F** to release a radial shockwave (8 m radius, 10 s cooldown): blasts the ball away from you and shoves nearby **rivals** (teammates are never pushed). Counts as a touch. | Gives newcomers a way to affect the ball without mechanics; gives experts a clutch save / redirect tool. Spectacular visual. |
| **ZERO-G SURGE** | Every 60 s of match clock a 3 s warning, then 10 s of low gravity: the ball floats at 30 % gravity, cars fall at 55 % (jumps stay controllable, nobody parks on the ceiling). | Aerial chaos anyone can enjoy; the stadium visibly changes mood (purple grade, swirling stars). Great for demos. |
| **Mag-lev hover cars** | Vehicles hover 25 cm above any surface on a mag-grip field; stick to walls, fall from ceilings. | Visual identity (glowing hover pads, thruster plumes) instead of wheels. |

Presentation hooks judges will notice in 60 seconds: attract-mode AI match behind the main menu (2v2 PRO bots, a director that
cuts to the goal mouth when a goal is coming, re-seeded after 75 s without a goal), goal slow-mo + explosion + replay,
force-field walls that ripple on impact, reflective neon floor, SUPERNOVA ball, surge color shift, procedural synthwave soundtrack.

## 2. Rules & match flow

- Teams: **VOLT** (team 0, cyan `#1ec8ff`, the player's team, defends −Z) vs **BLAZE** (team 1, orange `#ff6a1a`, defends +Z).
- Modes: 1v1, 2v2, 3v3 vs bots (Rookie / Pro / Legend). In 2v2 **Rookie** the player's wingman is a **Pro** bot (its own
  bot manager) against Rookie opponents, so a first match is winnable. Free Play (just you + ball, no clock, `R` resets).
- Duration: 2 (default, "SPRINT") / 3 / 5 min. Clock runs only in phase `playing`.
- Tied at 0:00 → **Overtime**, next goal wins (clock counts up).
- Kickoff: cars on kickoff spots, ball at center, 3-2-1-GO (cars frozen during the countdown).
- Goal: ball fully crosses the goal line (`|z| > halfLength + ballRadius`). Points = charge level if the charge belongs to the
  scoring team, else 1. Own goals: 1 point to the other team.
- After a goal (sim phase `goal`, 3 s of sim time): ball explodes, cars can keep driving; the game layer shows slow-mo then an
  instant replay (sim paused), then the sim finishes the goal phase and starts the next kickoff.
- Mutators (all on by default, toggleable in match setup): Core Charge, Nova Pulse, Zero-G Surges, Demolitions.
- Demolition: a supersonic car hitting an opponent with its front destroys it; respawn after 3 s near own goal.
- Upside down / on its side: press jump (any speed) to self-right; it also happens automatically after 0.8 s.

### Match flow timings (game layer)
1. `countdown` (3 s): big 3-2-1 numbers, camera behind player, "GO!" on kickoff event.
2. `playing`.
3. Goal event → time scale 0.25 for 0.9 s (real time), ramp back to 1 over 0.4 s (the explosion VFX run at ≥ 0.6× real time
   meanwhile); explosion; screen flash; shake; crowd roar; "GOAL!" banner (scorer name, points, "SUPERNOVA ×3" if charge 3,
   ball speed km/h).
4. At goal-phase time ≥ 1.8 s: **replay** of the last ~3.5 s before the goal (+0.75 s after) with cinematic camera (chase →
   goal mouth → hero shot), "REPLAY" tag, skippable with Jump / Enter / A. Sim is paused during the replay; banners are cleared.
5. The rest of the goal phase is fast-forwarded → next kickoff countdown (unskipped goal → kickoff ≈ 11 s).
6. Match end → "FULL TIME" banner, podium camera on the MVP (best score on the winning team), end screen (score, MVP, stats,
   the match's seed + state hash), Rematch / Main Menu.

Notifications: big banners are reserved for goals, the ZERO-G SURGE start (it carries "LAST MINUTE" when they coincide),
demolitions / epic saves of the player, and SUPERNOVA (the match's first one and the player's team's first one). Routine cues
(surge warning, last minute, core charge II, core fading / stolen) are side-feed lines; during a goal stoppage only goal
banners are big, and nothing is shown over the replay.

## 3. Controls

| Action | Keyboard / Mouse | Gamepad (standard mapping) |
|---|---|---|
| Throttle / Reverse (air: pitch) | W / S (or ↑ / ↓) | RT / LT (pitch: left stick Y) |
| Steer (air: yaw) | A / D (or ← / →) | Left stick X |
| Jump / Double jump / Dodge (jump + direction); self-right when upside down | Space or Right Mouse | A |
| Boost | Shift or Left Mouse | B |
| Powerslide (ground) / Free air roll (air) | C or Left Alt | X |
| Air roll left / right | Q / E | LB / (none) |
| NOVA PULSE | F | RB |
| Ball cam toggle | Tab | Y |
| Pause | Esc | Start |
| Skip replay | Space / Enter | A |
| Reset (Free Play) | R | Back/View |

Never bind Ctrl (Ctrl+W closes the tab). All game keys call `preventDefault`. Right-click context menu disabled on the canvas.

## 4. Art direction — "Neon Orbital"

Night-time sci-fi stadium floating in space. Dark, glossy, emissive; bloom does the heavy lifting.

- **Sky:** deep-space nebula (purple / teal / magenta fbm clouds) with dense twinkling star field, baked once into a cube map at load.
  A huge ringed gas giant low on the horizon behind one end, with an atmospheric rim glow. Distant sun with lens glow.
- **Arena:** mirror-dark floor (`#05070d`) with planar reflections (roughness-blurred), a subtle hex micro-grid, emissive field markings
  (center circle, midline, goal arcs) tinted per half in team colors, and colored light pools that follow cars (hover glow) and the ball.
  Walls & ceiling are translucent **force fields**: fresnel-lit hexagonal energy mesh, faint scanlines, brighter edges along fillets,
  **ripples** that propagate from ball/car impacts. Goal frames are thick glowing tubes in team color; the goal interior is an animated
  energy vortex; nets are hex-grid light.
- **Stadium:** tiered stands outside the force field with thousands of instanced crowd lights that flicker, wave and flash in team
  colors on goals; floodlight towers with volumetric beams; floating holo-screens showing the score.
- **Cars:** sleek procedural hover cars (3 body styles), clearcoat paint (MeshPhysicalMaterial) reflecting the stadium env map,
  team-colored emissive trims, glass canopy, 4 glowing hover pads underneath, twin thrusters with animated plasma plumes (boost),
  ribbon trails in team color, supersonic shimmer trail, subtle banking on turns.
- **Ball:** plasma "Nova Core" — animated noise-driven emissive core + hex shell + fresnel rim + real point light. Color/brightness by
  charge: neutral pearl-white → team-tinted I/II → SUPERNOVA (white-hot core, team-colored corona, sparks, heavy bloom). Ball trail at speed.
  Ground marker (circle projected under the ball) for readability.
- **VFX:** sparks on hits (stretched additive particles), shock rings on strong hits and pulses, goal explosion (massive burst, ring,
  debris, light flash, lingering embers), demolition explosion, boost pad pickup bursts, landing dust, hover shimmer.
- **Post:** HDR half-float pipeline, mipmap bloom, ACES/AgX tone mapping, SMAA or MSAA, vignette, speed-driven chromatic aberration,
  radial speed lines at supersonic, subtle film grain in replays, surge color grade (purple shift).
- **UI:** Orbitron (display) + Rajdhani (body) from `@fontsource`. Glassmorphism panels with neon edges, animated gradients,
  skewed/angled cards. HUD minimal and readable at a glance.

## 5. Audio direction (100 % procedural Web Audio)

Engine hum per car (sawtooth + filtered noise, pitch by speed, 3D-panned), boost roar (band-passed noise + low rumble), jump whoosh,
dodge swish, ball hits (punchy transient + tonal thump, loudness by strength, bright "zap" for charged ball), wall bounces, boost
pickups (rising chime), pulse (sub drop + shimmer), demolition (explosion), goal (huge boom + crowd roar + team horn), countdown beeps,
surge warning (alarm swell) + surge hum, crowd bed that reacts to action, UI clicks. Music: procedural synthwave (bass arp, pads, drums)
with intensity layers; menu variant; overtime variant.

## 6. Architecture

```
index.html                  canvas#game + div#ui
src/main.ts                 bootstrap → new Game(...)
src/game/Game.ts            orchestrator: app states (loading/menu/match/paused/replay/ended), fixed-step loop, wiring   [integration]
src/game/Replay.ts          snapshot ring buffer (+ event log) and playback                                                 [integration]
src/contracts.ts            module interfaces                                                                               [contract]
src/settings.ts, theme.ts   settings persistence, colors/names                                                             [contract]
src/sim/constants.ts        ALL gameplay tuning                                                                             [contract]
src/sim/types.ts            state / controls / events / snapshots                                                           [contract]
src/sim/arena.ts            arena SDF (collision geometry shared with rendering)                                           [contract]
src/sim/*.ts                World, car, ball, collisions, pads, match rules, charge, pulse, surge, snapshot, predict        [sim]
src/ai/*.ts                 BotManager + bot brains                                                                         [ai]
src/render/RenderSystem.ts, PostFX.ts, Environment.ts, ArenaView.ts, CameraRig.ts (+ helpers)                               [render-world]
src/render/CarView.ts, BallView.ts, BoostPadsView.ts, VFXSystem.ts (+ helpers)                                               [render-actors]
src/audio/*.ts              AudioSystem (+ helpers)                                                                          [audio]
src/input/InputSystem.ts    keyboard / mouse / gamepad                                                                       [ui]
src/ui/*.ts, src/ui/*.css   UIManager, menus, HUD                                                                           [ui]
tests/**                    vitest (node) — sim, AI soak tests
dev/*.html, dev/*.ts        per-module visual sandboxes (served by vite at /dev/<name>.html)
scripts/shot.mjs            headless Chrome screenshot/console helper (uses the real GPU via ANGLE-GL)
```

### Main loop (Game.ts)
- `renderer.setAnimationLoop`. Real `dt` clamped to 0.1 s. Accumulator × timeScale (slow-mo), fixed `DT = 1/120`.
- Per sim tick: `input.sample(inputs[0])` for the player; `bots.update(world, inputs)`; `world.step(inputs)`; keep previous & current
  snapshots; record into the replay buffer.
- Per frame: `lerpSnapshot(prev, curr, alpha)` → views (CarView/BallView/BoostPadsView/VFX/Arena) → camera rig → audio → HUD → `render.render()`.
- Events drained once per frame → VFX, audio, UI notifications, arena ripples, camera shake, rumble, render flash.

### Determinism rules (sim only — `src/sim/**`)
- Fixed step; no dependence on frame rate; no `Date`, no `performance.now`, no `Math.random` (use the seeded RNG in the sim).
- Only `+ - * /`, `Math.sqrt`, `abs/min/max/floor/sign` in sim math. No `Math.sin/cos/tan/atan2/acos/exp/pow/log` (they are not
  bit-exact across JS engines). three.js `Vector3/Quaternion` arithmetic is OK (avoid `setFromAxisAngle`, `setFromEuler`, `slerp`,
  `angleTo`, `Matrix4.makeRotation*`). Integrate orientation as `q += 0.5·ω⊗q·dt; q.normalize()`.
- Same config + same input sequence ⇒ identical `world.hash()` on every engine. (This is what makes on-chain match verification and
  lockstep/rollback multiplayer possible later.)

### Performance budget
- Target: 60 FPS on Intel UHD 770 (this dev machine) at 1600×900 on "high" with dynamic resolution; 144+ FPS on mid-range discrete GPUs.
- ≤ 150 draw calls in a 3v3 match. Instancing for pads / crowd / particles. Merged static geometry. No per-frame allocations in hot
  paths (reuse vectors/arrays). No dynamic shadow casters except cars + ball. Real lights: 1 directional (shadows) + hemisphere +
  env map + ball point light. Everything else = emissive + bloom or shader "fake lights".
- Pre-compile shaders during loading (`renderer.compileAsync`) to avoid first-use hitches.

### Build, deploy, debug
- Node ≥ 22.12 (`.nvmrc`), `npm run build` → `dist/`. The build uses relative asset URLs (`base: './'`), so `dist/` works from any
  path: a site root, a GitHub Pages project subpath (`/novaball/`), IPFS.
- `index.html` paints a static branded splash before any JS and carries a boot watchdog: a bundle that fails to load or to run
  shows a "could not start" message instead of a dark page.
- Debug / test API `window.__novaball`: the full API (startMatch, placeBall, endSoon, setTimeScale, …) exists in dev builds and
  with `?debug=1`; a normal production page only exposes the read-only `state()`.
- Saved settings are sanitized on load (bad values fall back to defaults); the boot-failure screen offers RESET SETTINGS.

### On-chain layer (Arbitrum)
- `src/chain/` (viem): `NovaChain` is the single service + observable store — wallet (guest key in localStorage, or an
  EIP-6963 browser wallet), NOVA balance, garage catalog + NFT ownership, activity log, match rewards and purchases.
  `config.ts` picks the chain (`VITE_CHAIN_ID`) and reads `deployments/<chainId>.json` written by the Foundry deploy
  script; no deployment ⇒ features off, every cosmetic unlocked.
- `server/relayer.ts`: the game server. `POST /api/match` records the match on `NovaArena` (mints NOVA);
  `POST /api/purchase` submits the player's EIP-712 purchase (+ ERC-2612 permit) to `NovaGarage` and pays the gas.
  Mounted by the Vite dev/preview server (`server/vite.ts`) and the production server (`server/node.ts`).
- UI: wallet card on the title screen, WALLET panel, garage locks / price tags / BUY, NOVA EARNED card on the end
  screen (`UIManager` reports the match and enforces ownership of the equipped cosmetics).
- Contracts, trust model and economy: `../contracts/README.md`.

### Built for on-chain & multiplayer
- Deterministic sim + input log ⇒ replays can be re-simulated and hashed; a match result can be verified by any node. The end
  screen already shows the match seed and the sim's state hash on the final tick (`MatchSummary.hash`).
- `MatchConfig.seed` fixes every random decision (kickoff spots, bot noise).
- Cosmetics (`CarStyleId`, paint) are data-driven — ready to be backed by NFTs / on-chain inventory.
- Clean `ControlState` boundary between input/bots and sim ⇒ drop-in network transport.

## 7. Coding rules (all agents)

- TypeScript strict. ES modules. Import three as `import { X } from 'three'`; addons from `'three/addons/...'` (e.g.
  `three/addons/utils/BufferGeometryUtils.js`); post-processing from `'postprocessing'`.
- Installed deps ONLY: `three@0.186`, `postprocessing@6.39`, `@fontsource/orbitron`, `@fontsource/rajdhani`, `viem` (chain
  layer + relayer), `vite`, `vitest`, `typescript`, `playwright` (dev). Do not add packages.
- Everything procedural — no external asset files or CDNs (fonts come from @fontsource).
- Only edit files you own (see §6) plus new files inside your own directories. Contract files are read-only — if you truly need a
  change, add an optional member and explain it in your final report.
- Reuse objects in per-frame code; dispose GPU resources in `dispose()`.
- `npx tsc --noEmit -p tsconfig.json` must report no errors in your files (other agents' in-progress files may temporarily have errors —
  filter output by your paths).
- Visual modules: build a sandbox page in `dev/` and look at it with `node scripts/shot.mjs http://localhost:<port>/dev/<page>.html --out <png>`
  (then Read the PNG). Start your own vite on your assigned port: `npx vite --port <port> --strictPort` (run in background).
