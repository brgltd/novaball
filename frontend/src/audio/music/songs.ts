/**
 * NOVABALL music — song data. Key: A minor (relative C major for the victory loop).
 *
 * Harmony and melodies are hand-written (the sequencer only decides WHICH layers play from the intensity), so the
 * result is always musical: chord tones on strong beats, singable hooks, synthwave staples (i–VI–III–VII,
 * VI–VII–i, the Andalusian i–VII–VI–V for overtime, IV–V–I–vi for victory).
 *
 * Patterns are 16 steps (16th notes) per bar.
 *   Drums: 'X' = 1.0, 'x' = 0.8, 'o' = 0.5, '.' = rest.
 *   Bass:  'R'/'r' root (loud/soft), 'O'/'o' octave, 'F'/'f' fifth, '~' = tie (extends the previous note), '.' rest.
 *   Arp:   indices into the chord's arp tones (-1 = rest).
 */

export interface ChordDef {
  name: string;
  /** Bass root (MIDI, octave 1–2). */
  bass: number;
  /** Pad voicing (MIDI). */
  pad: ReadonlyArray<number>;
  /** 6 arp tones, low → high (MIDI). */
  arp: ReadonlyArray<number>;
}

/** [step within the section (16ths), MIDI note, length in steps]. */
export type MelodyNote = readonly [number, number, number];

export interface SectionDef {
  /** One chord per bar. */
  chords: ReadonlyArray<ChordDef>;
  melody?: ReadonlyArray<MelodyNote>;
  /** Drum fill on the last beat of the section. */
  fill?: boolean;
  /** "Chorus" section: crash on entry, lead allowed at mid intensity, brighter pads. */
  lift?: boolean;
  /** Drop the kick & bass for the first 2 bars when intensity is low (breathing room). */
  breakdown?: boolean;
}

export interface StyleDef {
  /** Per intensity tier (0 low, 1 mid, 2 high). */
  kick: ReadonlyArray<string>;
  snare: ReadonlyArray<string>;
  clap: ReadonlyArray<string>;
  hat: ReadonlyArray<string>;
  ohat: ReadonlyArray<string>;
  bass: ReadonlyArray<string>;
  arp: ReadonlyArray<ReadonlyArray<number> | null>;
  /** When the lead melody plays. */
  lead: 'never' | 'high' | 'lift' | 'always';
  padAttack: number;
  padRelease: number;
  /** Pad brightness (0..1) at intensity 0 and 1. */
  padBright: readonly [number, number];
  padLevel: number;
  /** Tier floor (overtime is always at least mid). */
  minTier: number;
  /** Toms in fills. */
  toms: boolean;
  /** Sidechain pump depth (0..1) at tiers 0..2. */
  pump: readonly [number, number, number];
  /** Sparse high "twinkle" bells (menu atmosphere). */
  twinkle: boolean;
  /** Bass is a soft sine sub (menu / defeat) instead of the plucky saw bass. */
  subBass: boolean;
}

export interface SongDef {
  id: string;
  bpm: number;
  /** Song level (the menu plays alone, so it sits a little hotter than in-match music). */
  gain: number;
  sections: ReadonlyArray<SectionDef>;
  style: StyleDef;
}

// ---------------------------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------------------------

const Am: ChordDef = { name: 'Am', bass: 33, pad: [57, 60, 64, 71], arp: [57, 60, 64, 69, 72, 76] };
const F: ChordDef = { name: 'F', bass: 29, pad: [53, 57, 60, 64], arp: [53, 57, 60, 65, 69, 72] };
const C: ChordDef = { name: 'C', bass: 36, pad: [55, 60, 64, 71], arp: [55, 60, 64, 67, 72, 76] };
const G: ChordDef = { name: 'G', bass: 31, pad: [55, 59, 62, 69], arp: [55, 59, 62, 67, 71, 74] };
const Em: ChordDef = { name: 'Em', bass: 28, pad: [52, 55, 59, 62], arp: [52, 55, 59, 64, 67, 71] };
const Dm: ChordDef = { name: 'Dm', bass: 38, pad: [53, 57, 60, 62], arp: [50, 53, 57, 62, 65, 69] };
const E: ChordDef = { name: 'E', bass: 28, pad: [56, 59, 62, 64], arp: [52, 56, 59, 64, 68, 71] };
const Esus: ChordDef = { name: 'Esus4', bass: 28, pad: [57, 59, 64, 69], arp: [52, 57, 59, 64, 69, 71] };
// Menu voicings (lusher, wider).
const Am9: ChordDef = { name: 'Am9', bass: 33, pad: [57, 60, 64, 67, 71], arp: [57, 64, 67, 71, 72, 76] };
const Fmaj7: ChordDef = { name: 'Fmaj7', bass: 29, pad: [53, 57, 60, 64, 69], arp: [53, 60, 64, 69, 72, 76] };
const Cmaj7: ChordDef = { name: 'Cmaj7', bass: 36, pad: [55, 59, 64, 67, 71], arp: [55, 64, 67, 71, 72, 79] };
const G6: ChordDef = { name: 'G6', bass: 31, pad: [55, 59, 62, 64, 71], arp: [55, 62, 64, 71, 74, 76] };

// ---------------------------------------------------------------------------------------------
// Melodies (hand-composed hooks)
// ---------------------------------------------------------------------------------------------

/** Verse hook over Am–F–C–G: dotted "3+3+2" rhythm, descending answer phrases. */
const MEL_A: ReadonlyArray<MelodyNote> = [
  [0, 76, 3], [3, 76, 3], [6, 74, 2], [8, 72, 4], [12, 74, 2], [14, 76, 2],
  [16, 69, 3], [19, 69, 3], [22, 72, 2], [24, 77, 4], [28, 76, 4],
  [32, 79, 3], [35, 79, 3], [38, 76, 2], [40, 72, 4], [44, 74, 2], [46, 76, 2],
  [48, 74, 6], [54, 71, 2], [56, 74, 4], [60, 67, 4],
];

/** Chorus over F–G–Em–Am: higher, longer notes. */
const MEL_B: ReadonlyArray<MelodyNote> = [
  [0, 81, 6], [6, 79, 2], [8, 77, 4], [12, 76, 4],
  [16, 74, 6], [22, 76, 2], [24, 79, 4], [28, 83, 4],
  [32, 83, 6], [38, 81, 2], [40, 79, 4], [44, 76, 4],
  [48, 81, 12], [60, 76, 2], [62, 79, 2],
];

/** Chorus variation ending on E major (V) → resolves into the verse. */
const MEL_B2: ReadonlyArray<MelodyNote> = [
  [0, 81, 6], [6, 79, 2], [8, 77, 4], [12, 76, 4],
  [16, 74, 6], [22, 76, 2], [24, 79, 4], [28, 83, 4],
  [32, 84, 6], [38, 83, 2], [40, 81, 8],
  [48, 83, 4], [52, 80, 4], [56, 76, 4], [60, 71, 4],
];

/** Bridge over Dm–Em–F–G: a rising line that builds into the chorus. */
const MEL_C: ReadonlyArray<MelodyNote> = [
  [0, 74, 4], [4, 77, 4], [8, 81, 8],
  [16, 79, 4], [20, 76, 4], [24, 71, 8],
  [32, 72, 4], [36, 77, 4], [40, 81, 4], [44, 84, 4],
  [48, 83, 8], [56, 86, 4], [60, 83, 2], [62, 79, 2],
];

/** Overtime: urgent 8th-note hook over the Andalusian cadence Am–G–F–E. */
const MEL_OT: ReadonlyArray<MelodyNote> = [
  [0, 69, 2], [2, 72, 2], [4, 76, 2], [6, 81, 4], [10, 79, 2], [12, 76, 4],
  [16, 71, 2], [18, 74, 2], [20, 79, 4], [24, 74, 4], [28, 71, 4],
  [32, 72, 2], [34, 77, 2], [36, 81, 4], [40, 79, 2], [42, 77, 2], [44, 72, 4],
  [48, 71, 2], [50, 76, 2], [52, 80, 6], [58, 83, 2], [60, 80, 4],
];

const MEL_OT_Y: ReadonlyArray<MelodyNote> = [
  [0, 77, 4], [4, 74, 2], [6, 77, 2], [8, 81, 6], [14, 77, 2],
  [16, 80, 4], [20, 76, 2], [22, 80, 2], [24, 83, 8],
  [32, 84, 8], [40, 83, 4], [44, 81, 4],
  [48, 81, 8], [56, 76, 4], [60, 79, 2], [62, 80, 2],
];

/** Victory: triumphant rising line over F–G–C–Am. */
const MEL_VIC: ReadonlyArray<MelodyNote> = [
  [0, 72, 4], [4, 77, 4], [8, 81, 8],
  [16, 79, 4], [20, 83, 4], [24, 86, 8],
  [32, 84, 12], [44, 83, 2], [46, 84, 2],
  [48, 88, 8], [56, 84, 4], [60, 81, 4],
];

// ---------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------

const ARP_8THS = [0, -1, 3, -1, 2, -1, 4, -1, 0, -1, 3, -1, 5, -1, 4, -1];
const ARP_ROLL = [0, 2, 3, 4, 0, 2, 3, 4, 0, 2, 3, 4, 5, 4, 3, 2];
const ARP_OT = [0, 2, 1, 3, 2, 4, 3, 5, 0, 2, 1, 3, 4, 5, 3, 4];
const ARP_MENU = [0, -1, -1, 3, -1, -1, 2, -1, -1, 4, -1, -1, 3, -1, 5, -1];
const ARP_DEFEAT = [0, -1, 2, -1, 3, -1, 2, -1, 1, -1, 2, -1, 3, -1, 4, -1];

const MATCH_STYLE: StyleDef = {
  kick: ['X...X...X...X...', 'X...X...X...X...', 'X...X...X...X.o.'],
  snare: ['....X.......X...', '....X.......X...', '....X.......X...'],
  clap: ['................', '................', '....x.......x...'],
  hat: ['..x...x...x...x.', 'o.x.o.x.o.x.o...', 'xoxoxo.oxoxoxo.o'],
  ohat: ['................', '..............x.', '......x.......x.'],
  bass: ['R.O.R.O.R.O.r.O.', 'RrrORrrORrrORrOr', 'RrrORrrORrrORrOr'],
  arp: [null, ARP_8THS, ARP_ROLL],
  lead: 'lift',
  padAttack: 0.25,
  padRelease: 0.45,
  padBright: [0.25, 0.8],
  padLevel: 1,
  minTier: 0,
  toms: true,
  pump: [0.3, 0.42, 0.5],
  twinkle: false,
  subBass: false,
};

const OVERTIME_STYLE: StyleDef = {
  kick: ['X...X...X...X..o', 'X...X...X...X..o', 'X...X...X.o.X..o'],
  snare: ['....X.......X...', '....X.......X...', '....X.......X.o.'],
  clap: ['....x.......x...', '....x.......x...', '....x.......x...'],
  hat: ['xoxoxo.oxoxoxo.o', 'xoxoxo.oxoxoxo.o', 'xo.oxo.oxo.oxo.o'],
  ohat: ['......x.......x.', '......x.......x.', '..x...x...x...x.'],
  bass: ['RrrORrrORrrORrOr', 'RrrORrrORrrORrOr', 'RROrRROrRROrRFOr'],
  arp: [ARP_OT, ARP_OT, ARP_OT],
  lead: 'always',
  padAttack: 0.15,
  padRelease: 0.35,
  padBright: [0.55, 0.95],
  padLevel: 0.85,
  minTier: 1,
  toms: true,
  pump: [0.45, 0.5, 0.55],
  twinkle: false,
  subBass: false,
};

const MENU_STYLE: StyleDef = {
  kick: ['................', 'X.......X.......', 'X.......X.......'],
  snare: ['................', '................', '............o...'],
  clap: ['................', '................', '................'],
  hat: ['................', '..o...o...o...o.', 'o.o.o.o.o.o.o.o.'],
  ohat: ['................', '................', '................'],
  bass: ['R~~~~~~~~~~~~~~~', 'R~~~~~~~~~~~~~~~', 'R~~~~~~~R~~~~~~~'],
  arp: [ARP_MENU, ARP_MENU, ARP_8THS],
  lead: 'never',
  padAttack: 1.4,
  padRelease: 1.6,
  padBright: [0.35, 0.6],
  padLevel: 1.15,
  minTier: 0,
  toms: false,
  pump: [0, 0.15, 0.2],
  twinkle: true,
  subBass: true,
};

const VICTORY_STYLE: StyleDef = {
  kick: ['X...X...X...X...', 'X...X...X...X...', 'X...X...X...X...'],
  snare: ['................', '................', '................'],
  clap: ['....X.......X...', '....X.......X...', '....X.......X...'],
  hat: ['..x...x...x...x.', 'o.x.o.x.o.x.o...', 'o.x.o.x.o.x.o...'],
  ohat: ['................', '..............x.', '..............x.'],
  bass: ['R.O.R.O.R.O.R.O.', 'R.O.R.O.R.O.R.O.', 'R.O.R.O.R.O.R.O.'],
  arp: [ARP_ROLL, ARP_ROLL, ARP_ROLL],
  lead: 'always',
  padAttack: 0.3,
  padRelease: 0.6,
  padBright: [0.6, 0.85],
  padLevel: 1,
  minTier: 1,
  toms: false,
  pump: [0.35, 0.35, 0.35],
  twinkle: false,
  subBass: false,
};

const DEFEAT_STYLE: StyleDef = {
  kick: ['................', '................', '................'],
  snare: ['................', '................', '................'],
  clap: ['................', '................', '................'],
  hat: ['................', '................', '................'],
  ohat: ['................', '................', '................'],
  bass: ['R~~~~~~~~~~~~~~~', 'R~~~~~~~~~~~~~~~', 'R~~~~~~~~~~~~~~~'],
  arp: [ARP_DEFEAT, ARP_DEFEAT, ARP_DEFEAT],
  lead: 'never',
  padAttack: 1.0,
  padRelease: 1.8,
  padBright: [0.2, 0.3],
  padLevel: 1.1,
  minTier: 0,
  toms: false,
  pump: [0, 0, 0],
  twinkle: false,
  subBass: true,
};

// ---------------------------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------------------------

export const SONGS: Record<'menu' | 'match' | 'overtime' | 'victory' | 'defeat', SongDef> = {
  menu: {
    id: 'menu',
    bpm: 100,
    gain: 1.6,
    sections: [
      { chords: [Am9, Am9, Fmaj7, Fmaj7] },
      { chords: [Cmaj7, Cmaj7, G6, Esus] },
    ],
    style: MENU_STYLE,
  },
  match: {
    id: 'match',
    bpm: 118,
    gain: 1,
    sections: [
      // 32-bar arrangement (≈ 65 s): verse, verse, chorus, chorus', verse, bridge, chorus, chorus'.
      { chords: [Am, F, C, G], melody: MEL_A, breakdown: true },
      { chords: [Am, F, C, G], melody: MEL_A },
      { chords: [F, G, Em, Am], melody: MEL_B, lift: true },
      { chords: [F, G, Am, E], melody: MEL_B2, lift: true, fill: true },
      { chords: [Am, F, C, G], melody: MEL_A, breakdown: true },
      { chords: [Dm, Em, F, G], melody: MEL_C, fill: true },
      { chords: [F, G, Em, Am], melody: MEL_B, lift: true },
      { chords: [F, G, Am, E], melody: MEL_B2, lift: true, fill: true },
    ],
    style: MATCH_STYLE,
  },
  overtime: {
    id: 'overtime',
    bpm: 126,
    gain: 1,
    sections: [
      { chords: [Am, G, F, E], melody: MEL_OT },
      { chords: [Am, G, F, E], melody: MEL_OT, fill: true },
      { chords: [Dm, E, Am, Am], melody: MEL_OT_Y, lift: true },
      { chords: [Dm, E, Am, E], melody: MEL_OT_Y, lift: true, fill: true },
    ],
    style: OVERTIME_STYLE,
  },
  victory: {
    id: 'victory',
    bpm: 120,
    gain: 1.1,
    sections: [
      { chords: [F, G, C, Am], melody: MEL_VIC, lift: true },
      { chords: [F, G, C, Am], lift: true, fill: true },
    ],
    style: VICTORY_STYLE,
  },
  defeat: {
    id: 'defeat',
    bpm: 84,
    gain: 1.3,
    sections: [{ chords: [Am, F, Dm, E] }],
    style: DEFEAT_STYLE,
  },
};

/** Velocity of a drum pattern character. */
export function drumVel(pattern: string, step: number): number {
  const c = pattern.charCodeAt(step);
  // 'X' 88, 'x' 120, 'o' 111
  return c === 88 ? 1 : c === 120 ? 0.8 : c === 111 ? 0.5 : 0;
}
