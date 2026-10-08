// Narration script, subtitles and speech. Every number comes from index.numbers.
import { fmt } from './data.js';

export function script(n) {
  return [
    { t: 1.5, level: 'room', text: `A linear accelerator treats a tumour in the pelvis with a 6 MV X-ray beam: billions of photons every second.` },
    { t: 11.5, level: 'room', text: `We have slowed time until it stops. Choose the one photon that glows.`, prompt: true },
    { t: 25, level: 'patient', text: `This photon carries ${fmt(n.photonE0)}. It crosses ${fmt(n.depth)} of tissue before it interacts.` },
    { t: 44.5, level: 'patient', text: `Near the target it Compton-scatters: the photon leaves with ${fmt(n.photonE1)}, and an electron is set moving with ${fmt(n.electronE0)}.` },
    { t: 60, level: 'tissue', text: `The electron, not the photon, does the damage. It travels ${fmt(n.electronPath)} through tissue, through cells about ten micrometres across.` },
    { t: 76, level: 'tissue', text: `A fast electron like this is sparsely ionising: it loses only about ${fmt(n.letPrimary)}.` },
    { t: 94, level: 'cell', text: `Inside a tumour cell nucleus, the fast electron passes straight through.` },
    { t: 102, level: 'cell', text: `On its way it knocks out a slower secondary electron, a delta electron of ${fmt(n.deltaE)}.` },
    { t: 126, level: 'chromatin', text: `DNA here is wound around histone proteins as nucleosomes. The slow delta electron ionises densely, on the scale of the DNA itself.` },
    { t: 162, level: 'dna', text: `Each point is one interaction. Ionisations are orange, excitations blue, coloured by type from the simulation.` },
    { t: 176, level: 'dna', text: `Energy above 17.5 electronvolts deposited on the sugar–phosphate backbone breaks a strand. Two breaks on opposite strands, ${fmt(n.dsbSeparation)} apart, make a double-strand break.` },
    { t: 192, level: 'dna', text: `Damage this clustered comes mostly from slow secondary electrons and track ends, not from the fast electron itself.` },
    { t: 207, level: 'return', text: `Back out to the treatment room.` },
    { t: 217, level: 'return', text: `One 2 Gy treatment sends about ${fmt(n.tracksPerNucleus2Gy, 2)} electron tracks like this through every tumour cell nucleus in the field.`, closing: true },
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
