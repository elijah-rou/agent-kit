import unittest

from tabsplit import add_tip, split_evenly


class AddTipTests(unittest.TestCase):
    def test_adds_percentage(self):
        self.assertEqual(add_tip(10000, 18), 11800)

    def test_zero_tip(self):
        self.assertEqual(add_tip(8450, 0), 8450)

    def test_rejects_negative_tip(self):
        with self.assertRaises(ValueError):
            add_tip(1000, -5)


class SplitEvenlyTests(unittest.TestCase):
    def test_even_split(self):
        self.assertEqual(split_evenly(9000, 3), [3000, 3000, 3000])

    def test_single_person_pays_everything(self):
        self.assertEqual(split_evenly(8450, 1), [8450])

    def test_rejects_nobody(self):
        with self.assertRaises(ValueError):
            split_evenly(1000, 0)


if __name__ == "__main__":
    unittest.main()
