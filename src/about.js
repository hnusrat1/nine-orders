// About panel: physics notes, how the scales are stitched, every on-screen
// number with its derivation, and sources. Built from assets/data/index.json.
import { fmt } from './data.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function aboutHTML(data) {
  const ix = data.index;
  const parts = [];
  parts.push('<h1>About Nine Orders</h1>');
  if (ix.synthetic) parts.push('<p><b>This is the skeleton build.</b> Tracks and numbers below are synthetic placeholders, not simulation results. They will be replaced by Geant4 output.</p>');
  for (const sec of ix.notes || []) {
    parts.push(`<h2>${esc(sec.h)}</h2>`);
    for (const p of sec.p) parts.push(`<p>${esc(p)}</p>`);
  }
  parts.push('<h2>Every number on screen</h2><table><tr><th>Quantity</th><th>Value</th><th>How it was obtained</th></tr>');
  for (const [k, v] of Object.entries(ix.numbers)) {
    parts.push(`<tr><td>${esc(v.label || k)}</td><td>${esc(fmt(v))}</td><td>${esc(v.derivation || '')}</td></tr>`);
  }
  parts.push('</table>');
  parts.push('<h2>Sources</h2><ul>');
  for (const s of ix.sources || []) parts.push(`<li>${esc(s)}</li>`);
  parts.push('</ul><p class="small">Full licences and attributions: <a href="CREDITS.md" target="_blank" rel="noopener">CREDITS.md</a>. Code and simulation: <a href="https://github.com/hnusrat1/nine-orders" target="_blank" rel="noopener">github.com/hnusrat1/nine-orders</a>.</p>');
  return parts.join('\n');
}
