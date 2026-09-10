import unittest
from types import SimpleNamespace as NS
from shieldgemma import response, repair_output_head


class NativePolicyTests(unittest.TestCase):
    def test_multi_policy_observations_keep_their_native_meanings(self):
        result = response({'dangerous': 0.9, 'sexual': 0.8, 'violence': 0.1})
        self.assertEqual(result['categories'], ['dangerous', 'sexual'])
        self.assertNotIn('nudity', result['categories'])
        self.assertEqual(result['status'], 'complete')

    def test_threshold_is_inclusive(self):
        self.assertEqual(response({'dangerous': 0.49, 'sexual': 0.5, 'violence': 0.0})['categories'], ['sexual'])

    def test_partial_or_invalid_scores_never_become_clean(self):
        for scores in [None, {}, {'sexual': 1}, {'dangerous': True, 'sexual': 0, 'violence': 0},
                       {'dangerous': float('nan'), 'sexual': 0, 'violence': 0},
                       {'dangerous': -0.1, 'sexual': 0, 'violence': 0},
                       {'dangerous': 0, 'sexual': 0, 'violence': 0, 'rawOutput': 'private'}]:
            result = response(scores)
            self.assertEqual(result['status'], 'unknown')
            self.assertIsNone(result['scores'])
            self.assertEqual(result['categories'], [])
            self.assertNotIn('rawOutput', result)

    def test_checkpoint_repair_requires_the_trained_embeddings(self):
        embedding = NS(shape=(10, 4), is_meta=False)
        backbone = NS(config=NS(text_config=NS(tie_word_embeddings=True)),
                      get_input_embeddings=lambda: NS(weight=embedding), lm_head=NS(weight=NS(shape=(10, 4))))
        model = NS(model=backbone)
        repair_output_head(model, {'missing_keys': ['model.lm_head.weight']})
        self.assertIs(backbone.lm_head.weight, embedding)
        for info in [{'missing_keys': ['model.language_model.model.embed_tokens.weight']},
                     {'mismatched_keys': ['layer.weight']}, {'unexpected_keys': ['other.weight']}]:
            with self.assertRaises(RuntimeError): repair_output_head(model, info)
        backbone.config.text_config.tie_word_embeddings = False
        with self.assertRaises(RuntimeError): repair_output_head(model, {})


if __name__ == '__main__':
    unittest.main()
