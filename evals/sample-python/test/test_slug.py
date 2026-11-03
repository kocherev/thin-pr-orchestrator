import unittest

from slug import slugify


class SlugifyTest(unittest.TestCase):
    def test_joins_words_with_dashes(self):
        self.assertEqual(slugify("Hello World"), "hello-world")
