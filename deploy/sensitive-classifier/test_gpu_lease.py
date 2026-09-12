import os
import subprocess
import sys
import tempfile
import unittest

from gpu_lease import acquire


class LeaseTests(unittest.TestCase):
    def test_process_exclusion_and_release(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, 'gpu.lock')
            lease = acquire(path)
            script = 'from gpu_lease import acquire; import sys; acquire(sys.argv[1], seconds=0.1).close()'
            env = {**os.environ, 'PYTHONPATH': os.path.dirname(__file__)}
            blocked = subprocess.run([sys.executable, '-c', script, path], env=env, capture_output=True)
            self.assertNotEqual(blocked.returncode, 0)
            lease.close()
            allowed = subprocess.run([sys.executable, '-c', script, path], env=env, capture_output=True)
            self.assertEqual(allowed.returncode, 0)


if __name__ == '__main__':
    unittest.main()
