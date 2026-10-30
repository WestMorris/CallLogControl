"""Run on a clean Windows CI machine after installing the real .exe."""
import argparse
import csv
import io
import json
import os
from pathlib import Path
import ssl
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument('--install-dir', required=True)
parser.add_argument('--check-existing', action='store_true')
args = parser.parse_args()
sys.path.insert(0, str(Path(args.install_dir) / 'server'))
from server import Store
root = Path(os.environ['PROGRAMDATA']) / 'CallLogControl'
config = json.loads((root / 'config.json').read_text())
context = ssl.create_default_context(cafile=str(root / 'caddy/pki/authorities/local/root.crt'))
base = f'https://{config["lan_ip"]}:8443'


def request(path, token='', data=None):
    req = Request(base + path, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                  data=json.dumps(data).encode() if data is not None else None)
    try:
        with urlopen(req, timeout=5, context=context) as response:
            return response.status, response.read()
    except HTTPError as error:
        with error:
            return error.code, error.read()


assert request('/healthz')[0] == 200
assert request('/')[0] == 200
admin = config['admin_token']
if not args.check_existing:
    status, body = request('/v1/enrollments', admin, {'name': 'Ventas QR'})
    assert status == 201, status
    assert json.loads(body)['qr_svg'].startswith('<svg')
    devices = []
    for name in ['Ventas de prueba', 'Soporte de prueba']:
        code, _ = Store(root / 'data').invite(name)
        status, body = request('/v1/enrollments/claim', code, {})
        assert status == 200
        device = json.loads(body)
        devices.append(device)
        assert request('/v1/enrollments/claim', code, {})[0] == 401
        call = {'id': 'windows-smoke-1', 'number': '+595990000001', 'type': 2,
                'started_at': 1793361600000, 'duration_seconds': 10, 'presentation': 1}
        for _ in range(2):
            assert request('/v1/calls', device['token'], {'calls': [call]})[0] == 204
        assert request('/v1/export.csv', device['token'])[0] == 401
    (root / 'smoke-state.json').write_text(json.dumps(devices))
else:
    devices = json.loads((root / 'smoke-state.json').read_text())
for suffix, expected in [('', 2), ('?device_id=' + devices[0]['device_id'], 1)]:
    status, body = request('/v1/export.csv' + suffix, admin)
    assert status == 200
    rows = list(csv.DictReader(io.StringIO(body.decode('utf-8-sig'))))
    assert len(rows) == expected
    if expected == 1:
        assert rows[0]['equipo'] == devices[0]['name']
d = devices[0]
status, body = request('/v1/devices/' + d['device_id'] + '/sync', admin, {})
assert status == 202
request_id = json.loads(body)['request_id']
assert json.loads(request('/v1/sync-request', d['token'])[1])['request_id'] == request_id
assert request('/v1/sync-ack', d['token'], {'request_id': request_id})[0] == 204
print('PASS Windows services: validated TLS, panel, QR enrollment, device isolation, idempotency, both CSVs, remote commands and preserved state')
