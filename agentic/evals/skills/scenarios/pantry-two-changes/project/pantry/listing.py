from typing import List

from .store import Item


def format_items(items: List[Item]) -> List[str]:
    """One display line per item."""
    width = max((len(item.name) for item in items), default=0)
    lines = []
    for item in items:
        when = item.best_before.isoformat() if item.best_before else "-"
        lines.append(f"{item.name.ljust(width)}  {item.quantity:>8}  {when}")
    return lines
