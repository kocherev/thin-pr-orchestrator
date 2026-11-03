import unittest

from slug import slugify


class HiddenSlugifyTest(unittest.TestCase):
    def test_collapses_runs_of_whitespace(self):
        self.assertEqual(slugify("Hello   World"), "hello-world")
        self.assertEqual(slugify(" Tabs\tand  spaces "), "tabs-and-spaces")
