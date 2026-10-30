import csv
import io
import json
from concurrent.futures import ThreadPoolExecutor
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import MAX_BODY, Server, Store


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = Store(self.directory.name)
        self.a = self.store.register("Equipo A")
        self.b = self.store.register("=Equipo B")
        self.admin = "admin-" + "x" * 32
        self.server = Server(("127.0.0.1", 0), self.store, self.admin)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.call = {"id": "1-1000", "number": "+595991123456", "type": 2,
                     "started_at": 1000, "duration_seconds": 61, "presentation": 1}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, path, token="", payload=None, headers=None):
        request = Request(self.base + path, data=json.dumps(payload).encode() if payload is not None else None,
                          headers={"Authorization": "Bearer " + token,
                                   "Content-Type": "application/json", **(headers or {})})
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, response.read()
        except HTTPError as error:
            with error:
                return error.code, error.read()

    def send(self, device, calls):
        return self.request("/v1/calls", device["token"], {"calls": calls})

    def test_retry_is_idempotent_and_updates_duration(self):
        for _ in range(2):
            self.assertEqual(self.send(self.a, [self.call])[0], 204)
        self.call["duration_seconds"] = 90
        self.assertEqual(self.send(self.a, [self.call])[0], 204)
        with self.store.connect() as db:
            rows = db.execute("SELECT * FROM calls").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["duration_seconds"], 90)

    def test_credentials_and_device_isolation(self):
        self.assertEqual(self.request("/v1/calls", "wrong", {"calls": [self.call]})[0], 401)
        self.assertEqual(self.request("/v1/export.csv", self.a["token"])[0], 401)
        self.assertEqual(self.request("/v1/calls", self.admin, {"calls": [self.call]})[0], 401)
        self.send(self.a, [self.call])
        self.send(self.b, [self.call])
        status, body = self.request("/v1/devices", self.admin)
        self.assertEqual(status, 200)
        self.assertEqual([d["call_count"] for d in json.loads(body)["devices"]], [1, 1])
        with self.store.connect() as db:
            db.execute("UPDATE devices SET active=0 WHERE id=?", (self.a["device_id"],))
        self.assertEqual(self.send(self.a, [self.call])[0], 401)

    def test_invalid_batch_is_atomic_and_strict(self):
        for field, value in [("duration_seconds", -1), ("type", True), ("presentation", 99),
                             ("number", "1" * 257), ("started_at", 4.2)]:
            invalid = {**self.call, "id": "other", field: value}
            self.assertEqual(self.send(self.a, [self.call, invalid])[0], 400)
        self.assertEqual(self.send(self.a, [dict(self.call, device_id=self.b["device_id"])])[0], 400)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM calls").fetchone()[0], 0)

    def test_exports_all_or_one_device_and_neutralizes_formulas(self):
        self.send(self.a, [self.call])
        self.send(self.b, [dict(self.call, number=" \t=1+1")])
        status, body = self.request("/v1/export.csv", self.admin)
        self.assertEqual(status, 200)
        rows = list(csv.reader(io.StringIO(body.decode("utf-8-sig"))))
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row[3].startswith("'") for row in rows[1:]))
        self.assertIn("'=Equipo B", [row[1] for row in rows[1:]])
        status, body = self.request("/v1/export.csv?device_id=" + self.a["device_id"], self.admin)
        rows = list(csv.reader(io.StringIO(body.decode("utf-8-sig"))))
        self.assertEqual(status, 200)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][0], self.a["device_id"])
        self.assertEqual(self.request("/v1/export.csv?device_id=unknown", self.admin)[0], 404)
        self.assertEqual(self.request("/v1/export.csv?device_id=a&device_id=b", self.admin)[0], 400)

    def test_limits_and_health(self):
        self.assertEqual(self.send(self.a, [])[0], 400)
        self.assertEqual(self.send(self.a, [self.call] * 501)[0], 400)
        self.assertEqual(self.request("/v1/calls", self.a["token"], {},
                                     {"Content-Length": str(MAX_BODY + 1)})[0], 413)
        self.assertEqual(self.request("/healthz")[0], 200)

    def test_panel_is_public_shell_but_data_and_commands_require_admin(self):
        status, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"CallLog Control", body)
        self.assertNotIn(self.admin.encode(), body)
        self.assertEqual(self.request("/panel.js")[0], 200)
        self.assertEqual(self.request("/panel.css")[0], 200)
        self.assertEqual(self.request("/v1/calls", self.a["token"])[0], 401)
        route = "/v1/devices/" + self.a["device_id"] + "/sync"
        self.assertEqual(self.request(route, self.a["token"], {})[0], 401)
        self.assertEqual(self.request("/v1/sync-request", self.admin)[0], 401)

    def test_remote_request_is_isolated_and_old_ack_does_not_clear_new_request(self):
        route = "/v1/devices/" + self.a["device_id"] + "/sync"
        status, body = self.request(route, self.admin, {})
        self.assertEqual(status, 202)
        first = json.loads(body)["request_id"]
        self.assertEqual(json.loads(self.request("/v1/sync-request", self.a["token"])[1])["request_id"], first)
        self.assertIsNone(json.loads(self.request("/v1/sync-request", self.b["token"])[1])["request_id"])
        self.assertEqual(self.request("/v1/sync-ack", self.b["token"], {"request_id": first})[0], 204)
        second = json.loads(self.request(route, self.admin, {})[1])["request_id"]
        self.assertNotEqual(first, second)
        self.assertEqual(self.request("/v1/sync-ack", self.a["token"], {"request_id": first})[0], 204)
        self.assertEqual(json.loads(self.request("/v1/sync-request", self.a["token"])[1])["request_id"], second)
        for _ in range(2):
            self.assertEqual(self.request("/v1/sync-ack", self.a["token"], {"request_id": second})[0], 204)
        self.assertIsNone(json.loads(self.request("/v1/sync-request", self.a["token"])[1])["request_id"])
        self.assertEqual(self.request("/v1/sync-ack", self.a["token"], {"request_id": "invalid"})[0], 400)

    def test_long_poll_wakes_when_admin_requests_sync(self):
        with ThreadPoolExecutor(max_workers=1) as pool:
            started = time.monotonic()
            future = pool.submit(self.request, "/v1/sync-request?wait=5", self.a["token"])
            deadline = started + 2
            while time.monotonic() < deadline:
                with self.store.connect() as db:
                    seen = db.execute("SELECT last_seen_at FROM devices WHERE id=?", (self.a["device_id"],)).fetchone()[0]
                if seen:
                    break
                time.sleep(.02)
            route = "/v1/devices/" + self.a["device_id"] + "/sync"
            request = json.loads(self.request(route, self.admin, {})[1])["request_id"]
            status, body = future.result(timeout=2)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["request_id"], request)
            self.assertLess(time.monotonic() - started, 3)
        for query in ["wait=26", "wait=-1", "wait=x", "wait=1&wait=2"]:
            self.assertEqual(self.request("/v1/sync-request?" + query, self.a["token"])[0], 400)

    def test_calls_are_paginated_and_filtered(self):
        self.send(self.a, [dict(self.call, id=str(i), started_at=i) for i in range(55)])
        self.send(self.b, [dict(self.call, id="b", number="<script>alert(1)</script>")])
        base = "/v1/calls?device_id=" + self.a["device_id"]
        page = json.loads(self.request(base, self.admin)[1])
        self.assertEqual(page["total"], 55)
        self.assertEqual(len(page["calls"]), 50)
        self.assertTrue(page["has_more"])
        self.assertTrue(all(row["device_id"] == self.a["device_id"] for row in page["calls"]))
        last = json.loads(self.request(base + "&offset=50", self.admin)[1])
        self.assertEqual(len(last["calls"]), 5)
        self.assertFalse(last["has_more"])
        self.assertFalse({r["id"] for r in page["calls"]} & {r["id"] for r in last["calls"]})
        for query in ["offset=-1", "offset=99999999999999", "offset=x", "unknown=1", "offset=1&offset=2"]:
            self.assertEqual(self.request("/v1/calls?" + query, self.admin)[0], 400)

    def test_revoked_device_cannot_receive_or_complete_commands(self):
        with self.store.connect() as db:
            db.execute("UPDATE devices SET active=0 WHERE id=?", (self.a["device_id"],))
        self.assertEqual(self.request("/v1/devices/" + self.a["device_id"] + "/sync", self.admin, {})[0], 404)
        self.assertEqual(self.request("/v1/sync-request", self.a["token"])[0], 401)

    def test_existing_database_migrates_without_losing_devices_or_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            db = sqlite3.connect(Path(directory) / "calls.sqlite3")
            db.executescript("""
                CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1);
                INSERT INTO devices VALUES ('existing','Equipo existente','hash',1);
                CREATE TABLE calls(device_id TEXT NOT NULL,id TEXT NOT NULL,number TEXT NOT NULL,type INTEGER NOT NULL,
                    started_at INTEGER NOT NULL,duration_seconds INTEGER NOT NULL,presentation INTEGER NOT NULL,PRIMARY KEY(device_id,id));
                INSERT INTO calls VALUES ('existing','1','123',2,1000,30,1);
            """)
            db.close()
            migrated = Store(directory)
            Store(directory)
            with migrated.connect() as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM calls").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT name FROM devices").fetchone()[0], "Equipo existente")
                self.assertIsNone(db.execute("SELECT sync_requested_id FROM devices").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
