# Memory and ownership in Rust

The goal is ownership a reader can follow without lifetime puzzles: each value has one obvious owner, borrows are short, and shared or cyclic structures use explicit handles.

## Choose the holder

- **One owner:** plain owned values, `Vec<T>`, and `Box<T>`. This is the default.
- **Read-only sharing across threads or tasks:** `Arc<T>` of immutable data. Prefer passing `&T` or cloning the `Arc` over interior mutability.
- **Shared mutable state:** one owner that others message (a task, an actor, or a channel), or `Arc<Mutex<T>>` behind a small API that holds the lock briefly. Avoid webs of `Rc<RefCell<T>>`.
- **Graphs, trees with parent links, and caches:** store nodes in a `Vec<T>` or slab, and refer to them by typed index handles such as `struct NodeId(u32)`, rather than references or reference-counted cycles.
- **Many short-lived allocations with one lifetime:** an arena (`bumpalo`, or a `Vec` reset per phase) freed once at the end of the phase.

## Rules

- Keep lifetimes local. When a struct needs a lifetime parameter to hold a borrow, consider owning the data or storing an index instead.
- Do not `.clone()` just to satisfy the borrow checker; restructure so the borrow ends, or clone something cheap (an `Arc` or a handle) deliberately.
- Preallocate with `with_capacity` from named limits and keep allocation out of hot loops; reuse buffers with `clear()`.
- Prefer exhaustive `match` over `if let` chains, and iterator adapters over index loops, except in hot paths where a plain loop is clearer or measurably faster.
- Make invalid states unrepresentable with enums and newtypes, and keep constructors as the only way to build checked types.
- Minimize `unsafe`. Isolate each block behind a safe API, write a `// SAFETY:` comment stating the invariant it relies on, and assert that invariant in debug builds.
- Treat `unwrap` and `expect` as assertions: use them only for true invariants, with a message saying why the value must be present.
