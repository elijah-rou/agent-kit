import argparse
from decimal import Decimal

from .split import add_tip, split_evenly


def parse_amount(text: str) -> int:
    return int((Decimal(text) * 100).quantize(Decimal("1")))


def main() -> None:
    parser = argparse.ArgumentParser(prog="tabsplit", description="Split a bill evenly.")
    parser.add_argument("total", help="bill total, e.g. 84.50")
    parser.add_argument("people", type=int, help="number of people paying")
    parser.add_argument("--tip", type=float, default=0, help="tip percentage to add first")
    args = parser.parse_args()

    total = add_tip(parse_amount(args.total), args.tip)
    for number, share in enumerate(split_evenly(total, args.people), start=1):
        print(f"Person {number}: ${share / 100:.2f}")
    print(f"Total: ${total / 100:.2f}")


if __name__ == "__main__":
    main()
