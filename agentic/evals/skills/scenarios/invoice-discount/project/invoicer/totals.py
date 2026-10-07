"""Invoice totals. All amounts are integer cents."""

DISCOUNTS = {"SAVE10": ("percent", 10), "FLAT5": ("flat", 500)}


def subtotal(items):
    """Sum of price * quantity for (price_cents, quantity) pairs."""
    return sum(price * quantity for price, quantity in items)


def discount_amount(amount, code):
    """Cents taken off `amount` by a discount code; unknown codes raise KeyError."""
    if code is None:
        return 0
    kind, value = DISCOUNTS[code]
    if kind == "percent":
        return amount * value // 100
    return min(value, amount)


def invoice_total(items, code=None, tax_percent=0):
    """Total in cents after the discount code and sales tax (tax rounds down)."""
    base = subtotal(items)
    tax = base * tax_percent // 100
    return base + tax - discount_amount(base, code)
