"""Analytics over received call records; all calendar buckets use fixed UTC-03:00."""
import calendar
import csv
from datetime import date, datetime, timedelta, timezone
import io
import json
import math
import re
import tempfile
from xml.sax.saxutils import escape
import zipfile

ZONE = timezone(timedelta(hours=-3))
MAX_CELLS = 20000
DIMENSIONS = {"day", "week", "month", "device", "line", "type"}
METRICS = {"count", "minutes", "average", "missed"}
TYPES = {1: "Entrante", 2: "Saliente", 3: "Perdida", 4: "Buzón de voz",
         5: "Rechazada", 6: "Bloqueada", 7: "Contestada en otro equipo"}
DEFAULT_IDS = {"trend", "devices", "lines", "missed"}
EMPTY_LIBRARY = {"hiddenDefaults": [], "views": []}
FIELDS = {"preset", "from", "to", "device", "line", "type", "metric", "group",
          "breakdown", "chart", "compare", "share", "selection", "offset", "limit"}


class Conflict(ValueError):
    pass


def parse_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Indica fechas válidas con formato AAAA-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ValueError("Indica una fecha de calendario válida") from None


def shift_months(day, months):
    position = day.year * 12 + day.month - 1 + months
    year, month = divmod(position, 12)
    return day.replace(year=year, month=month + 1,
                       day=min(day.day, calendar.monthrange(year, month + 1)[1]))


def line_parts(key):
    try:
        parts = json.loads(key)
    except (ValueError, TypeError):
        raise ValueError("Identidad de SIM/línea inválida") from None
    if (not isinstance(parts, list) or len(parts) != 3 or
            any(not isinstance(part, str) or len(part) > 256 for part in parts) or
            not parts[0] or not (parts[1] or parts[2])):
        raise ValueError("Identidad de SIM/línea inválida")
    return parts


def dimension_key(key, dimension):
    if not isinstance(key, str) or len(key) > (8192 if dimension == "line" else 1600):
        raise ValueError("Selección del gráfico inválida")
    if dimension in {"day", "week"}:
        day = parse_date(key)
        if dimension == "week" and day.weekday() != 0:
            raise ValueError("La semana debe comenzar un lunes")
    elif dimension == "month":
        parse_date(key + "-01")
    elif dimension == "line" and key != "unknown":
        key = json.dumps(line_parts(key), ensure_ascii=False, separators=(",", ":"))
    elif dimension == "type" and key not in {str(n) for n in TYPES}:
        raise ValueError("Tipo de llamada inválido")
    elif dimension == "device" and (not key or len(key) > 120):
        raise ValueError("Equipo inválido")
    elif dimension == "none" and key != "all":
        raise ValueError("Serie inválida")
    return key


def normalize(raw):
    if not isinstance(raw, dict) or set(raw) - FIELDS:
        raise ValueError("Campos de analítica inválidos")
    state = {"preset": "custom", "device": "", "line": "", "type": "", "metric": "count",
             "group": "month", "breakdown": "none", "chart": "bars", "compare": False,
             "share": False, "selection": None, "offset": 0, "limit": 10, **raw}
    start, end = parse_date(state.get("from")), parse_date(state.get("to"))
    if not date(1969, 12, 31) <= start <= end <= date(2100, 1, 1):
        raise ValueError("El rango debe estar entre 1969-12-31 y 2100-01-01, con Desde anterior o igual a Hasta")
    for key, allowed in {"preset": {"7d", "30d", "month", "6m", "custom"}, "metric": METRICS,
                         "group": DIMENSIONS, "breakdown": {"none", "device", "line", "type"},
                         "chart": {"bars", "stacked", "line", "area", "donut"},
                         "type": {"", *(str(n) for n in TYPES)}}.items():
        if not isinstance(state[key], str) or state[key] not in allowed:
            raise ValueError(f"{key} inválido")
    for key in ("compare", "share"):
        if type(state[key]) is not bool:
            raise ValueError(f"{key} debe ser verdadero o falso")
    if not isinstance(state["device"], str) or len(state["device"]) > 120:
        raise ValueError("Equipo inválido")
    if not isinstance(state["line"], str):
        raise ValueError("SIM/línea inválida")
    if state["line"] not in ("", "unknown"):
        state["line"] = dimension_key(state["line"], "line")
    if (type(state["offset"]) is not int or not 0 <= state["offset"] <= 2147483647 or
            type(state["limit"]) is not int or not 1 <= state["limit"] <= 200):
        raise ValueError("Paginación inválida: limit debe estar entre 1 y 200")
    if state["preset"] == "6m" and (start.day != 1 or shift_months(start, 6) - timedelta(days=1) != end):
        raise ValueError("El período de seis meses debe contener seis meses calendario completos")
    if state["breakdown"] == state["group"]:
        state["breakdown"] = "none"
    additive, temporal = state["metric"] in {"count", "minutes"}, state["group"] in {"day", "week", "month"}
    if not additive:
        state["share"] = False
    if ((state["chart"] in {"stacked", "area", "donut"} and not additive) or
            (state["chart"] in {"line", "area"} and not temporal) or
            (state["chart"] == "donut" and (temporal or state["breakdown"] != "none"))):
        state["chart"] = "bars"
    selected = state["selection"]
    if selected is not None:
        if not isinstance(selected, dict) or set(selected) != {"group", "series"}:
            raise ValueError("Selección del gráfico inválida")
        state["selection"] = {"group": dimension_key(selected["group"], state["group"]),
                              "series": None if selected["series"] is None else dimension_key(selected["series"], state["breakdown"])}
    return state


def timestamp(day):
    return int(datetime.combine(day, datetime.min.time(), ZONE).timestamp() * 1000)


def range_before(state):
    start, end = parse_date(state["from"]), parse_date(state["to"])
    if state["preset"] == "6m":
        previous = shift_months(start, -6)
        return {"from": previous.isoformat(), "to": (start - timedelta(days=1)).isoformat(),
                "kind": "months", "months": 6, "label": "6 meses previos"}
    days = (end - start).days + 1
    return {"from": (start - timedelta(days=days)).isoformat(), "to": (start - timedelta(days=1)).isoformat(),
            "kind": "days", "days": days, "label": f"{days} días previos"}


def blank():
    return {"count": 0, "seconds": 0, "missed": 0}


def metric_value(stat, metric):
    if metric == "count":
        return stat["count"]
    if metric == "minutes":
        return stat["seconds"] / 60
    if not stat["count"]:
        return None
    return stat["seconds"] / stat["count"] if metric == "average" else 100 * stat["missed"] / stat["count"]


def _filter_dimension(clauses, values, key, dimension):
    if dimension in {"day", "week", "month"}:
        start = parse_date(key + "-01" if dimension == "month" else key)
        end = shift_months(start, 1) if dimension == "month" else start + timedelta(days=7 if dimension == "week" else 1)
        clauses.extend(("c.started_at>=?", "c.started_at<?"))
        values.extend((timestamp(start), timestamp(end)))
    elif dimension == "device":
        clauses.append("c.device_id=?")
        values.append(key)
    elif dimension == "type":
        clauses.append("c.type=?")
        values.append(int(key))
    elif dimension == "line":
        if key == "unknown":
            clauses.extend(("c.phone_account_id=''", "c.phone_account_component_name=''"))
        else:
            device, component, account = line_parts(key)
            clauses.extend(("c.device_id=?", "c.phone_account_component_name=?", "c.phone_account_id=?"))
            values.extend((device, component, account))


def where(state, start=None, end=None, selection=False):
    start = parse_date(start or state["from"])
    end = parse_date(end or state["to"]) + timedelta(days=1)
    clauses, values = ["c.started_at>=?", "c.started_at<?"], [timestamp(start), timestamp(end)]
    for field, dimension in (("device", "device"), ("line", "line"), ("type", "type")):
        if state[field]:
            _filter_dimension(clauses, values, state[field], dimension)
    if selection and state["selection"]:
        _filter_dimension(clauses, values, state["selection"]["group"], state["group"])
        if state["selection"]["series"] is not None:
            _filter_dimension(clauses, values, state["selection"]["series"], state["breakdown"])
    return " WHERE " + " AND ".join(clauses), values


def date_key(day, dimension):
    if dimension == "month":
        return day.isoformat()[:7]
    if dimension == "week":
        day -= timedelta(days=day.weekday())
    return day.isoformat()


def _identity(row, dimension):
    if dimension == "device":
        return row["device_id"]
    if dimension == "line":
        if not (row["phone_account_id"] or row["phone_account_component_name"]):
            return "unknown"
        return json.dumps([row["device_id"], row["phone_account_component_name"], row["phone_account_id"]], ensure_ascii=False, separators=(",", ":"))
    if dimension == "type":
        return str(row["type"])
    return "all"


def _label(key, dimension, devices, labels):
    if dimension in {"day", "week", "month"}:
        return key
    if dimension == "device":
        return devices.get(key, key)
    if dimension == "line":
        if key == "unknown":
            return "Sin SIM identificada"
        device, component, account = line_parts(key)
        name = labels.get(key, "")
        identity = f"{name} ({account})" if name and account else name or account or component
        return devices.get(device, device) + " · " + identity
    if dimension == "type":
        return TYPES.get(int(key), key)
    return "Consolidado"


def _aggregate(db, state, start, end, previous=None):
    temporal = state["group"] in {"day", "week", "month"}
    dimensions = {state["group"], state["breakdown"]}
    columns = []
    if temporal:
        columns.append("date(c.started_at / 1000.0,'unixepoch','-3 hours') AS local_date")
    if dimensions & {"device", "line"}:
        columns.append("c.device_id")
    if "line" in dimensions:
        columns.extend(("c.phone_account_component_name", "c.phone_account_id"))
    if "type" in dimensions:
        columns.append("c.type")
    predicate, values = where(state, start, end)
    query = ("SELECT " + ",".join(columns) + ",COUNT(*) AS count,SUM(c.duration_seconds) AS seconds,"
             "SUM(CASE WHEN c.type=3 THEN 1 ELSE 0 END) AS missed FROM calls c" + predicate +
             " GROUP BY " + ",".join(str(index + 1) for index in range(len(columns))))
    cells = {}
    for row in db.execute(query, values):
        if temporal:
            day = parse_date(row["local_date"])
            if previous:
                day = shift_months(day, previous["months"]) if previous["kind"] == "months" else day + timedelta(days=previous["days"])
            group = date_key(day, state["group"])
        else:
            group = _identity(row, state["group"])
        series = _identity(row, state["breakdown"])
        stat = cells.setdefault((group, series), blank())
        for field in stat:
            stat[field] += row[field]
        if len(cells) > MAX_CELLS:
            raise ValueError("Demasiados grupos: reduce el período, filtra un equipo o quita el desglose")
    return cells


def _total(cells):
    total = blank()
    for stat in cells.values():
        for field in total:
            total[field] += stat[field]
    return total


def _records_query(state):
    predicate, values = where(state, selection=True)
    return ("SELECT c.*,d.name AS device_name FROM calls c JOIN devices d ON d.id=c.device_id" +
            predicate + " ORDER BY c.started_at DESC,c.device_id,c.id"), values


def _report(db, state):
    previous = range_before(state)
    current = _aggregate(db, state, state["from"], state["to"])
    prior = _aggregate(db, state, previous["from"], previous["to"], previous) if state["compare"] else {}
    total, old_total = _total(current), _total(prior)
    keys = set(current) | set(prior)
    group_keys, series_keys = {key[0] for key in keys}, {key[1] for key in keys}
    if state["group"] in {"day", "week", "month"}:
        day, end = parse_date(state["from"]), parse_date(state["to"])
        group_keys = set()
        while day <= end:
            group_keys.add(date_key(day, state["group"]))
            if len(group_keys) > MAX_CELLS:
                raise ValueError("Demasiados grupos: usa semanas, meses o un período menor")
            day += timedelta(days=1)
    if state["breakdown"] == "none":
        series_keys = {"all"}
    if len(group_keys) * len(series_keys) > MAX_CELLS:
        raise ValueError("Demasiados grupos y series: filtra un equipo o quita el desglose")
    devices = {row["id"]: row["name"] for row in db.execute("SELECT id,name FROM devices")}
    labels = {}
    if "line" in {state["group"], state["breakdown"]}:
        for row in db.execute("""SELECT device_id,phone_account_component_name,phone_account_id,line_label FROM (
            SELECT device_id,phone_account_component_name,phone_account_id,line_label,
              ROW_NUMBER() OVER (PARTITION BY device_id,phone_account_component_name,phone_account_id
                ORDER BY started_at DESC,id DESC) AS position FROM calls
            WHERE phone_account_id<>'' OR phone_account_component_name<>'') WHERE position=1"""):
            labels[_identity(row, "line")] = row["line_label"]
    def entries(values, dimension):
        return [{"key": key, "label": _label(key, dimension, devices, labels)} for key in sorted(values)]
    groups, series = entries(group_keys, state["group"]), entries(series_keys, state["breakdown"])
    total_value = metric_value(total, state["metric"])
    denominator = total_value if state["metric"] in {"count", "minutes"} else None
    rows = []
    for group in groups:
        for serie in series:
            key = (group["key"], serie["key"])
            stat, before = current.get(key, blank()), prior.get(key, blank())
            value = metric_value(stat, state["metric"])
            rows.append({"group": group["key"], "label": group["label"], "series": serie["key"],
                         "seriesLabel": serie["label"], "stat": stat, "before": before, "value": value,
                         "share": 100 * value / denominator if denominator and value is not None else None})
    predicate, detail_values = where(state, selection=True)
    detail_count = db.execute("SELECT COUNT(*) FROM calls c" + predicate, detail_values).fetchone()[0]
    query, values = _records_query(state)
    detail = [dict(row) for row in db.execute(query + " LIMIT ? OFFSET ?", values + [state["limit"], state["offset"]])]
    coverage = db.execute("SELECT MIN(started_at),MAX(started_at) FROM calls").fetchone()
    return {"state": state, "timezone": "UTC-03:00", "groups": groups, "series": series, "rows": rows,
            "total": total, "oldTotal": old_total, "totalValue": total_value, "denominator": denominator,
            "previous": previous, "coveredPrevious": old_total["count"] > 0,
            "detail": {"calls": detail, "total": detail_count, "has_more": state["offset"] + len(detail) < detail_count},
            "coverage": {"first": coverage[0], "last": coverage[1]},
            "as_of": int(datetime.now(timezone.utc).timestamp() * 1000)}


def report(store, raw):
    state = normalize(raw)
    with store.connect() as db:
        db.execute("BEGIN")
        return _report(db, state)


def get_views(store):
    with store.connect() as db:
        row = db.execute("SELECT revision,library FROM analytics_preferences WHERE singleton=1").fetchone()
        return {"revision": row["revision"], "library": json.loads(row["library"])}


def put_views(store, payload):
    if (not isinstance(payload, dict) or set(payload) != {"revision", "library"} or
            type(payload["revision"]) is not int or not 0 <= payload["revision"] <= 2147483647):
        raise ValueError("Se requieren revision y library válidos")
    library = payload["library"]
    if not isinstance(library, dict) or set(library) != {"hiddenDefaults", "views"}:
        raise ValueError("Biblioteca de vistas inválida")
    hidden, views = library["hiddenDefaults"], library["views"]
    if (not isinstance(hidden, list) or len(hidden) > 4 or
            any(not isinstance(key, str) or key not in DEFAULT_IDS for key in hidden) or len(set(hidden)) != len(hidden) or
            not isinstance(views, list) or len(views) > 16):
        raise ValueError("La biblioteca permite hasta 16 vistas y cuatro vistas predeterminadas ocultas")
    normalized, ids, names = [], set(), set()
    for view in views:
        if (not isinstance(view, dict) or set(view) != {"id", "name", "config"} or
                not isinstance(view["id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", view["id"]) or
                view["id"] in ids or view["id"] in DEFAULT_IDS or
                not isinstance(view["name"], str) or not 1 <= len(view["name"].strip()) <= 50 or
                view["name"].strip().casefold() in names):
            raise ValueError("Cada vista debe tener un ID único y un nombre único de 1 a 50 caracteres")
        ids.add(view["id"])
        names.add(view["name"].strip().casefold())
        config = normalize(view["config"])
        for field in ("selection", "offset", "limit"):
            config.pop(field)
        normalized.append({"id": view["id"], "name": view["name"].strip(), "config": config})
    library = {"hiddenDefaults": hidden, "views": normalized}
    with store.connect() as db:
        changed = db.execute("""UPDATE analytics_preferences SET revision=revision+1,library=?
            WHERE singleton=1 AND revision=?""", (json.dumps(library, ensure_ascii=False), payload["revision"])).rowcount
        if not changed:
            raise Conflict("Otra sesión modificó las vistas. Recarga la biblioteca antes de guardar")
    return {"revision": payload["revision"] + 1, "library": library}


def _export_rows(db, state, kind):
    if kind == "summary":
        model = _report(db, state)
        headers = ["grupo", "serie", "llamadas", "duracion_segundos", "valor", "unidad",
                   "participacion_porcentaje", "valor_periodo_anterior"]
        unit = {"count": "llamadas", "minutes": "min", "average": "s por registro", "missed": "%"}[state["metric"]]
        return headers, ([row["label"], row["seriesLabel"], row["stat"]["count"], row["stat"]["seconds"],
                          row["value"], unit, row["share"],
                          metric_value(row["before"], state["metric"]) if model["coveredPrevious"] else None]
                         for row in model["rows"])
    headers = ["equipo_id", "equipo", "llamada_id", "sim_linea", "cuenta_id", "cuenta_componente",
               "numero", "tipo", "inicio_local", "zona_horaria", "duracion_segundos", "presentacion"]
    query, values = _records_query(state)
    def records():
        for row in db.execute(query, values):
            account, label = row["phone_account_id"], row["line_label"]
            line = f"{label} ({account})" if label and account else label or account or "Sin SIM identificada"
            yield [row["device_id"], row["device_name"], row["id"], line, account,
                   row["phone_account_component_name"], row["number"], TYPES[row["type"]],
                   datetime.fromtimestamp(row["started_at"] / 1000, ZONE).strftime("%Y-%m-%d %H:%M:%S"),
                   "UTC-03:00", row["duration_seconds"], row["presentation"]]
    return headers, records()


def _xlsx(output, headers, rows, sheet):
    content_types = ('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                     '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        archive.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + sheet + '" sheetId="1" r:id="rId1"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        with archive.open("xl/worksheets/sheet1.xml", "w") as xml:
            xml.write(b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
            for index, row in enumerate(_with_header(headers, rows), 1):
                if index > 1048576:
                    raise ValueError("El reporte supera el límite de filas de Excel. Usa CSV o reduce los filtros")
                cells = []
                for item in row:
                    if isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(item):
                        cells.append(f"<c><v>{item}</v></c>")
                    else:
                        text = "" if item is None else str(item)
                        text = re.sub(r"[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]", "", text)
                        cells.append('<c t="inlineStr"><is><t xml:space="preserve">' + escape(text).replace("\r", "&#13;") + '</t></is></c>')
                xml.write((f'<row r="{index}">' + "".join(cells) + "</row>").encode("utf-8"))
            xml.write(b"</sheetData></worksheet>")


def _with_header(headers, rows):
    yield headers
    yield from rows


def export_file(store, raw, kind, format):
    if kind not in {"summary", "records"} or format not in {"csv", "xlsx"}:
        raise ValueError("Elige summary/records y csv/xlsx")
    state = normalize(raw)
    output = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    try:
        with store.connect() as db:
            db.execute("BEGIN")
            headers, rows = _export_rows(db, state, kind)
            if format == "xlsx":
                _xlsx(output, headers, rows, "Resumen" if kind == "summary" else "Llamadas")
            else:
                writer = io.TextIOWrapper(output, encoding="utf-8-sig", newline="")
                csv_writer = csv.writer(writer)
                for row in _with_header(headers, rows):
                    csv_writer.writerow("'" + str(item) if isinstance(item, str) and item.lstrip(" \t\r\n").startswith(("=", "+", "-", "@")) else "" if item is None else item for item in row)
                writer.flush()
                writer.detach()
        output.seek(0)
        return output, ("analitica-resumen" if kind == "summary" else "analitica-registros") + "." + format
    except BaseException:
        output.close()
        raise
