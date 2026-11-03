import unittest

from duration import format_seconds


class HiddenFormatSecondsTest(unittest.TestCase):
    def test_renders_whole_and_mixed_minutes(self):
        self.assertEqual(format_seconds(61), "1m 1s")
        self.assertEqual(format_seconds(3600), "60m")
        self.assertEqual(format_seconds(0), "0s")
