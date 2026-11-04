"""Exercise production analytics through the authenticated HTTP handler and SQLite."""
import csv
from datetime import datetime
import io
import json
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
import zipfile

import test_server as server_test
from server import Store


def millis(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


class AnalyticsTest(unittest.TestCase):
    tearDown = server_test.ServerTest.tearDown
    send = server_test.ServerTest.send

    def setUp(self):
        server_test.ServerTest.setUp(self)
        self.state = {"from": "2026-05-04", "to": "2026-05-04", "group": "device"}
        self.component = "phone/Primary"
        for device, records in [(self.a, [(1, 60), (2, 180), (3, 0), (5, 0)]),
                                (self.b, [(1, 120), (2, 300)])]:
            calls = []
            for index, (kind, duration) in enumerate(records):
                call = dict(self.call, id=str(index), type=kind, duration_seconds=duration,
                            started_at=millis(f"2026-05-04T{10+index:02d}:00:00-03:00"))
                if index < 3:
                    call.update(phone_account_id="same-account", phone_account_component_name=self.component,
                                line_label="Trabajo")
                if device is self.b and index == 1:
                    call["phone_account_component_name"] = "phone/Other"
                calls.append(call)
            self.assertEqual(self.send(device, calls)[0], 204)

    def request(self, path, token="", payload=None, headers=None, method=None):
        req = Request(self.base + path, data=json.dumps(payload).encode() if payload is not None else None,
                      headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", **(headers or {})},
                      method=method)
        try:
            with urlopen(req, timeout=5) as result:
                return result.status, result.read()
        except HTTPError as error:
            with error:
                return error.code, error.read()

    def route(self, state=None, kind=None, format="csv"):
        params = {"state": json.dumps(self.state if state is None else state, separators=(",", ":"))}
        if kind:
            params.update(kind=kind, format=format)
        return "/v1/analytics" + ("/export" if kind else "") + "?" + urlencode(params)

    def report(self, **changes):
        status, body = self.request(self.route(dict(self.state, **changes)), self.admin)
        self.assertEqual(status, 200, body)
        return json.loads(body)

    def table_snapshot(self):
        with self.store.connect() as db:
            return {name: [tuple(row) for row in db.execute(f"SELECT * FROM {name} ORDER BY 1,2")]
                    for name in ["devices", "calls"]}

    def test_admin_only_read_only_queries_and_exports(self):
        before = self.table_snapshot()
        for route in [self.route(), self.route(kind="records"), "/v1/analytics/views"]:
            for token in ["", "wrong", self.a["token"]]:
                self.assertEqual(self.request(route, token)[0], 401)
            self.assertEqual(self.request(route, self.admin)[0], 200)
        self.assertEqual(self.table_snapshot(), before)
        self.assertEqual(self.store.device_for(self.a["token"]), self.a["device_id"])

    def test_totals_weighted_averages_and_ratios(self):
        data = self.report(metric="average", share=True, chart="stacked")
        self.assertEqual(data["total"], {"count": 6, "seconds": 660, "missed": 1})
        self.assertEqual(data["totalValue"], 110)
        values = {row["group"]: row["value"] for row in data["rows"]}
        self.assertEqual(values, {self.a["device_id"]: 60, self.b["device_id"]: 210})
        self.assertNotEqual(data["totalValue"], sum(values.values()) / len(values))
        self.assertFalse(data["state"]["share"])
        self.assertEqual(data["state"]["chart"], "bars")
        self.assertAlmostEqual(self.report(metric="missed")["totalValue"], 100 / 6)
        minutes = self.report(metric="minutes")
        self.assertEqual(minutes["totalValue"], 11)
        self.assertAlmostEqual(sum(row["share"] for row in minutes["rows"]), 100)
        empty = self.report(metric="average", device="nonexistent")
        self.assertEqual(empty["total"]["count"], 0)
        self.assertIsNone(empty["totalValue"])

    def test_exact_account_identity_unknown_and_type_filter(self):
        def identity(device, component):
            return json.dumps([device["device_id"], component, "same-account"], separators=(",", ":"))
        self.assertEqual(self.report(line=identity(self.a, self.component))["total"]["count"], 3)
        self.assertEqual(self.report(line=identity(self.b, self.component))["total"]["seconds"], 120)
        self.assertEqual(self.report(line=identity(self.b, "phone/Other"))["total"]["seconds"], 300)
        unknown = self.report(line="unknown")
        self.assertEqual(unknown["total"]["count"], 1)
        self.assertEqual(unknown["detail"]["calls"][0]["type"], 5)
        self.assertEqual(self.report(type="3")["total"]["missed"], 1)
        lines = self.report(group="line")
        self.assertEqual(len(lines["groups"]), 4)

    def test_fixed_minus_three_day_and_monday_week_boundaries(self):
        edge_calls = [dict(self.call, id="before", started_at=millis("2026-05-04T02:59:59.999+00:00")),
                      dict(self.call, id="start", started_at=millis("2026-05-04T03:00:00+00:00")),
                      dict(self.call, id="end", started_at=millis("2026-05-05T02:59:59.999+00:00")),
                      dict(self.call, id="after", started_at=millis("2026-05-05T03:00:00+00:00"))]
        self.assertEqual(self.send(self.a, edge_calls)[0], 204)
        data = self.report(group="day", limit=200)
        ids = {row["id"] for row in data["detail"]["calls"]}
        self.assertTrue({"start", "end"} <= ids)
        self.assertTrue({"before", "after"}.isdisjoint(ids))
        self.assertEqual(data["timezone"], "UTC-03:00")
        weekly = self.report(group="week", **{"from": "2026-05-03", "to": "2026-05-04"})
        self.assertEqual([row["key"] for row in weekly["groups"]], ["2026-04-27", "2026-05-04"])
        self.assertEqual(sum(row["stat"]["count"] for row in weekly["rows"] if row["group"] == "2026-04-27"), 1)
        self.assertEqual(self.send(self.a, [dict(self.call, id="epoch", started_at=0)])[0], 204)
        epoch = self.report(group="day", **{"from": "1969-12-31", "to": "1969-12-31"})
        self.assertEqual(epoch["total"]["count"], 1)
        self.assertEqual(epoch["groups"][0]["key"], "1969-12-31")
        self.assertEqual(epoch["coverage"]["first"], 0)

    def test_previous_period_and_six_complete_calendar_months(self):
        prior = dict(self.call, id="prior", duration_seconds=360, started_at=millis("2026-05-03T10:00:00-03:00"))
        self.assertEqual(self.send(self.a, [prior])[0], 204)
        data = self.report(compare=True, group="day")
        self.assertEqual(data["oldTotal"], {"count": 1, "seconds": 360, "missed": 0})
        self.assertEqual((data["previous"]["from"], data["previous"]["to"]), ("2026-05-03", "2026-05-03"))
        self.assertEqual(data["rows"][0]["before"]["seconds"], 360)
        self.assertTrue(data["coveredPrevious"])
        prior["id"] = "calendar-prior"
        prior["started_at"] = millis("2026-04-30T10:00:00-03:00")
        self.assertEqual(self.send(self.a, [prior])[0], 204)
        data = self.report(preset="6m", group="month", compare=True, **{"from": "2026-05-01", "to": "2026-10-31"})
        self.assertEqual((data["previous"]["from"], data["previous"]["to"]), ("2025-11-01", "2026-04-30"))
        self.assertEqual(len(data["groups"]), 6)
        self.assertEqual(data["oldTotal"]["count"], 1)

    def test_detail_selection_pagination_and_all_page_exports(self):
        selected = {"group": self.a["device_id"], "series": "all"}
        state = dict(self.state, selection=selected, offset=1, limit=1)
        data = self.report(selection=selected, offset=1, limit=1)
        self.assertEqual(data["total"]["count"], 6)
        self.assertEqual(data["detail"]["total"], 4)
        self.assertEqual(len(data["detail"]["calls"]), 1)
        self.assertTrue(data["detail"]["has_more"])
        for format in ["csv", "xlsx"]:
            for kind, expected in [("summary", 2), ("records", 4)]:
                status, body = self.request(self.route(state, kind, format), self.admin)
                self.assertEqual(status, 200)
                if format == "csv":
                    rows = list(csv.reader(io.StringIO(body.decode("utf-8-sig"))))
                    self.assertEqual(len(rows), expected + 1)
                    if kind == "summary":
                        self.assertIn("'=Equipo B", [row[0] for row in rows[1:]])
                    if kind == "records":
                        self.assertEqual({row[2] for row in rows[1:]}, {"0", "1", "2", "3"})
                        self.assertTrue(all(row[6].startswith("'+") for row in rows[1:]))
                        self.assertTrue(all(row[9] == "UTC-03:00" for row in rows[1:]))
                else:
                    with zipfile.ZipFile(io.BytesIO(body)) as archive:
                        tree = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
                    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
                    rows = tree.findall("s:sheetData/s:row", ns)
                    self.assertEqual(len(rows), expected + 1)
                    self.assertEqual(tree.findall(".//s:f", ns), [])
                    if kind == "records":
                        cells = rows[1].findall("s:c", ns)
                        self.assertEqual(cells[6].get("t"), "inlineStr")
                        self.assertTrue(cells[6].find("s:is/s:t", ns).text.startswith("+"))
                        self.assertIsNone(cells[10].get("t"))

    def test_saved_views_revision_validation_restart_and_data_preservation(self):
        before = self.table_snapshot()
        payload = {"revision": 0, "library": {"hiddenDefaults": ["trend"], "views": [
            {"id": "custom-sales", "name": "Ventas", "config": dict(self.state, selection={"group": self.a["device_id"], "series": "all"}, offset=20, limit=25)}]}}
        route = "/v1/analytics/views"
        for token in ["", "wrong", self.a["token"]]:
            self.assertEqual(self.request(route, token, payload, method="PUT")[0], 401)
        status, body = self.request(route, self.admin, payload, method="PUT")
        self.assertEqual(status, 200, body)
        saved = json.loads(body)
        self.assertEqual(saved["revision"], 1)
        self.assertFalse({"selection", "offset", "limit"} & saved["library"]["views"][0]["config"].keys())
        self.assertEqual(self.request(route, self.admin, payload, method="PUT")[0], 409)
        self.server.store = Store(self.directory.name)
        self.assertEqual(json.loads(self.request(route, self.admin)[1]), saved)
        self.assertEqual(self.table_snapshot(), before)
        for device in [self.a, self.b]:
            self.assertEqual(self.server.store.device_for(device["token"]), device["device_id"])
        duplicate = {"revision": 1, "library": {"hiddenDefaults": [], "views": [
            {"id": "one", "name": "Ventas", "config": self.state}, {"id": "two", "name": " ventas ", "config": self.state}]}}
        self.assertEqual(self.request(route, self.admin, duplicate, method="PUT")[0], 400)
        for invalid in [dict(payload, revision=True), dict(payload, revision=2**63), {"revision": 1, "library": {"hiddenDefaults": ["not-a-default"], "views": []}},
                        {"revision": 1, "library": {"hiddenDefaults": [], "views": [{"id": str(i), "name": str(i), "config": self.state} for i in range(17)]}}]:
            self.assertEqual(self.request(route, self.admin, invalid, method="PUT")[0], 400)
        self.assertEqual(json.loads(self.request(route, self.admin)[1]), saved)
        empty = {"revision": 1, "library": {"hiddenDefaults": ["trend", "devices", "lines", "missed"], "views": []}}
        self.assertEqual(self.request(route, self.admin, empty, method="PUT")[0], 200)
        self.server.store = Store(self.directory.name)
        self.assertEqual(json.loads(self.request(route, self.admin)[1])["library"], empty["library"])

    def test_invalid_report_inputs_fail_without_mutating_records(self):
        before = self.table_snapshot()
        for change in [{"from": "2026-02-30"}, {"to": "2026-05-03"}, {"group": "sql"}, {"metric": "other"},
                       {"compare": 1}, {"limit": 201}, {"offset": -1}, {"device": []}, {"line": "[1,2,3]"},
                       {"type": "8"}, {"selection": {"group": "x"}}, {"extra": "not allowed"},
                       {"preset": "6m", "from": "2026-05-02", "to": "2026-10-31"}]:
            with self.subTest(change=change):
                self.assertEqual(self.request(self.route(dict(self.state, **change)), self.admin)[0], 400)
        for route in ["/v1/analytics", "/v1/analytics?state={bad}", "/v1/analytics?state={}&state={}",
                      self.route() + "&unexpected=1", self.route(kind="records", format="exe")]:
            self.assertEqual(self.request(route, self.admin)[0], 400)
        self.assertEqual(self.table_snapshot(), before)
