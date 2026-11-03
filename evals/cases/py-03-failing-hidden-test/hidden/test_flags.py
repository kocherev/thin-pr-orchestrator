import unittest

from flags import parse_flag


class HiddenParseFlagTest(unittest.TestCase):
    def test_reads_yes_and_no_in_any_case(self):
        self.assertIs(parse_flag("YES"), True)
        self.assertIs(parse_flag("no"), False)
