---
name: code-design
description: Design rules for writing or restructuring code, in the spirit of TigerStyle - assertions, explicit limits, control flow, pattern matching and higher-order functions, data shapes, performance, naming, memory ownership and allocation (including manual memory in C, C++, Odin, and Zig, and Rust ownership), determinism, and simulation testing. Use when implementing, refactoring, or reviewing source code. Not needed for prose, configuration-only, or documentation edits.
---

# Code design

Safety first, then performance, then the experience of everyone who reads and runs the code. Repository conventions and the language's own idioms take precedence; apply these where the codebase leaves the choice open. Read a reference only when the task reaches it:

| Situation | Read |
| --- | --- |
| C, C++, Odin, Zig, or other manually managed memory | `references/manual-memory.md` |
| Rust ownership, borrowing, or `unsafe` | `references/rust-memory.md` |
| Time, randomness, I/O, concurrency, or anything that should be simulation-tested | `references/determinism.md` |
| Refactoring, sizing a diff, or tempted to add an abstraction, layer, or signal threading | `references/laziness-protocol.md` |
| Sequencing an addition, refactor, or rewrite onto code with dead paths or redundant checks | `references/subtract-before-you-add.md` |

## Safety

- Assert arguments, returns, pre- and postconditions, and invariants, in both the positive space (what must hold) and the negative space (what must not happen). Write at least two assertions per non-trivial function.
- Split compound assertions: `assert(a); assert(b);` rather than `assert(a and b)`. Assert implications as `if (a) assert(b);`. Pair assertions across paths, for example before a write and after the matching read.
- Assert relationships between compile-time constants and type sizes at compile time. Where a condition is critical and surprising, state it as a blatantly true assertion rather than a comment, so it documents and checks at once.
- Assertions are design checks, not debug noise; they turn correctness bugs into crashes that tests and fuzzers find. They do not replace understanding: build the mental model first, then encode it.
- Keep preconditions true for the whole function: after an `await`, yield, or callback, recheck any state asserted before it rather than relying on the earlier assertion.
- Handle every error. Fail fast on programmer error and during initialization; recover gracefully in runtime loops.
- Put a limit on everything: loops, queues, retries, buffers, concurrency, and execution time. A loop that must not terminate, such as an event loop, asserts that.
- Prefer explicitly sized integer types (`u32`, `i64`) over architecture-dependent ones where the language allows.
- Do not act directly on external events. Queue them and process them at the program's own pace, in bounded batches, so control flow and work per tick stay under the program's control. Run timers and periodic work on fixed intervals rather than ad hoc delays.
- Minimize dependencies; each one adds supply-chain, safety, and performance risk. Prefer the standard library and a small amount of owned code over a package for something simple, and a small standard toolbox over many specialized tools.

## Control flow

- Keep control flow simple, explicit, and top to bottom. Avoid hidden control flow: magic methods, implicit middleware, decorator-driven branching, and exceptions used for ordinary flow.
- Push `if`s up and `for`s down: parents own branching and state changes, while helpers do non-branching work and leaf functions stay pure.
- Prefer pattern matching where the language has it: exhaustive `match` or `switch` with destructuring and an explicit branch for unknown or impossible states, rather than `if`/`else` chains over a tag.
- Prefer higher-order functions (`map`, `filter`, `fold`, iterator pipelines) where the language supports them and they read clearly. In hot loops, or where a closure would hide allocation or dispatch cost, use a plain bounded loop in a standalone function with primitive arguments.
- Prefer iteration where execution must be bounded. Where recursion is natural for the domain or idiomatic in the language, as in OCaml, Elixir, Gleam, or Clojure, use it, preferably tail-recursive, and bound its depth by construction or with an explicit limit.
- Split compound conditions into nested branches, and turn `else if` chains that do not share one discriminant into nested `else { if ... }` trees. Give each `if` a matching `else` when the negative space needs handling or an assertion. State invariants positively: `if (index < count)` rather than `if (index >= count)`.
- Keep functions within 70 lines, so each fits on one screen. Split along the control-flow and data-flow seams above: the parent keeps the branches, and helpers take the straight-line work. Within a function, group logic visually and read top to bottom.

## Data and performance

- Sketch performance at design time across network, storage, memory, and compute, each for bandwidth and latency. Optimize the slowest resource first, adjusted for how often it is used.
- Choose data shapes from the dominant access patterns and invariants before layering logic. Prefer fixed-size, cache-friendly layouts on hot paths: size hot structs to the cache line and align them to their largest field.
- Separate the control plane from the data plane, and batch work to amortize fixed costs. Batching is also what makes dense assertions affordable.
- Avoid copies and repeated serialization on the data plane. Pass large values by reference when a copy is not intended, and do not keep aliases or duplicate state that can drift out of sync.
- Match the memory strategy to the language and setting. In garbage-collected or runtime-managed languages (Go, Python, TypeScript, JavaScript, Clojure, Elixir, Gleam) and in Rust, static allocation does not apply: bound sizes, preallocate where it is cheap, and keep allocation out of hot loops.
- In manually managed languages (C, C++, Odin, Zig), attempt static allocation of long-lived state at startup, and use common sense about where dynamic allocation is the better design, such as game engines streaming assets or workloads sized only at runtime. When allocating dynamically, prefer arenas and pools with obvious lifetimes.

## Interfaces and structure

- Keep interfaces small, and define the fault model at each boundary. Wrap nondeterministic physical interfaces (clocks, randomness, networks, disks) in deterministic logical ones.
- Keep signatures low-dimensional: few parameters and the simplest sufficient return type (nothing over a bool, a bool over a value, a value over an optional, an optional over an error union). Use an options struct when several parameters share a type.
- No inheritance; use composition, interfaces, traits, or sum types. Minimize global state and inject dependencies such as allocators, clocks, and tracers through constructors, from most general to most specific.
- Collapse pass-through layers, do not abstract three similar lines prematurely, and do not wrap a single function in a class.
- Declare variables at the smallest practical scope, keep few in scope at once, and compute or check values close to where they are used.
- Treat index, count, and size as distinct quantities with explicit conversions (count is index plus one; size is count times the unit), and state rounding intent on division.
- Acquire resources and arrange their cleanup on the next line; group allocation and cleanup visually so leaks stand out.
- Return explicitly, and use type aliases for verbose types.

## Naming and comments

- Follow the language's and the project's naming conventions. Where the choice is open, use `snake_case` and keep acronyms capitalized (`VSRState`, not `VsrState`).
- Get the nouns and verbs right; names say what a thing is or does. Give each name one meaning, never one that shifts with context, and prefer nouns that also work in documentation and conversation. No abbreviations outside conventional loop indices and math.
- Put units and qualifiers last, most significant first: `latency_ms_max`, not `max_latency_ms`. Prefer related names of equal length, such as `source` and `target`.
- Name things by role so their handling is clear: `arena` versus `gpa` says whether to free. Prefix a callback with its caller's name: `read_sector` and `read_sector_callback`. Callbacks go last in parameter lists. Name nullable parameters so `null` reads clearly at the call site.
- Order files for a top-down first read: important things and entry points first. Within a type, put fields first, then nested types, then methods, and promote a complex nested type to the top level. When no order is clearly better, sort alphabetically by big-endian name.
- Comments say why, and for tests, the goal and method. Write them as sentences. Rewrite code that needs a what-comment.

## Tooling and configuration

- Treat warnings as errors at the strictest practical setting, from the start.
- Configuration precedence: command-line flag, environment variable, config file, sensible default. Default logging to debug; use info or warn for noteworthy events.
- Follow the language's and the project's formatter and conventions. Where the choice is open, use 4-space indentation, lines of at most 100 columns, and braces on every `if` that does not fit on one line.
- Use long-form flags in scripts and documentation (`--force`, not `-f`); single-letter flags are for interactive use.
- Write scripts and tooling in the language the product is built in, so they are portable, typed, tested, and share its toolchain. Exceptions are repositories that span several languages, where tooling follows the part it serves, and places that need a shell script, such as bootstrapping before the toolchain exists.
