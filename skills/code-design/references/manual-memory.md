# Memory in manually managed languages

This applies to C, C++, Odin, and Zig. Examples use Zig names; use the equivalent arena, pool, and fixed-buffer allocators elsewhere.

The goal is allocation whose lifetime is obvious from the control flow: a reader should see where memory comes from, who frees it, and when, without tracing the whole program.

## Choose the lifetime first

- **Program lifetime:** attempt static allocation first: allocate long-lived state during initialization, sized from configured limits, and do not free or reallocate it afterwards. Where the system commits to this, assert that the steady state performs no allocation.
- **When static allocation is the wrong fit:** some settings need dynamic allocation by design, such as game engines streaming levels and assets, editors, or workloads sized only at runtime. Decide deliberately, then keep each dynamic lifetime as obvious as the cases below.
- **Phase, request, or frame lifetime:** use an arena created at the start of the unit of work and freed once at its end with `defer arena.deinit()`. Individual frees inside the arena are noise; do not write them.
- **Bounded scratch space:** use a fixed buffer (`std.heap.FixedBufferAllocator` or a stack array) sized from a named limit, and handle the out-of-space error explicitly.
- **Genuinely dynamic, independent lifetimes:** use a general-purpose allocator with paired `defer` or `errdefer` frees. This should be the rare case; prefer a pool of fixed-size objects when the count is bounded.

## Rules

- Pass allocators explicitly, as a constructor or function parameter. No hidden or global allocation.
- Name the allocator by its role (`gpa`, `arena`, `scratch`), so a reader knows whether a returned value must be freed.
- Write `defer` or `errdefer` on the line after the allocation it releases, and keep the pair visually grouped.
- A function that returns allocated memory documents the owner and lifetime in its signature or doc comment; prefer having the caller pass the destination buffer or arena.
- Initialize large structs in place through an out pointer when they are immovable or would otherwise be copied, and initialize their container in place too.
- Zero or fully write buffers before exposing them; partially written buffers leak stale data and break determinism.
- Use `std.testing.allocator` in tests so leaks and double frees fail the test, and test the out-of-memory paths with a failing allocator.
- Use explicit size types (`u32`, `u64`) for counts and indexes, and convert to `usize` only at indexing.
