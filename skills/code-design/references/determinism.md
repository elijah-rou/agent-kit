# Determinism and simulation testing

Build the core so that the same inputs and the same seed always produce the same behavior. That makes every bug reproducible and makes deterministic simulation testing possible: running the real system against simulated time, network, and storage with injected faults, at far more than real-time speed. Fuzzers and simulators find bugs in your understanding; they do not replace it, so keep the assertions dense.

## Make the core deterministic

- Inject every source of nondeterminism through an interface owned by the program: time, randomness, network, storage, process scheduling, and the environment. The production implementation wraps the real resource; the simulation implementation is driven by a seed.
- Read time from an injected clock, never directly from the system clock in logic. Prefer logical or monotonic time inside the core, and convert to wall-clock time only at the edges.
- Draw all randomness from a seeded generator passed in explicitly, and log the seed so any run can be replayed.
- Run the core on a single-threaded event loop that processes queued inputs in a defined order. Push parallelism to the edges, or make it deterministic with fixed partitioning and ordered merges.
- Do not depend on hash map iteration order, pointer addresses, thread timing, or uninitialized memory. Sort or use ordered containers where order is observable.
- Keep side effects at the boundary: the core turns inputs into state changes and output requests, and the edges perform the I/O.

## Make it simulatable

- Define the fault model at each interface: which faults are possible (lost, delayed, duplicated, or reordered messages; torn, corrupt, or lost writes; crashes and restarts; clock skew), and what the system guarantees under each.
- Give each interface a simulated implementation that injects those faults from the seed, within the fault model.
- Express correctness as invariants checked continuously during simulation, not only at the end, and as liveness checks after faults stop.
- Make a failing seed a regression case: keep it, and rerun it after the fix.
- Keep simulation runs bounded and fast, so many seeds run in CI and longer runs can go overnight.

## When full simulation is too much

Even without a simulator, injected clocks, seeded randomness, ordered processing, and side effects at the edges make tests reliable and failures reproducible. Apply them to any component that touches time, randomness, concurrency, or I/O.
