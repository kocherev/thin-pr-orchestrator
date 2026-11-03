import unittest

from flags import parse_flag


class ParseFlagTest(unittest.TestCase):
    def test_reads_true_and_false_and_rejects_other_words(self):
        self.assertIs(parse_flag("true"), True)
        self.assertIs(parse_flag("false"), False)
        self.assertIsNone(parse_flag("maybe"))
