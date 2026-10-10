# Nine Orders

One 6 MV radiotherapy photon, followed from the linear accelerator to a double-strand break in DNA, in one continuous zoom from 1 m to 1 nm. A WebXR experience for the Meta Quest browser that also runs on desktop and phones, built for patients, students, residents and funders.

Every track and every number on screen comes from Monte Carlo simulation (Geant4 and Geant4-DNA) and is listed, with how it was computed, in the About panel.

## The journey

About four minutes in Guided mode. Each stage shows a scale bar in real units and a log-scale strip from 10⁰ m to 10⁻⁹ m.

1. **Treatment room, 1 m.** A generic linac at gantry 0° treats a patient's pelvis. You start in the room at life size (in VR, standing beside the couch on your own floor); the light field and the alignment lasers fall on the patient's skin. Time slows to a stop; you pick the one photon that glows.
2. **Patient, 10 cm.** The photon enters the pelvis among the organs and bones and Compton-scatters near the prostate. A CT-style slice through the simulation's voxel phantom shows the dose of the whole field from a separate Geant4 run, with isodose lines. The callout gives the photon and electron energies.
3. **Tissue, 1 mm to 100 µm.** We ride the recoil electron through packed cells.
4. **Cell, 10 µm.** Inside a tumour cell nucleus the fast electron passes straight through and knocks out a slow delta electron.
5. **Chromatin, 100 nm to 10 nm.** Nucleosomes (PDB 1KX5) on linker DNA; the delta electron's ionisations arrive.
6. **DNA, 1 nm.** B-DNA (PDB 1BNA) at atomic scale. Interactions appear in their simulated time order, coloured by type; backbone deposits above 17.5 eV become strand breaks, and the helix comes apart at the double-strand break.
7. **Return.** Back out to the room in ten seconds, with the number of electron tracks a 2 Gy fraction sends through one nucleus.

## Controls

| | Zoom through the scales | Move | Look | Pause and label | Other |
|---|---|---|---|---|---|
| VR (Quest) | right stick up/down (in Guided it moves along the story) | left stick walks; hold grip to grab the scene and move or turn it | your head; right stick left/right snap-turns 30° | trigger on anything; again to continue | B/Y menu (mode, narration, recenter, restart, exit); A/X Guided ↔ Explore |
| Desktop | scroll, or `+` / `−` | `W` `A` `S` `D` fly, `Q` `E` down/up, right-drag (or Shift-drag) pans, `F` recenters | drag | click | Space pause, `G` mode, `N` narration, `H` controls, Esc menu; stage bar jumps between stages |
| Phone | pinch | two-finger drag pans | one-finger drag | tap | toolbar: pause, recenter, controls |

In **Guided** mode the journey plays by itself and zooming scrubs along it. In **Explore** mode you stop at any scale and each scale's story replays while you are there. On entering VR a welcome panel shows the controls; labels on the controllers repeat them for the first half minute. Narration uses the browser's speech synthesis; subtitles are always on.

In VR the treatment room is life-size: the isocentre is at its real height, so the room's floor is your floor, and you face the patient's side. From the patient scale down, each scale is a model about a metre across, set 1 m in front of you and a little below eye level; it fades out at its edges and near your eyes, so nothing passes through your head when you walk into it. The numbers sit in a column to your right. The reading panels stay put until you turn or step away, then glide back in front. **Recenter** (menu), or holding the Meta button, sets the stage in front of you again. Add `?stats` to the URL for a frame-time readout (in the headset, lower right).

## Run locally

It is a static site with no build step:

```
python3 -m http.server 8000
```

then open http://localhost:8000 (WebXR needs HTTPS or localhost). On a Quest, open the GitHub Pages URL in the Meta Quest browser and press **Enter VR**.

## Regenerate the simulation data

Everything in `assets/data/` and `assets/models/` is produced by `sim/regenerate.sh`: Geant4 11.4.3 from conda-forge, Geant4-DNA, Python, and Blender as a Python module. See [`sim/README.md`](sim/README.md) for the one-time setup, each step, and the data format.

```
sim/regenerate.sh            # about 6 minutes on 4 cores
python3 sim/check_physics.py # recompute every on-screen number from the data files
```

## Physics notes

- **Patient scale.** Geant4 with `G4EmStandardPhysics_option4` in a 2.5 mm voxel pelvis (air, soft tissue, homogenised bone, urine) made from the anatomy meshes. A point source 100 cm above the isocentre fires photons over a 10 × 10 cm field with energies from the Mohan et al. (1985) 6 MV spectrum. We keep a photon whose first interaction is a Compton scatter in the prostate and record its recoil electron and all secondaries (1 µm production cut).
- **Hand-off.** From that electron's track we take a delta electron of a few keV created inside the prostate. The cell and DNA scales are separate Geant4-DNA simulations in liquid water, started with the same particle type, energy and direction: the fast electron over 40 µm (`G4EmDNAPhysics_option2`) and the delta electron itself (`G4EmDNAPhysics_option4`).
- **Why a delta electron.** A fast MeV electron is sparsely ionising, roughly 0.2 keV/µm, about one ionisation every 100 nm. Clustered DNA damage comes mostly from low-energy secondary electrons and track ends, so the DNA-scale event is a delta electron taken from the simulated track. The narration says so.
- **Strand breaks.** The chromatin model packs 1KX5 nucleosomes and 1BNA-built linker DNA around the track. A deposit counts towards a nucleotide if it lies inside the van der Waals sphere of one of its sugar or phosphate atoms. More than 17.5 eV in one nucleotide is a single-strand break (Nikjoo et al. 2001). Two on opposite strands within 10 bp make a double-strand break. The event shown is a real history and placement from that search, and the About panel gives how often placements produced breaks.
- **Dose.** A third patient-scale run (6 million photons, every 2.5 mm voxel scored, 0.7 mm cut, voxel-by-voxel navigation) gives the dose wash on the CT-style slices, the depth of maximum dose and the number of photons in a 2 Gy fraction. Its dose per photon at the prostate agrees with the separate fluence run.
- **Tracks per nucleus.** Dose and electron fluence in a 1 cm sphere in the prostate, from a separate run of 4 million photons, give electrons per µm² per Gy. Multiplying by 2 Gy and the cross-section of a 9 µm nucleus gives the closing number.

### Known approximations

- DNA, histones and cells are liquid water for the transport physics. Only direct energy deposition is scored: no water radiolysis or radical attack, which in reality causes much of the DNA damage from X-rays.
- The beam is an ideal point source with one spectrum across a uniform field: no flattening-filter softening off axis, head scatter or electron contamination. The room and linac are generic.
- The anatomy combines a MakeHuman body surface with BodyParts3D organs from a different person, placed by the hip joints. Bone is one material (ICRP cortical composition at 1.40 g/cm³).
- The cell, nucleus, chromosome territories and chromatin packing are illustrative models. Strand-break frequencies depend strongly on the threshold and target-volume definitions and apply to this model only.
- Time is slowed by a different factor at each scale, so speeds are not comparable between scales.

## Tests

```
cd tests && npm install
./run-all.sh           # all three below; required before every push
node run-desktop.mjs   # Playwright, headless Chromium: all stages, screenshots in tests/screenshots/, fails on console errors or >150 draw calls
node run-xr.mjs        # Meta IWER (Quest 3 emulation): welcome panel, trigger selects the photon, Guided end to end, stick zoom/scrub, walking, snap turn, menu buttons, trigger labels, grip grab; logs frame times
python3 ../sim/check_physics.py
```

The IWER test page is generated in memory by `run-xr.mjs` and never exists as a file in the site.

## Engineering notes

- three.js r170 is vendored in `vendor/three/` and loaded with an import map; nothing is fetched from a CDN at runtime.
- Each scale is its own scene in its own units with the particle at the origin. Zoom is one exponent; each level renders only inside its own window and cross-fades with its neighbours, so no coordinate handed to the GPU spans more than about two orders of magnitude.
- Cells, nucleosomes, atoms, bonds, track segments and interaction points are instanced (one draw call each); nucleosomes have two levels of detail. Models use meshopt compression. Fixed foveation is set to 0.2 in VR.
- Desktop and phone render through a light bloom pass; VR renders directly. Image-based lighting comes from three.js's RoomEnvironment, and in the room and patient scales from a reflection capture of the baked room itself, taken once at load.
- The room's lighting is baked with Cycles (diffuse and emission, denoised with OpenImageDenoise) into one 3072² atlas and drawn as emission; glossy surfaces add view-dependent reflections in real time. The light field and lasers on the skin are computed in the skin shader from the source and isocentre positions.
- At load everything is drawn once behind the start panel, so every shader is compiled and every mesh and texture uploaded before the journey starts: no hitch the first time a scale or panel appears.
- In VR, head and controller poses are read from the current `XRFrame` (three.js only updates its XR camera inside `render()`), and the first placement waits for a tracked pose. Canvas textures are redrawn only when their text changes; hover highlights and the scale marker are separate meshes.
- The view follows the particle with critically damped smoothing, so the camera never transmits the nanometre zig-zags of the electron track.

Sources, licences and citations: [CREDITS.md](CREDITS.md).
