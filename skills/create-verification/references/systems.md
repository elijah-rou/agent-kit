# Systems recipe

For libraries, services, storage engines, schedulers, and concurrent code, where the user-visible surface is an API and the hard bugs live in ordering, memory, and rare inputs. The user stays in the loop for core data structures, concurrency, and memory ownership; the agent supplies the evidence.

## Launch and Doctor

- Launch builds the exact configuration under test (debug, release, sanitizer) and records the toolchain version and build flags in the evidence directory.
- Doctor confirms the toolchain version, build mode, and any required kernel or hardware features, and that no instance from another run holds the ports or data directory.

## Deterministic simulation testing

Use it when behavior depends on interleavings, time, I/O, or failures.

- Route time, randomness, I/O, and scheduling through injected interfaces that a simulator controls. A single seed must determine the whole run.
- Each run prints its seed first. Every failing seed is replayable with one command, and the skill shows that command.
- Inject faults on purpose: dropped and reordered messages, partial writes, crashes and restarts, clock jumps.
- Check invariants continuously during the run, not only at the end.
- Evidence: the seed, the command, the invariant that failed, and a trace of the minimal failing run.

## Fuzzing

Use it for parsers, decoders, protocol handlers, and any function on untrusted input.

- Prefer the language's native fuzzer or an existing harness in the repository.
- Time-box each run and say how long it ran; a fuzzer that found nothing in 30 seconds proves little.
- Keep the corpus between runs; add every crash input to it after minimizing.
- Evidence: the crashing input, the minimized input, the stack trace, and the replay command.

## Sanitizers and checkers

- Run the test suite and the drive steps under the address, undefined-behavior, and thread sanitizers where the toolchain supports them; use the language's interpreter-level checker where one exists.
- Sanitizer builds are separate configurations; never compare their performance with release builds.
- Evidence: the full sanitizer report, with the build flags that produced it.

## Benchmarks

A number is evidence only after it has been vetted:

- **Limiter:** name what bounds the result (CPU, memory bandwidth, I/O, lock contention, the benchmark harness itself) and show the measurement that says so.
- **Repeatability:** several runs, with the spread reported; pin CPU frequency and isolate the machine where possible; warm up first.
- **Relevance:** the workload resembles real use; the same scenario runs before and after the change.
- **Whole commands:** time a binary, build, or test suite with the `verification` skill's command benchmark method.

Report one primary number in `before -> after` form with its unit and spread.

## Cleanup

Stop the processes and containers this run started, remove temporary data directories, and keep seeds, corpora, crash inputs, reports, and traces in the evidence directory.
