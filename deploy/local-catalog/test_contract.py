import copy
import unittest
from contract import validate_request, validate_result
from model import parse_result

PAYLOAD = {'images':['synthetic'], 'source':{'title':'Title','caption':'','author':''},
           'media':{'kind':'image','coverage':'archived_media','asset_count':1,'sampled_images':1}}


class ContractTests(unittest.TestCase):
    def test_bounded_media_and_no_arbitrary_urls_paths_prompts(self):
        self.assertEqual(validate_request(PAYLOAD), PAYLOAD)
        for key in ['url','prompt','path','model']:
            with self.assertRaises(ValueError): validate_request({**PAYLOAD,key:'arbitrary'})
        for key,value in [('images', ['x']*4), ('source', {'title':'private'}), ('media', {})]:
            with self.assertRaises(ValueError): validate_request({**PAYLOAD,key:value})

    def test_only_explicit_text_input_can_have_no_images(self):
        value = copy.deepcopy(PAYLOAD); value['images'] = []; value['media']['sampled_images'] = 0
        with self.assertRaises(ValueError): validate_request(value)
        value['media'].update(kind='text',coverage='archived_text',asset_count=0)
        value['source']['caption'] = 'Synthetic source'
        self.assertEqual(validate_request(value), value)

    def test_incomplete_json_is_rejected_instead_of_repaired(self):
        with self.assertRaises(ValueError): parse_result('{"title":"К')

    def test_strict_output_shape_and_lengths(self):
        good = {'title':'Title','summary':'Summary','tags':['tag']}
        self.assertEqual(validate_result(good), good)
        for changed in [{'title':' '*10}, {'summary':'x'*1601}, {'tags':['x']*9}, {'tags':[]}, {'raw':'private'}]:
            with self.assertRaises(ValueError): validate_result({**good,**changed})


if __name__ == '__main__':
    unittest.main()
