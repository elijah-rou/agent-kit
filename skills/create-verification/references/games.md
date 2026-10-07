# Games and real-time simulation recipe

For engines, games, and other frame-driven programs. Agents verify behavior, determinism, and budgets. Feel (responsiveness, difficulty, fun) stays with the user through playtesting; never report feel as verified.

## Launch and Doctor

- Launch the build under test with a fixed window size or a headless or offscreen mode, a fixed timestep, and a fixed seed. Record build revision, graphics backend, GPU, and driver in the evidence directory.
- Doctor confirms the build revision, that the window or offscreen target exists, the graphics backend, and that the input and capture hooks respond.
- State whether headless runs are representative. Rendering and timing often differ between headless and windowed runs; frame-time claims need the windowed configuration on the target hardware class.

## Deterministic replay

- Simulation state advances on a fixed timestep, independent of render rate.
- All randomness flows from one recorded seed.
- Recorded input is a list of `(frame, input event)` pairs, never wall-clock times.
- Replaying the same seed and input must produce the same state. Compare a state hash per frame, or at checkpoints, against the recording. The first diverging frame is the evidence of nondeterminism.

## Scripted input

- Inject input through the engine's own input layer or a debug console, not OS-level mouse movement, so scripts stay frame-exact.
- Each script names its starting state (level, save file, seed) and asserts observable state at named frames: position, health, score, the current menu, an entity count.
- Keep scripts in the verification skill's directory and show their invocation in Drive.

## Frame-time budgets

- Define the budget per scene, for example 16.6 ms at 60 frames per second on a named hardware class.
- Run a scripted camera path or scene for a fixed number of frames after warm-up, and record every frame time.
- Report p50, p95, p99, and the maximum, plus the number of frames over budget. Averages hide hitches.
- Compare before and after on the same machine, build mode, and scene.

## Screenshots and video

- Capture at named frames through the engine's capture path, so the image matches the simulated frame.
- Compare against a reference with a tolerance, and save the diff image when it fails.
- Record short video for motion bugs and before-and-after proof; keep the input script that produced it next to the video.

## Evidence

Seed, input script, build revision, per-frame hashes or checkpoint states, frame-time summary, screenshots and diffs, and video, all in the evidence directory and named by feature and run ID.

## Cleanup

Close the game processes this run started, remove temporary save files and profiles, and keep the evidence.
