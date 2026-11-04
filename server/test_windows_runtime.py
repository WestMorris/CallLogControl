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
            store = runtime.Store(root / 'data')
            devices = [store.register(name) for name in ['Ventas', 'Soporte', 'Dos líneas']]
            call = {'id': '1', 'number': '+595990000001', 'type': 2,
                    'started_at': 1793361600000, 'duration_seconds': 10, 'presentation': 1}
            for device in devices:
                store.ingest(device['device_id'], {'calls': [call]})
            lines = [dict(call, phone_account_id='account-1', line_label='Personal'),
                     dict(call, id='2', phone_account_id='account-2', line_label='Trabajo')]
            store.ingest(devices[2]['device_id'], {'calls': lines})
            ca = root / 'caddy/pki/authorities/local/root.crt'
            ca.parent.mkdir(parents=True)
            ca.write_bytes(b'existing CA')
            runtime.configure(root, first['lan_ip'])
            second = runtime.configure(root, '192.168.1.101')
            self.assertEqual(first['admin_token'], second['admin_token'])
            self.assertEqual(second['lan_ip'], '192.168.1.101')
            for device in devices:
                self.assertEqual(runtime.Store(root / 'data').device_for(device['token']), device['device_id'])
            with store.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM calls').fetchone()[0], 4)
                self.assertEqual([tuple(row) for row in db.execute(
                    'SELECT phone_account_id,line_label FROM calls WHERE device_id=? ORDER BY id',
                    (devices[2]['device_id'],))], [('account-1', 'Personal'), ('account-2', 'Trabajo')])
            self.assertEqual(ca.read_bytes(), b'existing CA')
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
