import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import List, Optional


@dataclass(frozen=True)
class Item:
    name: str
    quantity: str
    best_before: Optional[date] = None


def load(path: Path) -> List[Item]:
    raw = json.loads(path.read_text())
    return [
        Item(
            name=entry["name"],
            quantity=entry["quantity"],
            best_before=date.fromisoformat(entry["best_before"]) if "best_before" in entry else None,
        )
        for entry in raw
    ]
