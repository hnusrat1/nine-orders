// Loads assets/data/index.json and the binary datasets it lists.
// Each dataset is one little-endian file; index.json gives every field's
// byte offset, element type and components (see sim/README.md).
const TYPES = { f32: Float32Array, u8: Uint8Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array };

export async function loadData(base = 'assets/data/') {
  const index = await (await fetch(base + 'index.json')).json();
  const sets = {};
  await Promise.all(Object.entries(index.datasets).map(async ([name, d]) => {
    const buf = await (await fetch(base + d.url)).arrayBuffer();
    const out = { count: d.count, units: d.units };
    for (const [f, spec] of Object.entries(d.fields)) {
      const T = TYPES[spec.type];
      out[f] = new T(buf, spec.offset, d.count * (spec.size || 1));
    }
    sets[name] = out;
  }));
  return { index, sets, n: index.numbers };
}

// Format a number from index.numbers with its unit, e.g. fmt(n.photonE) → "2.21 MeV"
export function fmt(entry, digits) {
  if (!entry) return '?';
  const v = entry.value;
  const d = digits ?? entry.digits ?? 3;
  const r = +v.toPrecision(d);
  const s = Math.abs(r) >= 1000 ? r.toLocaleString('en-US') : r.toString();
  if (!entry.unit) return s;
  return entry.unit === '°' || entry.unit === '%' ? `${s}${entry.unit}` : `${s} ${entry.unit}`;
}
