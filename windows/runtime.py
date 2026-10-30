"""Runtime for the bundled Windows services; configuration stays in ProgramData."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import secrets
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'server'))
from server import Server, Store


def configure(directory, lan_ip):
    ip = ipaddress.IPv4Address(lan_ip)
    if ip.is_unspecified or ip.is_multicast:
        raise ValueError('Se requiere la IPv4 de una interfaz del servidor')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'config.json'
    config = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'admin_token': secrets.token_urlsafe(48)}
    if not isinstance(config.get('admin_token'), str) or len(config['admin_token']) < 32:
        raise ValueError('Configuración existente inválida; no se sobrescribió la credencial')
    config['lan_ip'] = str(ip)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(config, indent=2), encoding='utf-8')
    temporary.replace(path)
    (directory / 'admin-key.txt').write_text(config['admin_token'] + '\n', encoding='utf-8')
    Store(directory / 'data')
    return config


def serve(directory):
    directory = Path(directory)
    config = json.loads((directory / 'config.json').read_text(encoding='utf-8'))
    ip = ipaddress.IPv4Address(config['lan_ip'])
    server = Server(('127.0.0.1', 8088), Store(directory / 'data'), config['admin_token'],
                    f'https://{ip}:8443', str(directory / 'caddy/pki/authorities/local/root.crt'))
    try:
        print('CallLogControl API en 127.0.0.1:8088', flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['configure', 'serve'])
    parser.add_argument('--data-dir', default=str(Path(os.environ.get('PROGRAMDATA', '.')) / 'CallLogControl'))
    parser.add_argument('--lan-ip')
    args = parser.parse_args()
    if args.command == 'configure':
        configure(args.data_dir, args.lan_ip)
    else:
        serve(args.data_dir)


if __name__ == '__main__':
    main()
