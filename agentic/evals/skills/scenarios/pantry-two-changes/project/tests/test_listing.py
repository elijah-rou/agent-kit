import unittest
from datetime import date

from pantry.listing import format_items
from pantry.store import Item


class FormatItemsTests(unittest.TestCase):
    def test_one_line_per_item_with_aligned_names(self):
        lines = format_items([Item("milk", "1 l", date(2026, 10, 8)), Item("chickpeas", "3 tins", None)])
        self.assertEqual(lines, ["milk            1 l  2026-10-08", "chickpeas    3 tins  -"])

    def test_empty_pantry(self):
        self.assertEqual(format_items([]), [])


if __name__ == "__main__":
    unittest.main()
