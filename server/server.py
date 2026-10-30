"""CallLogControl: HTTPS behind a reverse proxy; Python standard library only."""
import argparse
import base64
from contextlib import contextmanager
import csv
import hashlib
import hmac
import io
import json
import os
import re
from pathlib import Path
import secrets
import ssl
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import uuid
from qrcodegen import QrCode

MAX_BODY = 256 * 1024
MAX_BATCH = 500
CALL_TYPES = {1: "Entrante", 2: "Saliente", 3: "Perdida", 4: "Buzón de voz",
              5: "Rechazada", 6: "Bloqueada", 7: "Contestada en otro equipo"}


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def csv_cell(value):
    value = str(value)
    # Excel interprets formulas even when the CSV field is quoted.
    return "'" + value if value.lstrip(" \t\r\n").startswith(("=", "+", "-", "@")) else value


class Store:
    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / "calls.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS calls (
                    device_id TEXT NOT NULL REFERENCES devices(id),
                    id TEXT NOT NULL, number TEXT NOT NULL, type INTEGER NOT NULL,
                    started_at INTEGER NOT NULL, duration_seconds INTEGER NOT NULL,
                    presentation INTEGER NOT NULL,
                    PRIMARY KEY(device_id, id)
                );
                CREATE INDEX IF NOT EXISTS calls_date ON calls(started_at);
                CREATE TABLE IF NOT EXISTS enrollments (
                    code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires_at INTEGER NOT NULL
                );
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(devices)")}
            for name, kind in [("last_seen_at", "INTEGER"), ("last_sync_at", "INTEGER"),
                               ("sync_requested_id", "TEXT"), ("sync_completed_id", "TEXT")]:
                if name not in columns:
                    db.execute(f"ALTER TABLE devices ADD COLUMN {name} {kind}")
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def register(self, name):
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("El nombre debe tener entre 1 y 120 caracteres")
        device_id, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute("INSERT INTO devices(id,name,token_hash) VALUES (?,?,?)",
                       (device_id, name.strip(), token_hash(token)))
        return {"device_id": device_id, "name": name.strip(), "token": token}

    def invite(self, name):
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("El nombre debe tener entre 1 y 120 caracteres")
        code, expires = secrets.token_urlsafe(32), int(time.time()) + 300
        with self.connect() as db:
            db.execute("DELETE FROM enrollments WHERE expires_at<=?", (int(time.time()),))
            db.execute("INSERT INTO enrollments VALUES (?,?,?)", (token_hash(code), name.strip(), expires))
        return code, expires

    def claim(self, code):
        if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", code):
            return None
        with self.connect() as db:
            # Serialize redemption: two phones must never consume the same invitation.
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT name FROM enrollments WHERE code_hash=? AND expires_at>?",
                             (token_hash(code), int(time.time()))).fetchone()
            if row is None:
                return None
            device_id, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
            db.execute("INSERT INTO devices(id,name,token_hash) VALUES (?,?,?)",
                       (device_id, row["name"], token_hash(token)))
            db.execute("DELETE FROM enrollments WHERE code_hash=?", (token_hash(code),))
        return {"device_id": device_id, "name": row["name"], "token": token}

    def device_for(self, token):
        with self.connect() as db:
            row = db.execute("SELECT id FROM devices WHERE token_hash=? AND active=1",
                             (token_hash(token),)).fetchone()
        return row["id"] if row else None

    def request_sync(self, device_id):
        request_id = str(uuid.uuid4())
        with self.connect() as db:
            changed = db.execute("UPDATE devices SET sync_requested_id=? WHERE id=? AND active=1",
                                 (request_id, device_id)).rowcount
        return request_id if changed else None

    def pending_sync(self, device_id):
        with self.connect() as db:
            db.execute("UPDATE devices SET last_seen_at=? WHERE id=?", (int(time.time() * 1000), device_id))
            row = db.execute("SELECT sync_requested_id,sync_completed_id FROM devices WHERE id=?", (device_id,)).fetchone()
        return row["sync_requested_id"] if row["sync_requested_id"] != row["sync_completed_id"] else None

    def acknowledge_sync(self, device_id, payload):
        if not isinstance(payload, dict) or set(payload) != {"request_id"}:
            raise ValueError("Se requiere request_id")
        request_id = payload["request_id"]
        if not isinstance(request_id, str) or len(request_id) != 36 or str(uuid.UUID(request_id)) != request_id:
            raise ValueError("request_id inválido")
        with self.connect() as db:
            # An older acknowledgement must not clear a newer request.
            db.execute("""UPDATE devices SET sync_completed_id=?,last_sync_at=?
                WHERE id=? AND sync_requested_id=?""",
                (request_id, int(time.time() * 1000), device_id, request_id))

    def ingest(self, device_id, payload):
        if not isinstance(payload, dict) or set(payload) != {"calls"}:
            raise ValueError("Se esperaba un objeto con la propiedad calls")
        calls = payload["calls"]
        if not isinstance(calls, list) or not 1 <= len(calls) <= MAX_BATCH:
            raise ValueError("El lote debe contener entre 1 y 500 llamadas")
        rows = []
        for call in calls:
            keys = {"id", "number", "type", "started_at", "duration_seconds", "presentation"}
            if not isinstance(call, dict) or set(call) != keys:
                raise ValueError("Campos de llamada incorrectos")
            if not isinstance(call["id"], str) or not 1 <= len(call["id"]) <= 120:
                raise ValueError("Identificador inválido")
            if not isinstance(call["number"], str) or len(call["number"]) > 256:
                raise ValueError("Número inválido")
            for field, lower, upper in [("type", 1, 7), ("started_at", 0, 4102444800000),
                                         ("duration_seconds", 0, 31536000), ("presentation", 1, 5)]:
                value = call[field]
                if type(value) is not int or not lower <= value <= upper:
                    raise ValueError(f"{field} inválido")
            rows.append((device_id, call["id"], call["number"], call["type"],
                         call["started_at"], call["duration_seconds"], call["presentation"]))
        with self.connect() as db:
            db.executemany("""
                INSERT INTO calls VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(device_id,id) DO UPDATE SET number=excluded.number,
                  type=excluded.type, started_at=excluded.started_at,
                  duration_seconds=excluded.duration_seconds, presentation=excluded.presentation
            """, rows)
            db.execute("UPDATE devices SET last_seen_at=?,last_sync_at=? WHERE id=?",
                       (int(time.time() * 1000), int(time.time() * 1000), device_id))


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store, admin_token, public_url="", ca_file=""):
        self.store = store
        self.admin_hash = token_hash(admin_token)
        self.public_url = public_url
        self.ca_file = ca_file
        self.slots = threading.BoundedSemaphore(16)
        self.poll_slots = threading.BoundedSemaphore(8)
        self.sync_condition = threading.Condition()
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "CallLogControl/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, *_):
        pass  # Credentials and telephone numbers must not enter access logs.

    def reply(self, status, data=None):
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def bearer(self):
        value = self.headers.get("Authorization", "")
        return value[7:] if value.startswith("Bearer ") and len(value) <= 512 else ""

    def is_admin(self):
        return hmac.compare_digest(token_hash(self.bearer()), self.server.admin_hash)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.reply(400, {"error": "Content-Length inválido"})
            return None
        if not 0 < length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
            self.reply(413, {"error": "Tamaño de lote inválido"})
            return None
        if self.headers.get_content_type() != "application/json":
            self.reply(415, {"error": "Se requiere application/json"})
            return None
        try:
            raw = self.rfile.read(length)
            payload = json.loads(raw)
            if len(raw) != length or not isinstance(payload, dict):
                raise ValueError("Se requiere un objeto JSON completo")
            return payload
        except (ValueError, UnicodeDecodeError) as error:
            self.reply(400, {"error": str(error)})
            return None

    def do_POST(self):
        if self.path == "/v1/enrollments":
            if not self.is_admin():
                return self.reply(401, {"error": "Se requiere credencial de administrador"})
            payload = self.read_json()
            if payload is None:
                return
            try:
                if set(payload) != {"name"}:
                    raise ValueError("Indica únicamente el nombre del equipo")
                origin = urlsplit(self.server.public_url)
                if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password
                        or origin.path not in ("", "/") or origin.query or origin.fragment):
                    raise OSError("URL HTTPS no configurada")
                pem = Path(self.server.ca_file).read_text(encoding="ascii")
                ca = base64.b64encode(ssl.PEM_cert_to_DER_cert(pem)).decode()
                if len(ca) > 2400:
                    raise OSError("Certificado demasiado grande para el QR")
                code, expires = self.server.store.invite(payload["name"])
                bundle = json.dumps({"v": 1, "url": self.server.public_url.rstrip("/"),
                                     "ca": ca, "code": code}, separators=(",", ":"))
                qr = QrCode.encode_text(bundle, QrCode.Ecc.MEDIUM)
                size = qr.get_size()
                path = " ".join(f"M{x+4},{y+4}h1v1h-1z" for y in range(size)
                                for x in range(size) if qr.get_module(x, y))
                svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size+8} {size+8}" shape-rendering="crispEdges">'
                       f'<rect width="100%" height="100%" fill="white"/><path d="{path}" fill="black"/></svg>')
                return self.reply(201, {"qr_svg": svg, "expires_at": expires * 1000,
                                        "ca_fingerprint": hashlib.sha256(base64.b64decode(ca)).hexdigest(),
                                        "server_url": self.server.public_url, "name": payload["name"].strip()})
            except ValueError as error:
                return self.reply(400, {"error": str(error)})
            except (OSError, ssl.SSLError):
                return self.reply(503, {"error": "El alta QR necesita CALLLOG_PUBLIC_URL y CALLLOG_CA_FILE con el certificado público de Caddy. Revisa la configuración del servidor."})
        if self.path == "/v1/enrollments/claim":
            payload = self.read_json()
            if payload is None:
                return
            if payload:
                return self.reply(400, {"error": "No se admiten campos adicionales"})
            device = self.server.store.claim(self.bearer())
            return self.reply(200, device) if device else self.reply(401, {"error": "QR vencido o utilizado. Genera otro en el panel."})
        sync_route = re.fullmatch(r"/v1/devices/([0-9a-f-]{36})/sync", self.path)
        if sync_route:
            if not self.is_admin():
                return self.reply(401, {"error": "Se requiere credencial de administrador"})
            request_id = self.server.store.request_sync(sync_route[1])
            if request_id:
                with self.server.sync_condition:
                    self.server.sync_condition.notify_all()
            return self.reply(202, {"request_id": request_id}) if request_id else self.reply(404, {"error": "Equipo inexistente o revocado"})
        if self.path not in ("/v1/calls", "/v1/sync-ack"):
            return self.reply(404, {"error": "Ruta inexistente"})
        device = self.server.store.device_for(self.bearer())
        if device is None:
            return self.reply(401, {"error": "Credencial inválida o equipo revocado"})
        payload = self.read_json()
        if payload is None:
            return
        try:
            if self.path == "/v1/calls":
                self.server.store.ingest(device, payload)
            else:
                self.server.store.acknowledge_sync(device, payload)
        except (ValueError, UnicodeDecodeError) as error:
            return self.reply(400, {"error": str(error)})
        except sqlite3.Error:
            return self.reply(503, {"error": "Almacenamiento temporalmente no disponible"})
        self.reply(204)

    def do_GET(self):
        url = urlsplit(self.path)
        assets = {"/": ("index.html", "text/html"), "/panel.js": ("panel.js", "text/javascript"),
                  "/panel.css": ("panel.css", "text/css")}
        if url.path in assets:
            filename, content_type = assets[url.path]
            body = (Path(__file__).parent / "web" / filename).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
            self.end_headers()
            return self.wfile.write(body)
        if url.path == "/healthz":
            return self.reply(200, {"status": "ok"})
        if url.path == "/v1/sync-request":
            device = self.server.store.device_for(self.bearer())
            if device is None:
                return self.reply(401, {"error": "Credencial de equipo inválida"})
            params = parse_qs(url.query, keep_blank_values=True)
            try:
                if set(params) - {"wait"} or any(len(v) != 1 for v in params.values()):
                    raise ValueError()
                wait = int(params.get("wait", ["0"])[0])
                if not 0 <= wait <= 25:
                    raise ValueError()
            except ValueError:
                return self.reply(400, {"error": "wait debe estar entre 0 y 25 segundos"})
            if wait and not self.server.poll_slots.acquire(blocking=False):
                return self.reply(429, {"error": "Canal remoto ocupado; vuelve a intentar"})
            try:
                deadline = time.monotonic() + wait
                with self.server.sync_condition:
                    while True:
                        request_id = self.server.store.pending_sync(device)
                        remaining = deadline - time.monotonic()
                        if request_id or remaining <= 0:
                            break
                        self.server.sync_condition.wait(remaining)
                return self.reply(200, {"request_id": request_id})
            finally:
                if wait:
                    self.server.poll_slots.release()
        if not self.is_admin():
            return self.reply(401, {"error": "Se requiere credencial de administrador"})
        if url.path == "/v1/devices":
            with self.server.store.connect() as db:
                rows = db.execute("""SELECT d.id,d.name,d.active,d.last_seen_at,d.last_sync_at,
                    d.sync_requested_id,d.sync_completed_id,COUNT(c.id) AS call_count
                    FROM devices d LEFT JOIN calls c ON c.device_id=d.id
                    GROUP BY d.id ORDER BY d.name""").fetchall()
            return self.reply(200, {"devices": [dict(row) for row in rows]})
        if url.path == "/v1/calls":
            params = parse_qs(url.query, keep_blank_values=True)
            if set(params) - {"device_id", "offset"} or any(len(v) != 1 for v in params.values()):
                return self.reply(400, {"error": "Filtros inválidos"})
            try:
                offset = int(params.get("offset", ["0"])[0])
                if not 0 <= offset <= 2_147_483_647:
                    raise ValueError()
            except ValueError:
                return self.reply(400, {"error": "offset inválido"})
            device = params.get("device_id", [None])[0]
            where = " WHERE c.device_id=?" if device is not None else ""
            values = (device,) if device is not None else ()
            with self.server.store.connect() as db:
                total = db.execute("SELECT COUNT(*) FROM calls c" + where, values).fetchone()[0]
                rows = db.execute("""SELECT c.*,d.name AS device_name FROM calls c
                    JOIN devices d ON d.id=c.device_id""" + where +
                    " ORDER BY c.started_at DESC,c.device_id,c.id LIMIT 50 OFFSET ?", values + (offset,)).fetchall()
            return self.reply(200, {"calls": [dict(row) for row in rows], "total": total,
                                    "has_more": offset + len(rows) < total})
        if url.path != "/v1/export.csv":
            return self.reply(404, {"error": "Ruta inexistente"})
        params = parse_qs(url.query, keep_blank_values=True)
        if set(params) - {"device_id"} or any(len(v) != 1 for v in params.values()):
            return self.reply(400, {"error": "Usa únicamente device_id, una vez"})
        device = params.get("device_id", [None])[0]
        with self.server.store.connect() as db:
            if device is not None and not db.execute("SELECT 1 FROM devices WHERE id=?", (device,)).fetchone():
                return self.reply(404, {"error": "Equipo inexistente"})
            rows = db.execute("""SELECT d.id,d.name,c.id,c.number,c.type,c.started_at,
                c.duration_seconds,c.presentation FROM calls c JOIN devices d ON d.id=c.device_id"""
                + (" WHERE d.id=?" if device is not None else "")
                + " ORDER BY c.started_at DESC,d.id,c.id", (device,) if device is not None else ())
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="llamadas.csv"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(b"\xef\xbb\xbf")
            buffer = io.StringIO(newline="")
            writer = csv.writer(buffer)
            writer.writerow(["equipo_id", "equipo", "llamada_id", "numero", "tipo",
                             "inicio_unix_ms", "duracion_segundos", "presentacion"])
            self.wfile.write(buffer.getvalue().encode())
            for row in rows:
                buffer.seek(0)
                buffer.truncate()
                values = list(row)
                values[4] = CALL_TYPES[values[4]]
                writer.writerow([csv_cell(v) for v in values])
                self.wfile.write(buffer.getvalue().encode())


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default=os.getenv("CALLLOG_DATA_DIR", "data"))
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8080)
    register = commands.add_parser("register-device")
    register.add_argument("--name", required=True)
    revoke = commands.add_parser("revoke-device")
    revoke.add_argument("device_id")
    args = parser.parse_args()
    store = Store(args.data_dir)
    if args.command == "register-device":
        print(json.dumps(store.register(args.name), ensure_ascii=False, indent=2))
    elif args.command == "revoke-device":
        with store.connect() as db:
            changed = db.execute("UPDATE devices SET active=0 WHERE id=?", (args.device_id,)).rowcount
        if changed != 1:
            parser.error("Equipo inexistente")
        print("Credencial revocada; registros conservados.")
    else:
        token = os.getenv("CALLLOG_ADMIN_TOKEN", "")
        if len(token) < 32:
            parser.error("Define CALLLOG_ADMIN_TOKEN con al menos 32 caracteres aleatorios")
        server = Server((args.host, args.port), store, token,
                        os.getenv("CALLLOG_PUBLIC_URL", ""), os.getenv("CALLLOG_CA_FILE", ""))
        print(f"CallLogControl en {args.host}:{args.port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
