#!/usr/bin/env python3
"""Bound validation and return observed workspace evidence, not authorization."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from types import FrameType
from typing import Literal, Optional, TypedDict, cast
import uuid

Action = Literal["test", "lint", "typecheck"]
Outcome = Literal["passed", "failed", "timed_out", "cancelled", "execution_error", "unsupported"]
MAX_OUTPUT_BYTES = 30000
MAX_GIT_BYTES = 1048576
MAX_UNTRACKED_FILES = 100
MAX_UNTRACKED_BYTES = 10 * 1048576
MAX_WORKSPACE_FILES = 1000
MAX_WORKSPACE_BYTES = 20 * 1048576
GIT_PREFIX = ["git", "--no-pager", "--no-optional-locks", "-c", "color.ui=false", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"]
MARKERS = ["package.json", "bun.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.toml", "go.mod", "pyproject.toml", "uv.lock", "Makefile", "justfile"]


class RunResult(TypedDict):
    outcome: Outcome
    exit_code: int | None
    output: bytes
    truncated: bool
    elapsed_ms: int


def run(argv: list[str], cwd: Path, timeout_ms: int, limit: int) -> RunResult:
    assert argv and timeout_ms > 0 and limit > 0
    started = time.monotonic()
    deadline = started + timeout_ms / 1000
    head = b""
    tail = b""
    total = 0
    outcome: Outcome = "execution_error"
    code = None
    try:
        process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as error:
        return {"outcome": outcome, "exit_code": None, "output": str(error).encode()[:limit], "truncated": False, "elapsed_ms": 0}
    try:
        assert process.stdout is not None
        with selectors.DefaultSelector() as selector:
            _ = selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    outcome = "timed_out"
                    break
                for key, _events in selector.select(min(remaining, 0.1)):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        _ = selector.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    head_room = limit // 3 - len(head)
                    head += chunk[:head_room]
                    tail = (tail + chunk[max(head_room, 0):])[-(limit - limit // 3):]
            else:
                try:
                    code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
                    outcome = "passed" if code == 0 else "failed"
                except subprocess.TimeoutExpired:
                    outcome = "timed_out"
    except OSError as error:
        head = str(error).encode()[:limit]
        tail = b""
        outcome = "execution_error"
    finally:
        # This group was created by this invocation, never adopted from stored PID state.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            code = process.wait(timeout=0.2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait(timeout=2)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if process.stdout is not None:
            process.stdout.close()
    output = head + (b"\n[... truncated ...]\n" if total > limit else b"") + tail
    return {"outcome": outcome, "exit_code": code, "output": output, "truncated": total > limit, "elapsed_ms": round((time.monotonic() - started) * 1000)}


def git(cwd: Path, *arguments: str) -> RunResult:
    return run([*GIT_PREFIX, "-C", str(cwd), *arguments], cwd, 3000, MAX_GIT_BYTES)


def repository(cwd: Path) -> Path | None:
    result = git(cwd, "rev-parse", "--show-toplevel")
    if result["outcome"] != "passed" or result["truncated"]:
        return None
    try:
        return Path(result["output"].decode().strip()).resolve(strict=True)
    except (OSError, UnicodeDecodeError):
        return None


def fingerprint(cwd: Path) -> dict[str, object]:
    root = repository(cwd)
    if root is None:
        return {"state": "unavailable", "repositoryRoot": str(cwd), "reason": "Git workspace unreadable or absent"}
    unavailable: dict[str, object] = {"state": "unavailable", "repositoryRoot": str(root)}
    digest = hashlib.sha256(os.fsencode(root))
    try:
        metadata: list[bytes] = []
        # Reading the index and raw bytes avoids clean/textconv filters and normalized-diff collisions.
        for arguments in [("rev-parse", "--verify", "HEAD"), ("ls-files", "--stage", "-z"), ("ls-files", "--others", "--exclude-standard", "-z")]:
            result = git(root, *arguments)
            if result["outcome"] != "passed" or result["truncated"]:
                return {**unavailable, "reason": "Git fingerprint output unavailable or over limit"}
            data = result["output"]
            metadata.append(data)
            digest.update(len(data).to_bytes(8, "big"))
            digest.update(data)
        head = metadata[0].decode().strip()
        tracked: set[str] = set()
        for entry in metadata[1].split(b"\0"):
            if not entry:
                continue
            mode_and_hash, name = entry.split(b"\t", 1)
            if mode_and_hash.startswith(b"160000 "):
                return {**unavailable, "reason": "submodule content is not fingerprinted"}
            tracked.add(os.fsdecode(name))
        untracked = {os.fsdecode(path) for path in metadata[2].split(b"\0") if path}
        if len(untracked) > MAX_UNTRACKED_FILES:
            return {**unavailable, "reason": "untracked file count limit exceeded"}
        if len(tracked | untracked) > MAX_WORKSPACE_FILES:
            return {**unavailable, "reason": "workspace file count limit exceeded"}
        byte_count = 0
        untracked_bytes = 0
        for relative in sorted(tracked | untracked):
            path = root / relative
            if not path.parent.resolve().is_relative_to(root):
                return {**unavailable, "reason": "file path escapes workspace"}
            name = os.fsencode(relative)
            digest.update(len(name).to_bytes(8, "big"))
            digest.update(name)
            try:
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except FileNotFoundError:
                if relative in untracked:
                    return {**unavailable, "reason": "untracked file disappeared while observed"}
                digest.update(b"missing\0")
                continue
            try:
                before = os.fstat(descriptor)
                if not stat.S_ISREG(before.st_mode):
                    return {**unavailable, "reason": "workspace entry is not a regular file"}
                byte_count += before.st_size
                untracked_bytes += before.st_size if relative in untracked else 0
                if byte_count > MAX_WORKSPACE_BYTES or untracked_bytes > MAX_UNTRACKED_BYTES:
                    return {**unavailable, "reason": "workspace or untracked byte limit exceeded"}
                content = bytearray()
                while len(content) <= before.st_size:
                    chunk = os.read(descriptor, min(65536, before.st_size + 1 - len(content)))
                    if not chunk:
                        break
                    content.extend(chunk)
                after = os.fstat(descriptor)
                if len(content) != before.st_size or (before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    return {**unavailable, "reason": "workspace file changed while observed"}
                digest.update(b"regular\0")
                digest.update(stat.S_IMODE(before.st_mode).to_bytes(4, "big"))
                digest.update(len(content).to_bytes(8, "big"))
                digest.update(content)
            finally:
                os.close(descriptor)
        return {"state": "available", "repositoryRoot": str(root), "head": head, "digest": digest.hexdigest()}
    except (OSError, UnicodeDecodeError, ValueError):
        return {**unavailable, "reason": "workspace entry unreadable or not a regular file"}


def discover(cwd: Path) -> Path:
    boundary = repository(cwd) or cwd
    current = cwd
    for _depth in range(32):
        if any((current / marker).is_file() for marker in MARKERS):
            return current
        if current == boundary or current.parent == current:
            return current
        current = current.parent
    return cwd


def command_for(root: Path, action: Action) -> str | None:
    def has(name: str) -> bool:
        return (root / name).is_file()
    if has("package.json"):
        runner = "bun run" if has("bun.lock") else "pnpm" if has("pnpm-lock.yaml") else "yarn" if has("yarn.lock") else "npm run"
        return f"{runner} {action}"
    if has("Cargo.toml"):
        return {"test": "cargo test", "lint": "cargo clippy --all-targets --all-features -- -D warnings", "typecheck": "cargo check --all-targets --all-features"}[action]
    if has("go.mod"):
        return "go vet ./..." if action == "lint" else "go test ./..."
    if has("pyproject.toml") or has("uv.lock"):
        return ("uv run --frozen --no-sync --no-python-downloads " if has("uv.lock") else "") + {"test": "pytest", "lint": "ruff check .", "typecheck": "pyright"}[action]
    if has("Makefile"):
        return f"make {action}"
    if has("justfile"):
        return f"just {action}"
    return None


def validate(action: Action, cwd: Path, command: str | None, timeout_ms: int, actor: str) -> dict[str, object]:
    assert action in ("test", "lint", "typecheck")
    assert 1000 <= timeout_ms <= 300000
    assert command is None or 0 < len(command.strip()) <= 8192
    root = cwd.resolve(strict=True)
    assert root.is_dir()
    if command is None:
        root = discover(root)
    selected = command.strip() if command is not None else command_for(root, action)
    before = fingerprint(root)
    started = datetime.now(timezone.utc).isoformat()
    if selected is None:
        result: RunResult = {"outcome": "unsupported", "exit_code": None, "output": b"No automatic validation command detected; pass command explicitly.", "truncated": False, "elapsed_ms": 0}
    else:
        result = run(["/bin/sh", "-c", selected], root, timeout_ms, MAX_OUTPUT_BYTES)
    after = fingerprint(root)
    stable = before == after if before["state"] == "available" and after["state"] == "available" else None
    gaps: list[str] = []
    if stable is False:
        gaps.append("Workspace changed between observations; this receipt cannot identify one unchanged revision.")
    if stable is None:
        gaps.append("Workspace fingerprint unavailable; no content-equivalence claim.")
    if result["truncated"]:
        gaps.append("Output truncated; full diagnostics were not retained.")
    output = result["output"].decode("utf-8", "replace").strip()
    failure = re.compile(r"error|fail(?:ed|ure)?|panic|exception|assert|\bE\d{3,4}\b|\bTS\d{4}\b", re.IGNORECASE)
    summary = [line for line in output.splitlines() if failure.search(line)][:40] if result["outcome"] != "passed" else []
    if not summary:
        summary = ["Command exited zero; inspect output and receipt gaps."] if result["outcome"] == "passed" else output.splitlines()[-20:]
    receipt = {"version": 1, "attemptId": str(uuid.uuid4()), "authority": "local-verification", "verifier": actor, "startedAt": started, "finishedAt": datetime.now(timezone.utc).isoformat(), "tool": "project_validate", "action": action, "command": selected, "cwd": str(root), "outcome": result["outcome"], "exitCode": result["exit_code"], "workspaceBefore": before, "workspaceAfter": after, "workspaceStable": stable, "coverage": "HEAD, index entries, tracked/nonignored untracked raw regular-file bytes and modes; excludes ignored files, dependencies and environment; observations are not atomic", "artifacts": [], "residualGaps": gaps}
    return {"outcome": result["outcome"], "action": action, "command": selected, "cwd": str(root), "exitCode": result["exit_code"], "elapsedMs": result["elapsed_ms"], "truncated": result["truncated"], "summary": summary, "output": output, "residualGaps": gaps, "verificationReceipt": receipt}


def interrupt(_number: int, _frame: FrameType | None) -> None:
    # A second termination request must not interrupt owned-group cleanup.
    _ = signal.signal(signal.SIGTERM, signal.SIG_IGN)
    _ = signal.signal(signal.SIGINT, signal.SIG_IGN)
    raise KeyboardInterrupt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument("--action", required=True, choices=["test", "lint", "typecheck"])
    _ = parser.add_argument("--cwd", required=True)
    _ = parser.add_argument("--command")
    _ = parser.add_argument("--timeout-ms", type=int, default=120000)
    _ = parser.add_argument("--actor", default="unknown")
    arguments = parser.parse_args()
    action = cast(Action, arguments.action)
    cwd = Path(cast(str, arguments.cwd))
    command = cast(Optional[str], arguments.command)
    timeout_ms = cast(int, arguments.timeout_ms)
    actor = cast(str, arguments.actor)
    if not 1000 <= timeout_ms <= 300000 or command is not None and not 0 < len(command.strip()) <= 8192:
        parser.error("timeout must be 1000..300000 ms and command must contain 1..8192 characters")
    previous = [(number, signal.signal(number, interrupt)) for number in (signal.SIGTERM, signal.SIGINT)]
    try:
        result = validate(action, cwd, command, timeout_ms, actor)
    except KeyboardInterrupt:
        result = {"outcome": "cancelled", "verificationReceipt": None, "error": "Validation interrupted; no completed workspace receipt"}
    except (OSError, AssertionError) as error:
        result = {"outcome": "execution_error", "verificationReceipt": None, "error": str(error)}
    finally:
        for number, handler in previous:
            _ = signal.signal(number, handler)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
