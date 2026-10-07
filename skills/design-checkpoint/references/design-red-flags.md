# Design red flags

Screen every candidate before choosing a base. A red flag is a reason to revise or reject a shape. Assume the next contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles.

## Shallow module

A large interface that hides little. Callers coordinate several calls for one operation, options expose internal stages, and learning the interface does not spare the caller from learning the implementation. Prefer a small interface over substantial behavior. A deep module is not a deep call chain: a chain scatters understanding across layers.

## Information leakage

One internal decision (a representation, policy, or protocol detail) appears in several modules, so changing it means coordinated edits. Public re-exports of wire or storage types are leakage: parse external data into domain types behind the interface.

## Temporal decomposition

Modules split by execution order (load, validate, transform, save) that each repeat one representation and its invariants. Group code by the knowledge it owns instead.

## Pass-through layer

A method or module that forwards the same arguments to something of the same shape, adding no policy or adaptation. Remove it.

## Split ownership

More than one module writes the same state, or keeps its own copy. Give each piece of state one owner; others read it or ask the owner.

## Two ways to do one task

An agent copies whichever way it finds first, so both keep gaining callers. Keep one, move callers, delete the other in the same change.

## Importable internals

Internals reachable from outside become interface the first time an agent imports them. Make outside imports fail the build.

## Hand-synced lists

The same items listed in several places. Derive the others from one list, or fail the build when they disagree.

## Systems and games

- **Unclear ownership:** no single answer to "who frees this, and when", or lifetimes that depend on call order across modules.
- **Allocation in the hot path:** per-frame or per-request allocation where a preallocated or bounded structure fits.
- **Unbounded structures:** queues, caches, or buffers with no stated limit and no behavior at the limit.
- **Shared mutable state across threads** without a stated single writer, partition, or synchronization rule.
- **Hidden nondeterminism:** wall-clock time, unseeded randomness, or iteration order of unordered containers inside simulation or replay paths.
- **Access patterns that need a later index or cache:** if the dominant access pattern does not fit the core structure, the structure is wrong.
