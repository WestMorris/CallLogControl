import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('windows_runtime', Path(__file__).resolve().parent.parent / 'windows/runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class WindowsRuntimeTest(unittest.TestCase):
    def test_reconfiguration_preserves_credentials_and_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = runtime.configure(root, '192.168.1.100')
            device = runtime.Store(root / 'data').register('Ventas')
            second = runtime.configure(root, '192.168.1.101')
            self.assertEqual(first['admin_token'], second['admin_token'])
            self.assertEqual(second['lan_ip'], '192.168.1.101')
            self.assertEqual(runtime.Store(root / 'data').device_for(device['token']), device['device_id'])
            self.assertEqual((root / 'admin-key.txt').read_text().strip(), first['admin_token'])
            before = (root / 'config.json').read_bytes()
            for bad in ['not-an-ip', '0.0.0.0', '224.0.0.1', '::1']:
                with self.assertRaises(ValueError):
                    runtime.configure(root, bad)
                self.assertEqual((root / 'config.json').read_bytes(), before)

    def test_invalid_existing_config_is_never_replaced_with_a_new_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps({'admin_token': 'bad'}))
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                runtime.configure(directory, '192.168.1.100')
            self.assertEqual(path.read_bytes(), before)
