#!/usr/bin/env python3
"""Render the quota data Claude supplies; never fetch credentials or provider APIs."""

import json
import math
import sys
import time
from typing import Optional, cast

MAX_INPUT_BYTES = 65_536
MAX_EPOCH_SECONDS = 2 ** 53 - 1
GAUGE = "▁▂▃▄▅▆▇█"
UNKNOWN = "claude limits: n/a"


def object_fields(value: object) -> Optional[dict[str, object]]:
    if not isinstance(value, dict):
        return None
    # JSON object keys are strings; the value type remains untrusted.
    return cast(dict[str, object], value)


def reset_countdown(seconds: int) -> str:
    assert seconds >= 0
    if seconds < 60:
        return "<1m"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}h{minutes % 60}m"
    days = hours // 24
    return f"{days}d{hours % 24}h" if hours % 24 else f"{days}d"


def format_statusline(data: object, now: int) -> str:
    assert type(now) is int and now >= 0
    root = object_fields(data)
    limits = object_fields(root.get("rate_limits")) if root is not None else None
    if limits is None:
        return UNKNOWN
    parts: list[str] = []
    for key, label in [("five_hour", "5h"), ("seven_day", "7d")]:
        window = object_fields(limits.get(key))
        if window is None:
            continue
        percent = window.get("used_percentage")
        if not isinstance(percent, (int, float)) or isinstance(percent, bool):
            continue
        if not 0 <= percent <= 100 or not math.isfinite(percent):
            continue
        reset = window.get("resets_at")
        reset_text = ""
        if isinstance(reset, (int, float)) and not isinstance(reset, bool) and 0 < reset <= MAX_EPOCH_SECONDS and math.isfinite(reset):
            if reset <= now:
                continue
            reset_text = " ↻" + reset_countdown(math.floor(reset - now))
        index = math.floor(percent * (len(GAUGE) - 1) / 100 + 0.5)
        assert 0 <= index < len(GAUGE)
        parts.append(f"{label} {GAUGE[index]} {math.floor(percent + 0.5)}%{reset_text}")
    return "claude " + " · ".join(parts) if parts else UNKNOWN


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        print(UNKNOWN)
        return 0
    try:
        data = cast(object, json.loads(raw))
    except (ValueError, UnicodeDecodeError, RecursionError):
        print(UNKNOWN)
        return 0
    print(format_statusline(data, int(time.time())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
