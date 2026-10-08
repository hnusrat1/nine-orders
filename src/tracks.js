// Turn a track dataset (points grouped by track id, in step order) into
// ribbon segments and event glow points.
import { EVENT_COLORS } from './gfx.js';

// set: {pos, time, type, track, edep, count}; k: unit conversion factor; shift: [x,y,z] subtracted after scaling
export function trackSegments(set, { k = 1, shift = [0, 0, 0], width = 1, color = () => [1, 0.7, 0.4], filter } = {}) {
  const n = set.count;
  const idx = [];
  for (let i = 0; i + 1 < n; i++) {
    if (set.track[i] !== set.track[i + 1]) continue;
    if (filter && !filter(i)) continue;
    idx.push(i);
  }
  const m = idx.length;
  const a = new Float32Array(3 * m), b = new Float32Array(3 * m), c = new Float32Array(3 * m);
  const w = new Float32Array(m), br = new Float32Array(2 * m);
  idx.forEach((i, j) => {
    for (let q = 0; q < 3; q++) {
      a[3 * j + q] = set.pos[3 * i + q] * k - shift[q];
      b[3 * j + q] = set.pos[3 * i + 3 + q] * k - shift[q];
    }
    c.set(color(set.track[i], i), 3 * j);
    w[j] = typeof width === 'function' ? width(set.track[i], i) : width;
    br[2 * j] = set.time[i]; br[2 * j + 1] = set.time[i + 1];
  });
  return { a, b, color: c, width: w, birth: br };
}

// Event points (deposits only, by default) coloured by interaction type.
export function eventPoints(set, { k = 1, shift = [0, 0, 0], size = 1, filter = (i) => set.edep[i] > 0, gain = 1 } = {}) {
  const sel = [];
  for (let i = 0; i < set.count; i++) if (filter(i)) sel.push(i);
  const m = sel.length;
  const pos = new Float32Array(3 * m), col = new Float32Array(3 * m), sz = new Float32Array(m), birth = new Float32Array(m);
  sel.forEach((i, j) => {
    for (let q = 0; q < 3; q++) pos[3 * j + q] = set.pos[3 * i + q] * k - shift[q];
    const cc = EVENT_COLORS[set.type[i]] || [1, 1, 1];
    col[3 * j] = cc[0] * gain; col[3 * j + 1] = cc[1] * gain; col[3 * j + 2] = cc[2] * gain;
    sz[j] = typeof size === 'function' ? size(i) : size;
    birth[j] = set.time[i];
  });
  return { pos, color: col, size: sz, birth, index: sel };
}

// Ordered positions of one track id (for anchors that follow a particle).
export function trackPolyline(set, id, k = 1, shift = [0, 0, 0]) {
  const out = [], times = [];
  for (let i = 0; i < set.count; i++) {
    if (set.track[i] !== id) continue;
    out.push(set.pos[3 * i] * k - shift[0], set.pos[3 * i + 1] * k - shift[1], set.pos[3 * i + 2] * k - shift[2]);
    times.push(set.time[i]);
  }
  return { pts: new Float32Array(out), times: new Float32Array(times) };
}
