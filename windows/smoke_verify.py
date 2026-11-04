"""Run on a clean Windows CI machine after installing the real .exe."""
import argparse
import csv
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import ssl
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--install-dir', required=True)
parser.add_argument('--check-existing', action='store_true')
parser.add_argument('--legacy', action='store_true')
args = parser.parse_args()
sys.path.insert(0, str(Path(args.install_dir) / 'server'))
from server import Store
root = Path(os.environ['PROGRAMDATA']) / 'CallLogControl'
config = json.loads((root / 'config.json').read_text())
context = ssl.create_default_context(cafile=str(root / 'caddy/pki/authorities/local/root.crt'))
base = f'https://{config["lan_ip"]}:8443'


def request(path, token='', data=None, method=None):
    req = Request(base + path, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                  data=json.dumps(data).encode() if data is not None else None, method=method)
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
for device in devices:
    assert Store(root / 'data').device_for(device['token']) == device['device_id']
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
if not args.legacy:
    assert request('/analytics.js')[0] == 200
    assert request('/analytics.css')[0] == 200
    day = datetime.fromtimestamp(1793361600000 / 1000, timezone(timedelta(hours=-3))).date().isoformat()
    state = {'from': day, 'to': day, 'group': 'device', 'selection': {'group': d['device_id'], 'series': 'all'}, 'limit': 1}
    query = urlencode({'state': json.dumps(state)})
    assert request('/v1/analytics?' + query, d['token'])[0] == 401
    status, body = request('/v1/analytics?' + query, admin)
    assert status == 200, body
    report = json.loads(body)
    assert report['total'] == {'count': 2, 'seconds': 20, 'missed': 0}, report['total']
    assert report['detail']['total'] == 1
    for kind, expected in [('summary', 2), ('records', 1)]:
        for format in ['csv', 'xlsx']:
            status, body = request('/v1/analytics/export?' + query + '&' + urlencode({'kind': kind, 'format': format}), admin)
            assert status == 200
            if format == 'csv':
                assert len(list(csv.reader(io.StringIO(body.decode('utf-8-sig'))))) == expected + 1
            else:
                with zipfile.ZipFile(io.BytesIO(body)) as archive:
                    sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
                ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
                assert len(sheet.findall('s:sheetData/s:row', ns)) == expected + 1
                assert not sheet.findall('.//s:f', ns)
    views_path = root / 'smoke-analytics-state.json'
    status, body = request('/v1/analytics/views', admin)
    assert status == 200
    current = json.loads(body)
    if views_path.exists():
        assert current == json.loads(views_path.read_text()), 'Saved views or revision changed after update'
    else:
        saved_view = {'id': 'smoke-view', 'name': 'Vista conservada de prueba', 'config': {'from': day, 'to': day, 'group': 'device'}}
        payload = {'revision': current['revision'], 'library': {'hiddenDefaults': ['trend'], 'views': [saved_view]}}
        status, body = request('/v1/analytics/views', admin, payload, method='PUT')
        assert status == 200, body
        views_path.write_text(body.decode())
print('PASS Windows services: TLS, panel, QR, tokens, calls, CSV, remote commands and' +
      (' legacy state preserved' if args.legacy else ' analytics CSV/XLSX and shared views preserved'))
