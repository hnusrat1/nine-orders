// Zoom model, level ranges and the Guided timeline.
//
// z is the zoom exponent: the characteristic scale on screen is 10^-z metres
// (z = 0 → 1 m, z = 9 → 1 nm). That length is drawn D0 display metres long in
// front of the viewer, so a level whose local unit is u metres is drawn with a
// scale factor s = u · D0 · 10^z. Each level only renders inside its own z window,
// which keeps s within about two orders of magnitude of 1 and keeps the
// coordinates handed to the GPU small (no precision jitter).

export const LEVELS = [
  // fade-in [a,b], full [b,c], fade-out [c,d]
  { id: 'room',      name: 'Treatment room', unit: 1,    range: [-9, -9, 0.6, 1.05] },
  { id: 'patient',   name: 'Patient',        unit: 1e-3, range: [0.6, 1.05, 2.35, 2.85] },
  { id: 'tissue',    name: 'Tissue',         unit: 1e-6, range: [2.35, 2.85, 4.3, 4.75] },
  { id: 'cell',      name: 'Cell',           unit: 1e-6, range: [4.3, 4.75, 6.0, 6.55] },
  { id: 'chromatin', name: 'Chromatin',      unit: 1e-9, range: [6.0, 6.55, 8.15, 8.55] },
  { id: 'dna',       name: 'DNA',            unit: 1e-9, range: [8.15, 8.55, 99, 99] },
];

export const Z_MIN = 0, Z_MAX = 9.15;
export const D0 = 0.25;
export const levelScale = (unit, z) => unit * D0 * Math.pow(10, z);

export function levelWeight(range, z) {
  const [a, b, c, d] = range;
  if (z <= a || z >= d) return 0;
  if (z < b) return smooth((z - a) / (b - a));
  if (z > c) return 1 - smooth((z - c) / (d - c));
  return 1;
}

export function smooth(x) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }

// Guided timeline: (t seconds, z). Interpolated with smoothstep between keys,
// so zoom speed eases in and out at each level.
export const KEYS = [
  [0, 0], [24, 0],            // room: beam on, time slows, pick the photon
  [34, 1.15], [58, 1.95],     // patient: photon enters, Compton scatter, electron leaves
  [67, 2.95], [92, 4.15],     // tissue: follow the electron through packed cells
  [100, 4.95], [124, 5.35],   // cell: nucleus, chromatin domains, the delta electron is born
  [134, 6.95], [160, 8.0],    // chromatin: fibre, then nucleosomes
  [168, 8.85], [206, 8.95],     // DNA: events arrive, strand breaks, double-strand break
  [216, 0], [236, 0],         // return to the room, closing caption
];
export const T_END = KEYS[KEYS.length - 1][0];

// When each level's own story clock starts (level-local time 0).
export const STORY_START = { room: 0, patient: 24, tissue: 58, cell: 92, chromatin: 124, dna: 160, return: 206 };
// Length of each level's story when replayed in Explore mode.
export const STORY_LEN = { room: 24, patient: 34, tissue: 34, cell: 32, chromatin: 36, dna: 46 };

export function zAt(t) {
  if (t <= KEYS[0][0]) return KEYS[0][1];
  for (let i = 1; i < KEYS.length; i++) {
    const [t1, z1] = KEYS[i];
    const [t0, z0] = KEYS[i - 1];
    if (t <= t1) return z0 + (z1 - z0) * smooth((t - t0) / (t1 - t0));
  }
  return KEYS[KEYS.length - 1][1];
}

// Nice scale-bar length for a given zoom: largest {1,2,5}·10^n metres whose
// display length is at most `maxDisplay` metres.
export function scaleBar(z, maxDisplay = 0.32) {
  const realMax = maxDisplay / (D0 * Math.pow(10, z));
  const e = Math.floor(Math.log10(realMax));
  let best = Math.pow(10, e);
  for (const m of [2, 5]) if (m * Math.pow(10, e) <= realMax) best = m * Math.pow(10, e);
  return { metres: best, display: best * D0 * Math.pow(10, z), text: formatLength(best) };
}

export function formatLength(m) {
  const units = [[1, 'm'], [1e-2, 'cm'], [1e-3, 'mm'], [1e-6, 'µm'], [1e-9, 'nm'], [1e-10, 'Å']];
  for (const [u, name] of units) {
    if (m >= u * 0.999) {
      const v = m / u;
      return `${+v.toPrecision(3)} ${name}`;
    }
  }
  return `${+(m / 1e-10).toPrecision(3)} Å`;
}
