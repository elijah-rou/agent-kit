from typing import List


def add_tip(total_cents: int, tip_percent: float) -> int:
    """Return the total with a percentage tip added, rounded to the nearest cent."""
    if tip_percent < 0:
        raise ValueError("tip must not be negative")
    return round(total_cents * (100 + tip_percent) / 100)


def split_evenly(total_cents: int, people: int) -> List[int]:
    """Split a bill into one share per person, in cents."""
    if people < 1:
        raise ValueError("need at least one person")
    if total_cents < 0:
        raise ValueError("total must not be negative")
    share = round(total_cents / people)
    return [share] * people
