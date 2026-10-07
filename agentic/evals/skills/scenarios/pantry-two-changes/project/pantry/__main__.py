import argparse
from datetime import date
from pathlib import Path

from .expiry import expiring_soon
from .listing import format_items
from .store import load


def main() -> None:
    parser = argparse.ArgumentParser(prog="pantry")
    parser.add_argument("--file", type=Path, default=Path("pantry.json"))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="show everything")
    expiring = commands.add_parser("expiring", help="show items to use up soon")
    expiring.add_argument("--days", type=int, default=3)
    args = parser.parse_args()

    items = load(args.file)
    if args.command == "expiring":
        items = expiring_soon(items, date.today(), args.days)
    for line in format_items(items):
        print(line)


if __name__ == "__main__":
    main()
