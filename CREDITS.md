# Credits, sources and licences

Nine Orders code (everything in `src/`, `css/`, `index.html`, `sim/`, `tests/`) is by Humza Nusrat. Third-party material is listed below with its licence. Files derived from share-alike sources keep that licence, as noted.

## Software

| What | Where | Licence |
|---|---|---|
| three.js r170 (core, GLTFLoader, BufferGeometryUtils, meshopt decoder) | `vendor/three/` | MIT, © 2010–2024 three.js authors (`vendor/three/LICENSE`); the meshopt decoder is MIT, © Arseny Kapoulkine |
| Geant4 11.4.3 (offline simulation only, not shipped) | `sim/g4/` links against it | Geant4 Software Licence |
| Blender 5.0 as a Python module, `bpy` (offline modelling only) | `sim/art/` | GPL (the generated models are not covered by Blender's licence) |
| meshoptimizer `gltfpack` (offline compression only) | `sim/art/pack.sh` | MIT |
| Playwright, IWER (Meta's Immersive Web Emulation Runtime), tests only | `tests/` | Apache-2.0 / MIT |

Geant4 references: Agostinelli S et al., *Nucl Instrum Methods A* 506:250–303 (2003); Allison J et al., *IEEE Trans Nucl Sci* 53:270–278 (2006); Allison J et al., *Nucl Instrum Methods A* 835:186–225 (2016).

Geant4-DNA references (as required by the Geant4-DNA collaboration): *Med Phys* 51:5873–5889 (2024); *Med Phys* 45:e722–e739 (2018); *Phys Med* 31:861–874 (2015); *Med Phys* 37:4692–4708 (2010); *Int J Model Simul Sci Comput* 1:157–178 (2010).

## Physics data and parameters

- **6 MV photon spectrum.** Mohan R, Chui C, Lidofsky L. Energy and angular distributions of photons from medical linear accelerators. *Med Phys* 12:592–597 (1985). doi:10.1118/1.595680. Values as tabulated in EGSnrc, `HEN_HOUSE/spectra/egsnrc/mohan6.spectrum` (github.com/nrc-cnrc/EGSnrc), downloaded at build time by `sim/fetch_inputs.py` and not redistributed here. The Sheikh-Bagheri & Rogers (2002) spectra were the first choice but their tables could not be retrieved from the build environment.
- **Strand-break threshold, 17.5 eV.** Nikjoo H, O'Neill P, Wilson WE, Goodhead DT. Computational approach for determining the spectrum of DNA damage induced by ionizing radiation. *Radiat Res* 156:577–583 (2001). doi:10.1667/0033-7587(2001)156[0577:CAFDTS]2.0.CO;2. The minimum-energy-in-a-critical-volume method goes back to Charlton and Humm (1988).
- **Electron mass and unit conversions.** CODATA 2018.

## Structures

- **B-DNA, PDB 1BNA.** Drew HR, Wing RM, Takano T, Broka C, Tanaka S, Itakura K, Dickerson RE. Structure of a B-DNA dodecamer: conformation and dynamics. *PNAS* 78:2179–2183 (1981). wwPDB data: CC0 1.0. The file `sim/inputs/1BNA.pdb` was copied from the Molecular Nodes test data (github.com/BradyAJohnston/MolecularNodes, `tests/data/1BNA.pdb`) because the PDB servers were not reachable from the build environment; it is the unmodified PDB entry.
- **Nucleosome core particle, PDB 1KX5.** Davey CA, Sargent DF, Luger K, Maeder AW, Richmond TJ. Solvent mediated interactions in the structure of the nucleosome core particle at 1.9 Å resolution. *J Mol Biol* 319:1097–1113 (2002). wwPDB data: CC0 1.0. `sim/inputs/1KX5_NRF.pdb` is the PDB entry as distributed by pynucl (github.com/intbio/pynucl, `pynucl/data/1KX5_NRF.pdb`), rigidly moved into the nucleosome reference frame. Only the coordinates are used.
- `assets/models/nucleosome.glb` and `assets/data/dnaAtoms.bin` are derived from these coordinates (CC0).

## Anatomy

- **Body surface: MakeHuman 1.x base mesh, default skeleton and skinning weights** (`makehuman/data/3dobjs/base.obj`, `makehuman/data/rigs/default.mhskel`, `default_weights.mhw`, github.com/makehumancommunity/makehuman). Released as CC0 1.0 by the MakeHuman copyright holders (Data Collection AB) in 2020. `assets/models/patient_body.glb` (arms rotated to the sides, decimated) is CC0.
- **Pelvic organs and bones: BodyParts3D 3.0** (urinary bladder FMA15900, prostate FMA9600, rectum FMA14544, hip bones FMA16586/16587, sacrum FMA16202, femurs FMA24474/24475, fifth lumbar vertebra FMA13076). "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution-Share Alike 2.1 Japan." Mitsuhashi N, Fujieda K, Tamura T, Kawamoto S, Takagi T, Okubo K. BodyParts3D: 3D structure database for anatomical concepts. *Nucleic Acids Res* 37:D782–D785 (2009). doi:10.1093/nar/gkn613. STL files from github.com/Kevin-Mattheus-Moerman/BodyParts3D (commit f0eeb6e). **`assets/models/pelvis_organs.glb` is a derivative (translated into the patient frame and decimated) and is licensed CC BY-SA 2.1 JP.** The voxel phantom built from it (`sim/work/`, not committed) is likewise CC BY-SA 2.1 JP.

## Original models

- `assets/models/room.glb` (room, generic linear accelerator, couch; lighting baked in Blender) is original work for this project, by `sim/art/room.py`. It is vendor-neutral and not a model of any product.
- Cells, chromatin territories, nucleosome packing and all tracks are procedural or simulated.
