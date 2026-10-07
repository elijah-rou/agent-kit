from datetime import date
from typing import List

from .store import Item


def expiring_soon(items: List[Item], today: date, days: int = 3) -> List[Item]:
    """Items whose best-before date falls within `days` days of `today`, soonest first."""
    if days < 0:
        raise ValueError("days must not be negative")
    soon = [item for item in items if (item.best_before - today).days <= days]
    return sorted(soon, key=lambda item: item.best_before)
