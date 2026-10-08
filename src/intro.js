// The start-screen account of what was simulated. Every number comes from
// assets/data/index.json (and is checked by sim/check_physics.py).
import { fmt } from './data.js';

const N = (entry, d) => `<span class="n">${fmt(entry, d)}</span>`;

export function introHTML(data) {
  const n = data.n;
  if (data.index.synthetic) {
    return '<p><b>Skeleton build.</b> Placeholder geometry and synthetic tracks; the numbers are not from simulation yet.</p>';
  }
  return `<ol>
    <li><b>The beam.</b> Geant4, the radiation-transport toolkit used in particle physics and medical physics, fired ${N(n.storyPhotons, 6)} photons from a 6&nbsp;MV linac spectrum into a voxelised male pelvis.
      ${N(n.storyEvents, 4)} of them Compton-scattered in the prostate. You follow one: a ${N(n.photonE0)} photon that hands ${N(n.electronE0)} to an electron.</li>
    <li><b>The electron.</b> Geant4 tracked that electron step by step through ${N(n.electronPath, 3)} of tissue, together with every secondary electron above about 1&nbsp;keV.</li>
    <li><b>Down to DNA.</b> Geant4-DNA then followed one of those secondaries, a ${N(n.deltaE)} delta electron, one interaction at a time: ${N(n.deltaIons)} ionisations in ${N(n.deltaTime, 2)}. It runs through a chromatin model built from the crystal structures of DNA (PDB 1BNA) and the nucleosome (PDB 1KX5).</li>
    <li><b>The break.</b> Of ${N(n.placements, 5)} placements of such tracks, ${N(n.dsbFraction, 2)} broke both DNA strands. Most tracks break nothing: you will see one that did.</li>
    <li><b>The big picture.</b> A further ${N(n.fluencePhotons, 7)}-photon run gives the closing number: about ${N(n.tracksPerNucleus2Gy, 2)} electron tracks cross each tumour cell nucleus in one 2&nbsp;Gy treatment.</li>
  </ol>`;
}
