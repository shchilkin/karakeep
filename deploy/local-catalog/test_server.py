import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import weakref

sys.path.append(str(Path(__file__).resolve().parents[1] / 'sensitive-classifier'))
from server import Handler


class HandlerTests(unittest.TestCase):
    def test_unload_precedes_lease_release_even_after_exception_and_disconnect(self):
        refs, actions = {}, []
        class Tensor: pass
        class Model:
            def catalog(self, _):
                tensor = Tensor(); refs['tensor'] = weakref.ref(tensor)
                raise RuntimeError('private response')
            def unload(self):
                self_test.assertIsNone(refs['tensor']())
                actions.append('unload')
        self_test = self
        handler = Handler.__new__(Handler)
        payload = json.dumps({'images':[], 'source':{'title':'','caption':'Synthetic','author':''},
                              'media':{'kind':'text','coverage':'archived_text','asset_count':0,'sampled_images':0}}).encode()
        handler.path = '/catalog'
        handler.headers = {'Authorization':'Bearer synthetic', 'Content-Length':str(len(payload))}
        handler.rfile = io.BytesIO(payload)
        handler.server = SimpleNamespace(token='synthetic',model=Model())
        def send(status, result):
            self.assertEqual(status, 503); self.assertEqual(result, {'error':'local_unavailable'})
            self.assertEqual(actions, ['unload','release'])
            raise BrokenPipeError()
        handler.send_json = send
        lease = SimpleNamespace(close=lambda: actions.append('release'))
        with patch('server.configured_lease', return_value=lease), patch('server.signal.alarm'):
            with self.assertRaises(BrokenPipeError): handler.do_POST()


if __name__ == '__main__':
    unittest.main()
