import unittest
from policy import parse_result


class PolicyTests(unittest.TestCase):
    def test_categories_are_independent_of_preview_verdict(self):
        result = parse_result('User Safety: safe\nSafety Categories: revealing_clothing')
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['categories'], ['revealing_clothing'])

    def test_contradictory_heavy_categories_stay_unknown(self):
        self.assertEqual(parse_result('User Safety: safe\nSafety Categories: gore')['status'], 'unknown')

    def test_refusal_or_truncation_is_unknown(self):
        self.assertEqual(parse_result('No analysis available')['status'], 'unknown')
        self.assertEqual(parse_result('User Safety: safe', truncated=True)['status'], 'unknown')

    def test_does_not_accept_arbitrary_labels_or_duplicate_fields(self):
        for text in ['User Safety: unsafe\nSafety Categories: invented',
                     'User Safety: safe\nUser Safety: unsafe',
                     'User Safety: unsafe\nSafety Categories: gore\nSafety Categories: nudity']:
            self.assertEqual(parse_result(text)['status'], 'unknown')

    def test_multiple_known_categories(self):
        self.assertEqual(parse_result('User Safety: unsafe\nSafety Categories: violence, gore')['categories'], ['gore', 'violence'])


if __name__ == '__main__':
    unittest.main()
