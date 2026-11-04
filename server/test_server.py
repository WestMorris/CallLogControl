import csv
from datetime import datetime
import io
import json
from concurrent.futures import ThreadPoolExecutor
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import MAX_BODY, Server, Store, token_hash


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

    def test_line_metadata_is_per_call_and_old_retries_preserve_it(self):
        first = dict(self.call, phone_account_id="account-1",
                     phone_account_component_name="telephony/ConnectionService", line_label="Personal")
        second = dict(first, id="2-1000", phone_account_id="account-2", line_label="Trabajo")
        self.assertEqual(self.send(self.a, [first, second])[0], 204)
        self.assertEqual(self.send(self.a, [dict(self.call, duration_seconds=90)])[0], 204)
        data = json.loads(self.request("/v1/calls", self.admin)[1])
        calls = {call["id"]: call for call in data["calls"]}
        self.assertEqual(data["total"], 2)
        self.assertEqual(calls[first["id"]]["duration_seconds"], 90)
        self.assertEqual(calls[first["id"]]["phone_account_id"], "account-1")
        self.assertEqual(calls[first["id"]]["phone_account_component_name"], "telephony/ConnectionService")
        self.assertEqual(calls[first["id"]]["line_label"], "Personal")
        self.assertEqual(calls[second["id"]]["phone_account_id"], "account-2")
        self.assertEqual(calls[second["id"]]["line_label"], "Trabajo")
        self.assertEqual(self.send(self.a, [dict(self.call, line_label="")])[0], 204)
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM calls WHERE id=?", (first["id"],)).fetchone()
        self.assertEqual(row["line_label"], "")
        self.assertEqual(row["phone_account_id"], "account-1")
        self.assertEqual(row["phone_account_component_name"], "telephony/ConnectionService")

    def test_optional_line_fields_are_validated_and_default_to_empty(self):
        fields = ("phone_account_id", "phone_account_component_name", "line_label")
        for field in fields:
            for value in [None, True, 1, [], "a" * 257]:
                with self.subTest(field=field, value=value):
                    invalid = dict(self.call, id="invalid", **{field: value})
                    self.assertEqual(self.send(self.a, [self.call, invalid])[0], 400)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM calls").fetchone()[0], 0)
        maximum = dict(self.call, id="maximum", **{field: "a" * 256 for field in fields})
        self.assertEqual(self.send(self.a, [self.call, maximum])[0], 204)
        calls = {call["id"]: call for call in json.loads(self.request("/v1/calls", self.admin)[1])["calls"]}
        for field in fields:
            self.assertEqual(calls[self.call["id"]][field], "")
            self.assertEqual(calls["maximum"][field], "a" * 256)

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
        self.assertEqual(rows[0][8:10], ["inicio", "zona_horaria_inicio"])
        for row in rows[1:]:
            self.assertRegex(row[8], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
            self.assertRegex(row[9], r"^UTC[+-]\d{2}:\d{2}$")
            started = datetime.fromisoformat(row[8] + row[9][3:])
            self.assertEqual(int(started.timestamp() * 1000), int(row[5]))
        status, body = self.request("/v1/export.csv?device_id=" + self.a["device_id"], self.admin)
        rows = list(csv.reader(io.StringIO(body.decode("utf-8-sig"))))
        self.assertEqual(status, 200)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][0], self.a["device_id"])
        self.assertEqual(self.request("/v1/export.csv?device_id=unknown", self.admin)[0], 404)
        self.assertEqual(self.request("/v1/export.csv?device_id=a&device_id=b", self.admin)[0], 400)

    def test_csv_appends_line_identity_and_neutralizes_its_formulas(self):
        calls = [dict(self.call, id="both", phone_account_id="account-1", line_label="Trabajo"),
                 dict(self.call, id="id", phone_account_id="account-2"),
                 dict(self.call, id="label", line_label="Personal"),
                 dict(self.call, id="legacy"),
                 dict(self.call, id="formula", phone_account_id="+1+1", line_label=" \t=1+1",
                      phone_account_component_name="@SUM(1)")]
        self.assertEqual(self.send(self.a, calls)[0], 204)
        status, body = self.request("/v1/export.csv", self.admin)
        self.assertEqual(status, 200)
        reader = csv.DictReader(io.StringIO(body.decode("utf-8-sig")))
        rows = {row["llamada_id"]: row for row in reader}
        self.assertEqual(reader.fieldnames, ["equipo_id", "equipo", "llamada_id", "numero", "tipo",
                         "inicio_unix_ms", "duracion_segundos", "presentacion", "inicio", "zona_horaria_inicio",
                         "sim_o_linea", "cuenta_telefonica_id", "cuenta_telefonica_componente"])
        self.assertEqual(rows["both"]["sim_o_linea"], "Trabajo (account-1)")
        self.assertEqual(rows["both"]["cuenta_telefonica_id"], "account-1")
        self.assertEqual(rows["id"]["sim_o_linea"], "account-2")
        self.assertEqual(rows["label"]["sim_o_linea"], "Personal")
        self.assertEqual(rows["legacy"]["sim_o_linea"], "No disponible")
        self.assertEqual(rows["legacy"]["cuenta_telefonica_id"], "")
        self.assertEqual(rows["formula"]["sim_o_linea"], "' \t=1+1 (+1+1)")
        self.assertEqual(rows["formula"]["cuenta_telefonica_id"], "'+1+1")
        self.assertEqual(rows["formula"]["cuenta_telefonica_componente"], "'@SUM(1)")

    def test_limits_and_health(self):
        self.assertEqual(self.send(self.a, [])[0], 400)
        self.assertEqual(self.send(self.a, [self.call] * 501)[0], 400)
        self.assertEqual(self.request("/v1/calls", self.a["token"], {},
                                     {"Content-Length": str(MAX_BODY + 1)})[0], 413)
        self.assertEqual(self.request("/healthz")[0], 200)

    def test_csv_dates_cover_timestamp_limits_and_keep_milliseconds(self):
        timestamps = [0, 1793750400123, 4102444800000]
        self.send(self.a, [dict(self.call, id=str(stamp), started_at=stamp) for stamp in timestamps])
        status, body = self.request("/v1/export.csv", self.admin)
        self.assertEqual(status, 200)
        rows = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"))))
        self.assertEqual({int(row["inicio_unix_ms"]) for row in rows}, set(timestamps))
        for row in rows:
            started = datetime.fromisoformat(row["inicio"] + row["zona_horaria_inicio"][3:])
            self.assertEqual(int(started.timestamp()) * 1000, int(row["inicio_unix_ms"]) // 1000 * 1000)

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

    def test_page_size_and_offset_return_every_call_once(self):
        self.assertEqual(self.send(self.a, [dict(self.call, id=str(i), started_at=i) for i in range(130)])[0], 204)
        for limit in [25, 100]:
            received = []
            for offset in range(0, 130, limit):
                status, body = self.request(f"/v1/calls?limit={limit}&offset={offset}", self.admin)
                self.assertEqual(status, 200)
                page = json.loads(body)
                self.assertEqual(page["total"], 130)
                self.assertEqual(len(page["calls"]), min(limit, 130 - offset))
                self.assertEqual(page["has_more"], offset + limit < 130)
                received.extend(call["id"] for call in page["calls"])
            self.assertEqual(received, [str(i) for i in reversed(range(130))])
        for query in ["limit=", "limit=0", "limit=-1", "limit=201", "limit=x", "limit=1.5", "limit=25&limit=50"]:
            self.assertEqual(self.request("/v1/calls?" + query, self.admin)[0], 400)
        for limit in [1, 200]:
            self.assertEqual(self.request(f"/v1/calls?limit={limit}", self.admin)[0], 200)
        rows = list(csv.DictReader(io.StringIO(self.request("/v1/export.csv", self.admin)[1].decode("utf-8-sig"))))
        self.assertEqual(len(rows), 130)

    def test_date_range_is_shared_by_pagination_and_csv(self):
        start, end = 1793750400000, 1793836800000
        calls = [dict(self.call, id=str(i), started_at=start + i) for i in range(55)]
        calls += [dict(self.call, id="previous", started_at=start - 1),
                  dict(self.call, id="last", started_at=end - 1),
                  dict(self.call, id="next", started_at=end)]
        self.send(self.a, calls)
        self.send(self.b, [dict(self.call, id="b", started_at=start)])
        query = f"?started_from={start}&started_before={end}&device_id={self.a['device_id']}"
        page = json.loads(self.request("/v1/calls" + query, self.admin)[1])
        last = json.loads(self.request("/v1/calls" + query + "&offset=50", self.admin)[1])
        self.assertEqual(page["total"], 56)
        self.assertEqual(len(page["calls"]), 50)
        self.assertTrue(page["has_more"])
        self.assertFalse(last["has_more"])
        expected = {str(i) for i in range(55)} | {"last"}
        self.assertEqual({c["id"] for c in page["calls"] + last["calls"]}, expected)
        status, body = self.request("/v1/export.csv" + query, self.admin)
        self.assertEqual(status, 200)
        exported = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"))))
        self.assertEqual({c["llamada_id"] for c in exported}, expected)
        for route in ["/v1/calls", "/v1/export.csv"]:
            for suffix, count in [(f"?started_from={end}", 1),
                                  (f"?started_before={start}", 1),
                                  (f"?started_from={end + 1}", 0)]:
                with self.subTest(route=route, suffix=suffix):
                    status, body = self.request(route + suffix, self.admin)
                    self.assertEqual(status, 200)
                    result = (json.loads(body)["calls"] if route.endswith("calls") else
                              list(csv.DictReader(io.StringIO(body.decode("utf-8-sig")))))
                    self.assertEqual(len(result), count)

    def test_invalid_date_filters_are_rejected_for_list_and_csv(self):
        queries = ["started_from=", "started_before=tomorrow", "started_from=1.5",
                   "started_from=1e3", "started_before=4102531200001",
                   "started_from=-86400001", "started_from=1&started_from=2",
                   "started_before=1&started_before=2", "started_from=2&started_before=1",
                   "started_from=1&started_before=1", "unknown=1"]
        for route in ["/v1/calls", "/v1/export.csv"]:
            for query in queries:
                with self.subTest(route=route, query=query):
                    self.assertEqual(self.request(route + "?" + query, self.admin)[0], 400)
            for query in ["started_from=-86400000", "started_before=4102531200000"]:
                self.assertEqual(self.request(route + "?" + query, self.admin)[0], 200)

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
            db.execute("UPDATE devices SET token_hash=?", (token_hash("existing-token"),))
            db.commit()
            db.close()
            migrated = Store(directory)
            Store(directory)
            self.assertEqual(migrated.device_for("existing-token"), "existing")
            with migrated.connect() as db:
                calls = [dict(row) for row in db.execute("SELECT * FROM calls")]
                self.assertEqual(calls, [{"device_id": "existing", "id": "1", "number": "123", "type": 2,
                                 "started_at": 1000, "duration_seconds": 30, "presentation": 1,
                                 "phone_account_id": "", "phone_account_component_name": "", "line_label": ""}])
                self.assertEqual(db.execute("SELECT name FROM devices").fetchone()[0], "Equipo existente")
                self.assertIsNone(db.execute("SELECT sync_requested_id FROM devices").fetchone()[0])
            updated = dict(self.call, id="1", phone_account_id="account-1", line_label="Trabajo")
            migrated.ingest("existing", {"calls": [updated]})
            reopened = Store(directory)
            self.assertEqual(reopened.device_for("existing-token"), "existing")
            with reopened.connect() as db:
                self.assertEqual(db.execute("SELECT phone_account_id,line_label FROM calls").fetchone()[:],
                                 ("account-1", "Trabajo"))

    def test_qr_enrollment_requires_admin_and_configured_tls(self):
        route = "/v1/enrollments"
        self.assertEqual(self.request(route, self.a["token"], {"name": "Nuevo"})[0], 401)
        self.assertEqual(self.request(route, self.admin, {"name": "Nuevo"})[0], 503)
        self.server.public_url = "https://192.168.1.100:8443"
        self.server.ca_file = str(Path(__file__).parent / "fixtures/enrollment-ca.crt")
        self.assertEqual(self.request(route, self.admin, {"name": ""})[0], 400)
        self.assertEqual(self.request(route, self.admin, {"name": "Nuevo", "token": "bad"})[0], 400)
        status, body = self.request(route, self.admin, {"name": "Ventas QR"})
        data = json.loads(body)
        self.assertEqual(status, 201)
        self.assertTrue(data["qr_svg"].startswith('<svg xmlns='))
        self.assertNotIn("script", data["qr_svg"])
        self.assertGreater(data["expires_at"], time.time() * 1000)
        self.assertEqual(data["server_url"], self.server.public_url)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM devices").fetchone()[0], 2)

    def test_enrollment_is_single_use_expires_and_issues_only_a_device_token(self):
        code, expires = self.store.invite("Ventas QR")
        route = "/v1/enrollments/claim"
        self.assertEqual(self.request(route, code, {"extra": 1})[0], 400)
        self.assertEqual(self.request(route, "invalid", {})[0], 401)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.request(route, code, {}), range(2)))
        self.assertEqual(sorted(status for status, _ in results), [200, 401])
        data = json.loads(next(body for status, body in results if status == 200))
        self.assertEqual(data["name"], "Ventas QR")
        self.assertEqual(self.send(data, [self.call])[0], 204)
        self.assertEqual(self.request("/v1/devices", data["token"])[0], 401)
        self.assertEqual(self.request(route, code, {})[0], 401)
        expired, deadline = self.store.invite("Expirado")
        with patch("server.time.time", return_value=deadline):
            self.assertIsNone(self.store.claim(expired))
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM devices").fetchone()[0], 3)
            self.assertNotIn(code, str([tuple(r) for r in db.execute("SELECT * FROM enrollments")]))


if __name__ == "__main__":
    unittest.main()
