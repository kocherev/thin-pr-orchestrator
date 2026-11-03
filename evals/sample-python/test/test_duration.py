import unittest

from duration import format_seconds


class FormatSecondsTest(unittest.TestCase):
    def test_renders_seconds(self):
        self.assertEqual(format_seconds(42), "42s")
