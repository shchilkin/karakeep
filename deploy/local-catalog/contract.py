"""Bounded service contract: no paths, arbitrary prompts or download URLs."""
import base64
import io

MODEL = 'Qwen/Qwen3.5-9B'
REVISION = 'c202236235762e1c871ad0ccb60c8ee5ba337b9a'
RECIPE = 'qwen35-nf4-catalog-v1'
# Use the shape-only grammar validated in the paired pilot. LMFE 0.11.3's
# string-length constraints can terminate Cyrillic BPE output mid-string.
# Strict lengths/counts are enforced independently below and in the TS client.
SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'required': ['title', 'tags', 'summary'],
    'properties': {
        'title': {'type': 'string'},
        'tags': {'type': 'array', 'items': {'type': 'string'}},
        'summary': {'type': 'string'},
    },
}


def validate_result(value):
    if not isinstance(value, dict) or set(value) != {'title', 'summary', 'tags'}:
        raise ValueError('invalid_result')
    for key, limit in [('title', 180), ('summary', 1600)]:
        if not isinstance(value[key], str) or not 1 <= len(value[key].strip()) <= limit:
            raise ValueError('invalid_result')
    tags = value['tags']
    if not isinstance(tags, list) or not 1 <= len(tags) <= 8 or any(
            not isinstance(t, str) or not 1 <= len(t.strip()) <= 80 for t in tags):
        raise ValueError('invalid_result')
    return value


def validate_request(value):
    if not isinstance(value, dict) or set(value) != {'images', 'source', 'media'}:
        raise ValueError('invalid_request')
    source, media, images = value['source'], value['media'], value['images']
    if not isinstance(source, dict) or set(source) != {'title', 'caption', 'author'}:
        raise ValueError('invalid_source')
    for key, limit in [('title', 500), ('caption', 2500), ('author', 160)]:
        if not isinstance(source[key], str) or len(source[key]) > limit:
            raise ValueError('source_limit')
    if not isinstance(media, dict) or set(media) != {'kind', 'coverage', 'asset_count', 'sampled_images'}:
        raise ValueError('invalid_media')
    if media['kind'] not in ['text', 'image', 'video', 'mixed', 'carousel'] or media['coverage'] not in ['archived_text', 'archived_media', 'saved_image', 'preview_only']:
        raise ValueError('invalid_media')
    if type(media['asset_count']) is not int or not 0 <= media['asset_count'] <= 10000:
        raise ValueError('invalid_count')
    if not isinstance(images, list) or len(images) > 3 or type(media['sampled_images']) is not int or media['sampled_images'] != len(images):
        raise ValueError('image_limit')
    if media['kind'] == 'text':
        if images or media['coverage'] != 'archived_text' or media['asset_count'] != 0 or not source['caption'].strip():
            raise ValueError('invalid_text')
    elif not images or media['coverage'] == 'archived_text' or media['asset_count'] < 1:
        raise ValueError('missing_images')
    if any(not isinstance(i, str) or len(i) > 2800000 for i in images):
        raise ValueError('image_limit')
    return value


def decode_images(encoded):
    from PIL import Image
    images = []
    try:
        for item in encoded:
            pixels = base64.b64decode(item, validate=True)
            if not pixels or len(pixels) > 2 * 1024 * 1024:
                raise ValueError('image_limit')
            with Image.open(io.BytesIO(pixels)) as original:
                if original.format != 'JPEG' or max(original.size) > 768:
                    raise ValueError('expected_prepared_jpeg')
                images.append(original.convert('RGB'))
        return images
    except BaseException:
        for image in images:
            image.close()
        raise
