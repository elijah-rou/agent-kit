import argparse

from .totals import invoice_total


def main():
    parser = argparse.ArgumentParser(prog="invoicer")
    parser.add_argument("amount", help="order amount in dollars, for example 40.00")
    parser.add_argument("--code", default=None)
    parser.add_argument("--tax", type=int, default=0, help="sales tax percent")
    args = parser.parse_args()
    cents = round(float(args.amount) * 100)
    total = invoice_total([(cents, 1)], args.code, args.tax)
    print(f"${total // 100}.{total % 100:02d}")


main()
