// Narration script, subtitles and speech. Every number comes from index.numbers.
import { fmt } from './data.js';

// 3.76e13 → "4 × 10¹³", 6e6 → "6 million"
function sci(entry) {
  const v = entry.value, e = Math.floor(Math.log10(v)), m = Math.round(v / 10 ** e);
  if (e === 6) return `${m} million`;
  const sup = String(e).split('').map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c]).join('');
  return `${m} × 10${sup}`;
}

export function script(n) {
  const sep = n.dsbSeparation && n.dsbSeparation.value > 0 ? `${fmt(n.dsbSeparation)} apart` : 'directly opposite each other';
  return [
    { t: 1.5, level: 'room', text: 'A linear accelerator is treating a tumour in the pelvis with a 6 MV X-ray beam.' },
    { t: 11.5, level: 'room', text: 'We have slowed time to a stop: choose the one photon that glows.', prompt: true },
    { t: 25, level: 'patient', text: `This ${fmt(n.photonE0)} photon crosses ${fmt(n.depth)} of tissue, then Compton-scatters near the target.` },
    { t: 44.5, level: 'patient', text: `It leaves with ${fmt(n.photonE1)} and hands ${fmt(n.electronE0)} to an electron.` },
    ...(n.photonsPer2Gy ? [{ t: 51, level: 'patient', text: `The colours are the dose from ${sci(n.dosePhotons)} simulated photons of this beam. One 2 Gy treatment takes about ${sci(n.photonsPer2Gy)}.` }] : []),
    { t: 60, level: 'tissue', text: `That electron does the damage, travelling ${fmt(n.electronPath)} through tissue made of cells about ten micrometres across.` },
    { t: 76, level: 'tissue', text: `At this energy it is sparsely ionising: it loses only about ${fmt(n.letPrimary)}.` },
    { t: 94, level: 'cell', text: 'Inside a tumour cell nucleus, the fast electron passes straight through.' },
    { t: 102, level: 'cell', text: `On the way it knocks out a slower delta electron of ${fmt(n.deltaE)}, which we now follow.` },
    { t: 126, level: 'chromatin', text: 'Here the DNA is wrapped around histone proteins as nucleosomes.' },
    { t: 142, level: 'chromatin', text: 'The slow delta electron ionises densely, on the scale of the DNA itself.' },
    { t: 166, level: 'dna', text: `Each point is one simulated interaction; where more than 17.5 electronvolts lands on one nucleotide's backbone a strand breaks, and here both strands break, ${sep}.` },
    { t: 188, level: 'dna', text: 'Damage this clustered comes mostly from slow secondary electrons and track ends like this one, not from the fast electron itself.' },
    { t: 207, level: 'return', text: 'Back out to the treatment room.' },
    { t: 217, level: 'return', text: `One 2 Gy treatment sends about ${fmt(n.tracksPerNucleus2Gy, 2)} electron tracks like the one we followed through every tumour cell nucleus in the field.`, closing: true },
  ];
}

export class Narrator {
  constructor(subsEl, lines) {
    this.el = subsEl;
    this.lines = lines;
    this.muted = false;
    this.current = null;
    this.spoken = new Set();
    this.voice = null;
    this.synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
    if (this.synth) {
      const pick = () => {
        const vs = this.synth.getVoices().filter((v) => v.lang && v.lang.startsWith('en'));
        this.voice = vs.find((v) => /natural|neural|samantha|daniel|serena|google uk english female/i.test(v.name)) || vs[0] || null;
      };
      pick();
      this.synth.onvoiceschanged = pick;
    }
    this.onText = null; // hook for the VR subtitle panel
  }

  setMuted(m) {
    this.muted = m;
    if (m && this.synth) this.synth.cancel();
  }

  show(line) {
    if (line === this.current) return;
    this.current = line;
    const text = line ? line.text : '';
    this.el.textContent = text;
    if (this.onText) this.onText(text);
    if (line && !this.muted && this.synth && !this.spoken.has(line)) {
      this.spoken.add(line);
      this.synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = 0.95; u.pitch = 1.0;
      this.synth.speak(u);
    }
  }

  // Guided: the latest line whose cue time has passed (lines persist until the next).
  atTime(T) {
    let cur = null;
    for (const l of this.lines) if (T >= l.t) cur = l;
    // allow re-speaking a line when scrubbing back before it
    for (const l of this.spoken) if (T < l.t - 0.5) this.spoken.delete(l);
    this.show(cur);
  }

  // Explore: the first line of the level in view (spoken once per visit).
  forLevel(id) {
    const l = this.lines.find((x) => x.level === id);
    this.show(l || null);
  }

  reset() { this.spoken.clear(); this.current = null; if (this.synth) this.synth.cancel(); }
}
