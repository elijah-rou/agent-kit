import unittest
from datetime import date

from pantry.expiry import expiring_soon
from pantry.store import Item

TODAY = date(2026, 10, 7)


class ExpiringSoonTests(unittest.TestCase):
    def test_keeps_items_inside_the_window_soonest_first(self):
        items = [
            Item("yoghurt", "500 g", date(2026, 10, 9)),
            Item("rice", "2 kg", date(2027, 5, 1)),
            Item("milk", "1 l", date(2026, 10, 8)),
        ]
        self.assertEqual([i.name for i in expiring_soon(items, TODAY)], ["milk", "yoghurt"])

    def test_includes_already_expired_items(self):
        items = [Item("cream", "300 ml", date(2026, 10, 1))]
        self.assertEqual([i.name for i in expiring_soon(items, TODAY)], ["cream"])

    def test_window_is_configurable(self):
        items = [Item("eggs", "6", date(2026, 10, 14))]
        self.assertEqual(expiring_soon(items, TODAY), [])
        self.assertEqual([i.name for i in expiring_soon(items, TODAY, days=7)], ["eggs"])


if __name__ == "__main__":
    unittest.main()
