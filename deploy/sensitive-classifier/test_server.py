import io
import json
import sys
import unittest
import weakref
from types import SimpleNamespace
from unittest.mock import patch

from server import Classifier, Handler


class FailureCleanupTests(unittest.TestCase):
    def check_failure(self, disconnected):
        references = {}
        flushed = []

        class Tensor:
            pass

        class Model:
            def forward(self):
                tensor = Tensor()
                references['input'] = weakref.ref(tensor)
                raise RuntimeError('synthetic_cuda_failure')

        class FailingClassifier(Classifier):
            def classify(self, _):
                self.model = Model()
                references['model'] = weakref.ref(self.model)
                return self.model.forward()

        def empty_cache():
            self.assertTrue(all(ref() is None for ref in references.values()))
            flushed.append(True)

        classifier = FailingClassifier()
        payload = json.dumps({'image': 'synthetic'}).encode()
        handler = Handler.__new__(Handler)
        handler.server = SimpleNamespace(token='synthetic-token', classifier=classifier)
        handler.path = '/classify'
        handler.headers = {'Authorization': 'Bearer synthetic-token', 'Content-Length': str(len(payload))}
        handler.rfile = io.BytesIO(payload)

        def send_json(status, result):
            self.assertEqual(status, 503)
            self.assertEqual(result, {'error': 'local_unavailable'})
            self.assertEqual(flushed, [True])
            if disconnected:
                raise BrokenPipeError('synthetic_disconnected_client')

        handler.send_json = send_json
        cuda = SimpleNamespace(is_available=lambda: True, empty_cache=empty_cache)
        with patch.dict(sys.modules, {'torch': SimpleNamespace(cuda=cuda)}):
            if disconnected:
                with self.assertRaises(BrokenPipeError):
                    handler.do_POST()
            else:
                handler.do_POST()
        self.assertIsNone(classifier.model)
        self.assertEqual(flushed, [True])
        self.assertTrue(handler.close_connection)

    def test_failed_inference_releases_traceback_tensors_before_cache_flush(self):
        self.check_failure(False)

    def test_disconnected_client_does_not_skip_gpu_cleanup(self):
        self.check_failure(True)


if __name__ == '__main__':
    unittest.main()
