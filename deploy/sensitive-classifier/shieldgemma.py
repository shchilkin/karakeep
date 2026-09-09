"""Pinned native policies. Scores are observations, not fine-grained labels."""
import math

MODEL = 'google/shieldgemma-2-4b-it'
REVISION = 'eaf60452b5fc41a911338a022e628b0c15283897'
POLICY_VERSION = 'shieldgemma-native-v1'
POLICIES = ('dangerous', 'sexual', 'violence')
POLICIES_SHA256 = '40ee40f62236b98ea51f392bb694f27e70dc2bf630692196ffcb3de4803e9ac7'
THRESHOLD = 0.5


def response(scores):
    valid = (isinstance(scores, dict) and set(scores) == set(POLICIES)
             and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                     and math.isfinite(v) and 0 <= v <= 1 for v in scores.values()))
    return dict(model=MODEL, revision=REVISION, policy=POLICY_VERSION,
                precision='bf16', status='complete' if valid else 'unknown',
                categories=[p for p in POLICIES if scores[p] >= THRESHOLD] if valid else [],
                scores={p: scores[p] for p in POLICIES} if valid else None)


def repair_output_head(model, loading_info):
    # The 4.57.6 wrapper fails to tie lm_head to the checkpoint's embeddings.
    # Accept that single repair only; never infer with other missing weights.
    if set(loading_info.get('missing_keys', [])) - {'model.lm_head.weight'}:
        raise RuntimeError('missing_checkpoint_weights')
    if any(loading_info.get(k) for k in ['unexpected_keys', 'mismatched_keys', 'error_msgs']):
        raise RuntimeError('incompatible_checkpoint')
    backbone = model.model
    if not backbone.config.text_config.tie_word_embeddings:
        raise RuntimeError('checkpoint_does_not_tie_embeddings')
    embedding = backbone.get_input_embeddings().weight
    if embedding.is_meta or backbone.lm_head.weight.shape != embedding.shape:
        raise RuntimeError('invalid_embedding_weights')
    backbone.lm_head.weight = embedding
    if backbone.lm_head.weight is not embedding:
        raise RuntimeError('output_head_not_tied')
