/**
 * NOVABALL — inline SVG icon library (all procedural, no asset files).
 * Icons use `currentColor`, viewBox 0 0 24 24. Car silhouettes use CSS vars (--paint, --trim).
 */
import type { CarStyleId } from '../sim/types';

const S = (body: string, extra = '') =>
  `<svg class="nb-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

function starPath(cx: number, cy: number, spikes: number, r1: number, r2: number, rot = -Math.PI / 2): string {
  let d = '';
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? r1 : r2;
    const a = rot + (i * Math.PI) / spikes;
    d += `${i === 0 ? 'M' : 'L'}${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`;
  }
  return d + 'Z';
}

function arc(cx: number, cy: number, r: number, a0Deg: number, a1Deg: number): string {
  const a0 = (a0Deg * Math.PI) / 180;
  const a1 = (a1Deg * Math.PI) / 180;
  const x0 = cx + Math.cos(a0) * r;
  const y0 = cy + Math.sin(a0) * r;
  const x1 = cx + Math.cos(a1) * r;
  const y1 = cy + Math.sin(a1) * r;
  const large = Math.abs(a1Deg - a0Deg) > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export const ICONS = {
  /** CORE CHARGE: orb with charge arcs. */
  charge: S(
    `<circle cx="8.5" cy="12" r="4.4" fill="currentColor" fill-opacity=".22"/><circle cx="8.5" cy="12" r="1.7" fill="currentColor" stroke="none"/>` +
      `<path d="${arc(8.5, 12, 7, -38, 38)}"/><path d="${arc(8.5, 12, 9.8, -40, 40)}" stroke-opacity=".75"/><path d="${arc(8.5, 12, 12.6, -41, 41)}" stroke-opacity=".5"/>`,
  ),
  /** NOVA PULSE: shockwave rings. */
  pulse: S(
    `<circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="5.6"/>` +
      `<path d="${arc(12, 12, 9.6, -70, -20)}"/><path d="${arc(12, 12, 9.6, 20, 70)}"/><path d="${arc(12, 12, 9.6, 110, 160)}"/><path d="${arc(12, 12, 9.6, 200, 250)}"/>`,
  ),
  /** ZERO-G SURGE: lift-off chevrons over a curved horizon. */
  surge: S(
    `<path d="M3.5 19c2.6 1.4 5.4 2.1 8.5 2.1s5.9-.7 8.5-2.1"/><path d="M7.5 15.2 12 10.8l4.5 4.4" stroke-opacity=".55"/><path d="M7.5 10.6 12 6.2l4.5 4.4"/><circle cx="12" cy="2.9" r="1.5" fill="currentColor" stroke="none"/>`,
  ),
  /** DEMOLITIONS: explosion burst. */
  demo: S(`<path d="${starPath(12, 12, 8, 10.4, 4.6)}" fill="currentColor" fill-opacity=".22"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>`),
  goal: S(
    `<path d="M2.8 19.5V6.5h18.4v13"/><path d="M2.8 10.8h18.4M2.8 15.1h18.4M7.4 6.5v13M12 6.5v13M16.6 6.5v13" stroke-opacity=".3" stroke-width="1.2"/><circle cx="12" cy="14.6" r="3.2" fill="currentColor" stroke="none"/>`,
  ),
  save: S(`<path d="M12 2.6 19.6 5.6v5.8c0 4.6-3.2 8.4-7.6 9.9-4.4-1.5-7.6-5.3-7.6-9.9V5.6z" fill="currentColor" fill-opacity=".2"/><path d="m8.4 12 2.5 2.5 4.8-5"/>`),
  assist: S(`<path d="m3.5 6.5 5.5 5.5-5.5 5.5M10.5 6.5l5.5 5.5-5.5 5.5"/><circle cx="19.6" cy="12" r="2" fill="currentColor" stroke="none"/>`),
  shot: S(`<circle cx="12" cy="12" r="7.4"/><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><path d="M12 1.8v4.2M12 18v4.2M1.8 12H6M18 12h4.2"/>`),
  supernova: S(
    `<path d="${starPath(12, 12, 4, 10.5, 3.2)}" fill="currentColor" fill-opacity=".35"/><path d="${starPath(12, 12, 4, 6.2, 2.2, -Math.PI / 4)}" stroke-opacity=".6"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/>`,
  ),
  clock: S(`<circle cx="12" cy="12" r="9"/><path d="M12 6.5V12l3.6 2.4"/>`),
  overtime: S(`<circle cx="11" cy="13" r="8"/><path d="M11 8.5V13l3 2"/><path d="M19 1.8v5M16.5 4.3h5"/>`),
  hatTrick: S(
    `<circle cx="7" cy="16" r="3.6" fill="currentColor" fill-opacity=".3"/><circle cx="17" cy="16" r="3.6" fill="currentColor" fill-opacity=".3"/><circle cx="12" cy="7.6" r="3.6" fill="currentColor" fill-opacity=".3"/>`,
  ),
  info: S(`<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/>`),
  ballCam: S(
    `<circle cx="12" cy="12" r="4.2" fill="currentColor" fill-opacity=".3"/><path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16"/>`,
  ),
  back: S(`<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>`),
  chevron: S(`<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>`),
  check: S(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`, ' stroke-width="2.6"'),
  star: S(`<path d="${starPath(12, 12.6, 5, 10, 4.2)}" fill="currentColor" stroke-width="1.2"/>`),
  bot: S(`<rect x="4.5" y="8" width="15" height="11" rx="3"/><circle cx="9.5" cy="13.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="14.5" cy="13.5" r="1.4" fill="currentColor" stroke="none"/><path d="M12 8V4.5M10 4h4"/>`),
  pilot: S(`<path d="M4.5 14.5a7.5 7.5 0 0 1 15 0V18a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/><path d="M6.5 13.5h11v2.8h-11z" fill="currentColor" fill-opacity=".35"/>`),
  trophy: S(`<path d="M7 3.5h10v5.5a5 5 0 0 1-10 0z" fill="currentColor" fill-opacity=".2"/><path d="M7 5H3.5v1.5A3.5 3.5 0 0 0 7 10M17 5h3.5v1.5A3.5 3.5 0 0 1 17 10M12 14v3.5M8 20.5h8M9.5 17.5h5v3h-5z"/>`),
  play: S(`<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" fill-opacity=".25"/>`),
  freePlay: S(`<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5c-2.5 2.6-3.7 5.4-3.7 8.5s1.2 5.9 3.7 8.5M12 3.5c2.5 2.6 3.7 5.4 3.7 8.5s-1.2 5.9-3.7 8.5M3.8 9.5h16.4M3.8 14.5h16.4" stroke-opacity=".6" stroke-width="1.3"/>`),
  garage: S(`<path d="M2.5 15.5 4.6 10a2.4 2.4 0 0 1 2.2-1.5h8.8c.8 0 1.6.4 2 1.1l3.9 5.9v2a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z"/><path d="M6.5 19.8h2.5M15 19.8h2.5" stroke-width="2.4"/><path d="M8.5 8.5 10 5h5.5l2 3.5" stroke-opacity=".6"/>`),
  settings: S(
    `<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"/><circle cx="12" cy="12" r="6.6" stroke-opacity=".55"/>`,
  ),
  gamepad: S(
    `<path d="M7.2 7h9.6a4.6 4.6 0 0 1 4.5 3.7l.9 4.9a2.6 2.6 0 0 1-4.5 2.2L15.9 16H8.1l-1.8 1.8a2.6 2.6 0 0 1-4.5-2.2l.9-4.9A4.6 4.6 0 0 1 7.2 7z"/><path d="M7.5 10v3.4M5.8 11.7h3.4"/><circle cx="16" cy="10.6" r="1" fill="currentColor" stroke="none"/><circle cx="17.8" cy="12.8" r="1" fill="currentColor" stroke="none"/>`,
  ),
  keyboard: S(`<rect x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6 9.5h1M9.5 9.5h1M13 9.5h1M16.5 9.5h1M6 12.5h1M9.5 12.5h1M13 12.5h1M16.5 12.5h1M8 15.5h8" stroke-width="1.6"/>`),
  boost: S(`<path d="M13.5 2.5 6 13.5h5.2L9.8 21.5 18 10h-5.4z" fill="currentColor" fill-opacity=".3"/>`),
  jump: S(`<path d="m6 11 6-6 6 6M6 18l6-6 6 6" />`),
  steer: S(`<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="2.2"/><path d="M3.6 11h6.3M14.1 11h6.3M12 14.2v6.2"/>`),
  drive: S(`<path d="M12 3.5v17M6 9.5l6-6 6 6M6 14.5l6 6 6-6" />`),
  roll: S(`<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.4 3.6v4.2h-4.2"/>`),
  slide: S(`<path d="M4 17c3-1 5-4 6-8 1 4 3 7 6 8M4 21h16"/><path d="M16.5 5.5 20 9" stroke-opacity=".6"/>`),
  pause: S(`<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" fill-opacity=".3"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" fill-opacity=".3"/>`),
  replay: S(`<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M3.6 3.6v4.2h4.2"/><path d="M10 9v6l5-3z" fill="currentColor"/>`),
  reset: S(`<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.4 3.6v4.2h-4.2"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>`),
  scoreboard: S(`<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18M9 9v10.5M15 9v10.5" stroke-opacity=".6"/>`),
  warning: S(`<path d="M12 3.2 21.5 20H2.5z" fill="currentColor" fill-opacity=".2"/><path d="M12 9.5v4.8"/><circle cx="12" cy="17.2" r="1.1" fill="currentColor" stroke="none"/>`),
  mouseLeft: S(`<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v6.5H6.2A6 6 0 0 1 12 3z" fill="currentColor" stroke="none"/><path d="M6 9.5h12"/>`),
  mouseRight: S(`<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v6.5h5.8A6 6 0 0 0 12 3z" fill="currentColor" stroke="none"/><path d="M6 9.5h12"/>`),
  stick: S(`<circle cx="12" cy="12" r="8.6" stroke-opacity=".55"/><circle cx="12" cy="12" r="4.4" fill="currentColor" fill-opacity=".3"/><path d="m12 1.8-1.6 1.6h3.2zM12 22.2l-1.6-1.6h3.2zM1.8 12l1.6-1.6v3.2zM22.2 12l-1.6-1.6v3.2z" fill="currentColor" stroke="none"/>`),
  /** Four corner brackets (browser fullscreen). */
  fullscreen: S(`<path d="M3.5 9V4.5a1 1 0 0 1 1-1H9M15 3.5h4.5a1 1 0 0 1 1 1V9M20.5 15v4.5a1 1 0 0 1-1 1H15M9 20.5H4.5a1 1 0 0 1-1-1V15"/>`),
  /** Speaker with sound waves. */
  sound: S(`<path d="M4 9.5h3.5L12.5 5v14l-5-4.5H4z" fill="currentColor" fill-opacity=".25"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.2 6.4a8 8 0 0 1 0 11.2" stroke-opacity=".8"/>`),
  /** Shield with a check: verifiable / deterministic match. */
  verified: S(`<path d="M12 2.6 19.6 5.6v5.8c0 4.6-3.2 8.4-7.6 9.9-4.4-1.5-7.6-5.3-7.6-9.9V5.6z" fill="currentColor" fill-opacity=".18"/><path d="m8.2 12.2 2.6 2.6 5-5.2"/>`),
  /** Light bulb (tips). */
  tip: S(`<path d="M9 17.5h6M10 20.5h4"/><path d="M12 3.5a5.8 5.8 0 0 0-3.4 10.5c.6.5.9 1.1.9 1.8v.7h5v-.7c0-.7.3-1.3.9-1.8A5.8 5.8 0 0 0 12 3.5z" fill="currentColor" fill-opacity=".2"/>`),
  /** NOVA token: hex coin with a four-point star. */
  nova: S(`<path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5z" fill="currentColor" fill-opacity=".18"/><path d="M12 6.6c.5 3 1.9 4.4 4.9 4.9-3 .5-4.4 1.9-4.9 4.9-.5-3-1.9-4.4-4.9-4.9 3-.5 4.4-1.9 4.9-4.9z" fill="currentColor" stroke-width="1.2"/>`),
  /** Wallet. */
  wallet: S(`<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h11.5v3"/><rect x="3.5" y="8" width="17" height="11.5" rx="2.2" fill="currentColor" fill-opacity=".16"/><path d="M20.5 11.5h-4a2 2 0 0 0 0 4h4"/><circle cx="16.7" cy="13.5" r=".9" fill="currentColor" stroke="none"/>`),
  /** Padlock (locked cosmetic). */
  lock: S(`<rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor" fill-opacity=".2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/><path d="M12 14.3v2.6"/>`),
  /** Arrow out of a box (open in the block explorer). */
  external: S(`<path d="M13.5 4.5h6v6M19.5 4.5 11 13"/><path d="M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10"/>`),
  /** Two sheets (copy). */
  copy: S(`<rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="currentColor" fill-opacity=".16"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>`),
  /** Key (export the guest wallet). */
  key: S(`<circle cx="8" cy="15.5" r="4" fill="currentColor" fill-opacity=".16"/><path d="m10.9 12.6 8.6-8.6M16.5 7l2.5 2.5M14.2 9.3l2 2"/>`),
  /** Chain links (on-chain). */
  chain: S(`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1.2-1.2"/>`),
  /** Arc spinner (rotate with CSS). */
  spinner: S(`<circle cx="12" cy="12" r="8.5" stroke-opacity=".2"/><path d="${arc(12, 12, 8.5, -90, 30)}"/>`, ' stroke-width="2.4"'),
} as const;

export type IconName = keyof typeof ICONS;

/** Hex outline used by the Nova Pulse ability badge (viewBox 0 0 100 100). */
export const HEX_PATH = 'M50 3 91 26.5v47L50 97 9 73.5v-47z';

// ---------------------------------------------------------------------------------------------
// Car silhouettes (side profile, facing right). viewBox 0 0 340 124. Ground contact y ≈ 108.
// ---------------------------------------------------------------------------------------------

interface CarShape {
  body: string;
  glass: string;
  /** Darker lower body / skirts. */
  skirt: string;
  /** Team-color trim strokes. */
  trim: string;
  /** Extra detail strokes (panel lines). */
  detail: string;
  /** Roofline specular highlight (thin light stroke). */
  shine: string;
  /** Softer shoulder reflection line. */
  shoulder: string;
  /** Hover pad x centers. */
  pads: [number, number];
  padY: number;
  /** Thruster nozzle center (rear). */
  thruster: [number, number];
  /** Extra parts drawn in body paint (wings, fins). */
  parts?: string;
  /** Headlight strip (front). */
  lamp: string;
}

const CAR_SHAPES: Record<CarStyleId, CarShape> = {
  striker: {
    body: 'M34 74C34 64 40 57 54 55L108 50C124 39 142 33 166 32L204 32C222 33 236 41 250 51L304 64C318 67 324 72 322 79C320 86 312 89 300 89L56 92C42 92 34 86 34 74Z',
    glass: 'M114 50.5C128 42 144 37 166 36.2L202 36.2C216 37 228 43 240 51.5Z',
    skirt: 'M44 84L300 81C310 81 316 83 318 86C314 89 306 90 298 90L58 92C50 92 46 89 44 84Z',
    trim: 'M52 72L160 67L306 72',
    detail: 'M150 55L148 86M232 58L236 84M92 58L94 88',
    shine: 'M58 56.5L108 52C124 41.2 142 35.3 166 34.3L204 34.3C220 35.2 233 42 246 51.5',
    shoulder: 'M60 63L150 59.5L252 58.5L300 66',
    pads: [92, 262],
    padY: 97,
    thruster: [36, 70],
    parts: 'M42 60L50 42L86 43L82 50L66 52L62 60Z',
    lamp: 'M296 66L318 72',
  },
  viper: {
    body: 'M30 76C30 69 36 64 48 63L116 60C134 49 154 45 176 45L198 46C216 48 234 56 252 62L330 76C334 77 334 80 330 81L256 88L50 90C38 90 30 85 30 76Z',
    glass: 'M124 60C138 51.5 156 48.4 176 48.2L196 49C210 50.6 222 55 234 60.8Z',
    skirt: 'M40 85L256 84L300 82C292 86 280 88 262 89L52 90C46 90 42 88 40 85Z',
    trim: 'M46 74L180 70L326 78',
    detail: 'M168 62L166 88M240 64L244 86M100 64L102 89',
    shine: 'M52 64.6L116 62C134 51.2 154 47.3 176 47.3L198 48.3C215 50.3 232 58 250 64',
    shoulder: 'M56 70L170 66.5L262 67.5L320 76.5',
    pads: [88, 250],
    padY: 96,
    thruster: [32, 73],
    parts: 'M34 66L38 47L94 47L88 54L64 57L60 66Z',
    lamp: 'M290 71L326 77.5',
  },
  titan: {
    body: 'M30 84L31 50C31 42 37 37 47 37L78 36L98 24L204 22C218 22 228 28 236 36L256 52L302 55C314 56 320 62 320 70L320 84C320 91 314 95 304 95L44 96C35 96 30 91 30 84Z',
    glass: 'M104 36.5L114 27.5L200 26.2C210 26.4 218 30 224 36.5Z',
    skirt: 'M36 88L318 86L318 88C316 93 310 95 302 95L46 96C40 96 37 93 36 88Z',
    trim: 'M40 66L170 63L318 66',
    detail: 'M40 50L256 52M150 38L150 92M244 54L246 90M88 40L90 94M300 56V92',
    shine: 'M34 49C34 43 38 39.4 47 39.3L79 38.4L99 26.4L204 24.4C216 24.4 225 29.5 232.5 37',
    shoulder: 'M40 58L256 58.5L304 60',
    pads: [90, 262],
    padY: 104,
    thruster: [32, 62],
    parts: 'M96 22L102 16L200 15L206 21Z',
    lamp: 'M304 58L320 60M304 63L320 65',
  },
};

let carUid = 0;

/**
 * Stylized hover-car side silhouette. Colors come from CSS custom properties on an ancestor:
 * --paint (body), --trim (team neon), --glow (hover pad glow).
 */
export function carSvg(style: CarStyleId, opts: { ground?: boolean } = {}): string {
  const c = CAR_SHAPES[style];
  const id = `nbcar${++carUid}`;
  const [p0, p1] = c.pads;
  const [tx, ty] = c.thruster;
  const ground = opts.ground !== false;
  const housing = (x: number) => `<rect x="${x - 27}" y="${c.padY - 9}" width="54" height="7" rx="3.5" fill="#070b14"/>`;
  return `<svg class="nb-car-svg" viewBox="0 0 340 124" aria-hidden="true">
  <defs>
    <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".62"/>
      <stop offset=".26" stop-color="#fff" stop-opacity=".1"/>
      <stop offset=".5" stop-color="#000" stop-opacity="0"/>
      <stop offset=".86" stop-color="#000" stop-opacity=".5"/>
      <stop offset="1" stop-color="#000" stop-opacity=".7"/>
    </linearGradient>
    <linearGradient id="${id}u" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="var(--glow, #1ec8ff)" stop-opacity=".55"/>
      <stop offset=".22" stop-color="var(--glow, #1ec8ff)" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#b8e6ff" stop-opacity=".9"/>
      <stop offset=".3" stop-color="#1b3552"/>
      <stop offset="1" stop-color="#050a14"/>
    </linearGradient>
    <radialGradient id="${id}p" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#fff" stop-opacity=".95"/>
      <stop offset=".35" stop-color="var(--glow, #1ec8ff)" stop-opacity=".85"/>
      <stop offset="1" stop-color="var(--glow, #1ec8ff)" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}f" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="var(--glow, #1ec8ff)" stop-opacity=".55"/>
      <stop offset="1" stop-color="var(--glow, #1ec8ff)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id}t" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity=".95"/>
      <stop offset=".25" stop-color="var(--glow, #1ec8ff)" stop-opacity=".8"/>
      <stop offset="1" stop-color="var(--glow, #1ec8ff)" stop-opacity="0"/>
    </linearGradient>
  </defs>
  ${ground ? `<ellipse class="nb-car-floor" cx="176" cy="112" rx="156" ry="9" fill="url(#${id}f)"/>` : ''}
  <path class="nb-car-plume" d="M${tx} ${ty - 5}L${tx - 30} ${ty}L${tx} ${ty + 5}Z" fill="url(#${id}t)"/>
  ${c.parts ? `<path d="${c.parts}" fill="var(--paint)"/><path d="${c.parts}" fill="url(#${id}s)"/><path d="${c.parts}" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="1"/>` : ''}
  ${housing(p0)}${housing(p1)}
  <path d="${c.body}" fill="var(--paint)"/>
  <path d="${c.skirt}" fill="#070b14" fill-opacity=".72"/>
  <path d="${c.body}" fill="url(#${id}s)"/>
  <path d="${c.body}" fill="url(#${id}u)"/>
  <path d="${c.body}" fill="none" stroke="#000" stroke-opacity=".4" stroke-width="1.2"/>
  <path d="${c.glass}" fill="url(#${id}g)" stroke="rgba(190,230,255,.55)" stroke-width="1"/>
  <path d="${c.shine}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.4" stroke-linecap="round"/>
  <path d="${c.shoulder}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="2.2" stroke-linecap="round"/>
  <path d="${c.detail}" stroke="#000" stroke-opacity=".28" stroke-width="1.2" fill="none"/>
  <path d="${c.trim}" stroke="var(--trim, #1ec8ff)" stroke-width="2.6" fill="none" stroke-linecap="round" class="nb-car-trim"/>
  <path d="${c.lamp}" stroke="#eaffff" stroke-width="2.4" stroke-linecap="round" fill="none" class="nb-car-lamp"/>
  <ellipse cx="${tx + 1}" cy="${ty}" rx="3.2" ry="6" fill="var(--trim, #1ec8ff)"/>
  <ellipse class="nb-car-pad" cx="${p0}" cy="${c.padY}" rx="30" ry="5" fill="url(#${id}p)"/>
  <ellipse class="nb-car-pad" cx="${p1}" cy="${c.padY}" rx="30" ry="5" fill="url(#${id}p)"/>
</svg>`;
}
