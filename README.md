# Nine Orders

A WebXR experience that follows one 6 MV radiotherapy photon from the linear accelerator to a double-strand break in DNA, in one continuous zoom from 1 m to 1 nm. Runs in the Meta Quest browser, on desktop and on phones. Static site, no build step.

**Status: skeleton.** All seven stages are playable with placeholder geometry and synthetic tracks (`sim/synthetic.py`). The app says so on the start screen. Geant4 data and real art replace the placeholders next.

## Run locally

Any static server from the repository root, for example:

```
python3 -m http.server 8000
```

then open http://localhost:8000. WebXR needs HTTPS or localhost.

## Controls

| | Zoom | Look | Pause and label | Other |
|---|---|---|---|---|
| VR | left stick (or either stick) forward/back | move your head | trigger | grip: grab and rotate; A/X: Guided ↔ Explore; B/Y: mute |
| Desktop | scroll wheel or W/S | drag to orbit | click | Space pause, G/E mode, M mute, Esc menu |
| Phone | pinch | drag to orbit | tap | |

Guided mode plays the journey (about 4 minutes); zooming scrubs along it. Explore mode lets you stop at any scale.

## Tests

```
cd tests && npm install
node run-desktop.mjs     # Playwright, headless Chromium: every level, screenshots in tests/screenshots/
node run-xr.mjs          # IWER WebXR emulator (Quest 3): enter VR, Guided end to end, stick, trigger, grip
python3 ../sim/check_physics.py   # recompute every on-screen number from assets/data
```
