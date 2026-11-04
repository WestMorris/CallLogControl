"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const obsolete = new Error("Solicitud de una sesión anterior descartada");
  const views = {summary:"summary-view", devices:"devices-view", detail:"device-detail-view", calls:"calls-view", help:"help-view"};
  const headings = {summary:"summary-title", devices:"devices-title", detail:"detail-name", calls:"calls-title", help:"help-title"};
  const titles = {summary:"Resumen", devices:"Equipos", detail:"Equipos / Detalle", calls:"Llamadas", help:"Ayuda y soporte"};
  const types = {1:"Entrante",2:"Saliente",3:"Perdida",4:"Buzón de voz",5:"Rechazada",6:"Bloqueada",7:"Contestada en otro equipo"};
  const date = value => value ? new Date(value).toLocaleString("es", {dateStyle:"short", timeStyle:"short"}) : "Sin dato";
  const lineName = line => line.line_label && line.phone_account_id ? `${line.line_label} (${line.phone_account_id})` : line.line_label || line.phone_account_id || "No disponible";
  const lineValue = line => JSON.stringify([line.device_id, line.phone_account_component_name, line.phone_account_id]);
  const pending = device => device.sync_requested_id !== device.sync_completed_id;
  const status = device => !device.active ? "Revocado" : pending(device) ? "Pendiente" : device.sync_completed_id ? "Completada" : "Sin solicitudes";
  let key = "", session = 0, timer = null, refreshJob = null;
  let view = "summary", detailId = "", currentDetail = null, knownLines = [];
  let deviceFilter = "", lineFilter = "", dateFilters = new URLSearchParams(), offset = 0, pageSize = 50;
  let qrUrl = null, qrExpiry = null, qrSerial = 0;

  function message(text = "", error = false) { $("message").textContent = text; $("message").classList.toggle("error", error); }
  function link(label, href) { const node = document.createElement("a"); node.textContent = label; node.href = href; node.className = "text-link"; return node; }
  function cell(row, value) { const td = document.createElement("td"); td.textContent = value; row.append(td); return td; }
  function emptyRow(target, text, columns) { const row = document.createElement("tr"); cell(row, text).colSpan = columns; $(target).append(row); }
  function resetDetail(loading = false) {
    currentDetail = null;
    $("detail-name").textContent = loading ? "Detalle del equipo" : "";
    for (const id of ["detail-id", "detail-contact", "detail-sync", "detail-call-count", "detail-status", "detail-request"]) $(id).textContent = "";
    $("detail-lines").replaceChildren();
    for (const id of ["detail-history", "detail-export", "detail-sync-request"]) $(id).disabled = true;
  }
  function logout(resetRoute = true) {
    session++; key = ""; refreshJob = null;
    clearInterval(timer); timer = null; closeEnrollment();
    $("workspace").hidden = true; $("login").hidden = false; $("login-header").hidden = false;
    for (const id of ["devices", "calls", "recent-calls", "attention-list"]) $(id).replaceChildren();
    for (const id of ["device-count", "call-count", "request-count", "revoked-count"]) $(id).textContent = "0";
    $("recent-contact-count").textContent = "0 de 0";
    $("result-summary").textContent = ""; $("page-info").textContent = "";
    $("previous").disabled = true; $("next").disabled = true;
    $("device-filter").replaceChildren(new Option("Todos los equipos", ""));
    $("line-filter").replaceChildren(new Option("Todas las líneas", ""));
    knownLines = []; deviceFilter = ""; lineFilter = ""; dateFilters = new URLSearchParams();
    offset = 0; pageSize = 50; $("page-size").value = "50";
    $("date-from").value = ""; $("date-until").value = ""; $("admin-key").value = "";
    $("enrollment-section").hidden = true; $("enrollment-name").value = "";
    $("enrollment-title").textContent = ""; $("enrollment-info").textContent = "";
    resetDetail(); message(); document.title = "CallLog Control · Administración";
    if (resetRoute) window.history.replaceState(null, "", "#resumen");
  }
  async function api(path, options = {}, run = session) {
    const token = key;
    if (!token || run !== session) throw obsolete;
    const response = await fetch(path, {...options, cache:"no-store", headers:{...options.headers, Authorization:`Bearer ${token}`}});
    if (run !== session || token !== key) throw obsolete;
    if (response.status === 401) {
      logout(); message("Credencial de administrador incorrecta o sesión sin acceso.", true); throw obsolete;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (run !== session) throw obsolete;
      throw Error(data.error || `El servidor respondió ${response.status}. Intenta de nuevo.`);
    }
    return response;
  }
  async function json(path, run) {
    const data = await (await api(path, {}, run)).json();
    if (run !== session) throw obsolete;
    return data;
  }
  function button(label, action) {
    const node = document.createElement("button"); node.textContent = label;
    node.addEventListener("click", async () => {
      const run = session; node.disabled = true;
      try { await action(); } catch (error) { if (error !== obsolete && run === session) message(error.message, true); }
      finally { node.disabled = false; }
    });
    return node;
  }
  function showRoute(focus = true, update = true) {
    const hash = window.location.hash || "#resumen", oldDetail = detailId;
    detailId = "";
    const match = /^#equipos\/([^/?#]+)$/.exec(hash);
    if (match) { try { detailId = decodeURIComponent(match[1]); } catch (_) { detailId = ""; } }
    view = detailId ? "detail" : ({"#equipos":"devices", "#llamadas":"calls", "#ayuda":"help"}[hash] || "summary");
    for (const [name, id] of Object.entries(views)) $(id).hidden = name !== view;
    for (const [name, id] of [["summary","nav-summary"], ["devices","nav-devices"], ["calls","nav-calls"], ["help","nav-help"]]) {
      if (name === (view === "detail" ? "devices" : view)) $(id).setAttribute("aria-current", "page");
      else $(id).removeAttribute("aria-current");
    }
    $("breadcrumb").textContent = `Plataforma / ${titles[view]}`;
    document.title = key ? `CallLog Control · ${titles[view]}` : "CallLog Control · Administración";
    if (view === "detail" && oldDetail !== detailId) resetDetail(true);
    if (view !== "devices") closeEnrollment();
    message();
    if (key && focus) $(headings[view]).focus();
    if (key && update) return safeRefresh();
  }
  function goTo(hash) { if (window.location.hash === hash) return showRoute(); window.location.hash = hash; }
  function callQuery(device, withFilters = true) {
    const query = new URLSearchParams(withFilters ? dateFilters : undefined);
    if (device) query.set("device_id", device);
    if (withFilters && lineFilter) {
      const [selectedDevice, component, account] = JSON.parse(lineFilter);
      query.set("device_id", selectedDevice); query.set("phone_account_component_name", component); query.set("phone_account_id", account);
    }
    return query;
  }
  function applyDates() {
    const from = $("date-from").value, until = $("date-until").value;
    if (from && until && from > until) throw Error("Desde debe ser anterior o igual a Hasta. Corrige las fechas y vuelve a aplicar.");
    const query = new URLSearchParams();
    for (const [name, value] of [["started_from", from], ["started_before", until]]) {
      if (!value) continue;
      const boundary = new Date(`${value}T00:00:00`);
      if (name === "started_before") boundary.setDate(boundary.getDate() + 1);
      if (!Number.isFinite(boundary.getTime())) throw Error("Fecha inválida. Elige una fecha del calendario y vuelve a aplicar.");
      query.set(name, String(boundary.getTime()));
    }
    dateFilters = query; offset = 0;
  }
  async function download(device = "", withFilters = false) {
    const run = session, query = callQuery(device, withFilters);
    const response = await api(`/v1/export.csv${query.size ? `?${query}` : ""}`, {}, run);
    const blob = await response.blob();
    if (run !== session) throw obsolete;
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = device ? `llamadas-${device}.csv` : "llamadas-todos.csv";
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function syncDevice(device) {
    const run = session;
    await api(`/v1/devices/${encodeURIComponent(device.id)}/sync`, {method:"POST"}, run);
    message(`Solicitud enviada a ${device.name}. Se ejecutará cuando la app contacte al servidor.`);
    await refresh();
  }
  function renderLineOptions() {
    const candidates = knownLines.filter(line => !deviceFilter || line.device_id === deviceFilter);
    if (lineFilter && !candidates.some(line => lineValue(line) === lineFilter)) { lineFilter = ""; offset = 0; }
    $("line-filter").replaceChildren(new Option("Todas las líneas", ""));
    for (const line of candidates) {
      const option = new Option(deviceFilter ? lineName(line) : `${lineName(line)} · ${line.device_name}`, lineValue(line));
      option.title = line.phone_account_component_name; $("line-filter").add(option);
    }
    $("line-filter").value = lineFilter;
  }
  function renderDevices(data) {
    const devices = data.devices, active = devices.filter(device => device.active), now = Date.now();
    knownLines = data.lines || [];
    $("device-count").textContent = devices.length;
    $("call-count").textContent = devices.reduce((sum, device) => sum + device.call_count, 0);
    $("request-count").textContent = active.filter(pending).length;
    $("recent-contact-count").textContent = `${active.filter(device => device.last_seen_at && now - device.last_seen_at <= 30 * 60 * 1000).length} de ${active.length}`;
    $("revoked-count").textContent = devices.length - active.length;
    $("attention-list").replaceChildren();
    for (const device of active.filter(device => !device.last_seen_at || now - device.last_seen_at > 30 * 60 * 1000)) {
      const notice = document.createElement("div"); notice.className = "notice";
      const text = document.createElement("div"), name = document.createElement("strong"), info = document.createElement("p");
      name.textContent = device.name;
      info.textContent = (device.last_seen_at ? `Último contacto: ${date(device.last_seen_at)}.` : "Todavía no ha contactado al servidor.") + (pending(device) ? " Tiene una sincronización pendiente." : "");
      text.append(name, info); notice.append(text, link("Revisar equipo", `#equipos/${encodeURIComponent(device.id)}`)); $("attention-list").append(notice);
    }
    if (!$("attention-list").children.length) {
      const text = document.createElement("p"); text.className = "empty-note"; text.textContent = "Ningún equipo activo supera el umbral de atención."; $("attention-list").append(text);
    }
    $("devices").replaceChildren(); $("device-filter").replaceChildren(new Option("Todos los equipos", ""));
    for (const device of devices) {
      $("device-filter").add(new Option(device.name, device.id));
      const row = document.createElement("tr"), name = cell(row, ""), id = document.createElement("small");
      const nameLink = link(device.name, `#equipos/${encodeURIComponent(device.id)}`); nameLink.className = "device-link";
      id.textContent = device.id; name.append(nameLink, id);
      cell(row, device.call_count); cell(row, date(device.last_seen_at)); cell(row, date(device.last_sync_at));
      const badge = document.createElement("span"); badge.className = "badge" + (!device.active ? " inactive" : pending(device) ? " pending" : ""); badge.textContent = status(device); cell(row, "").append(badge);
      const actions = cell(row, ""); actions.className = "actions";
      const sync = button("Solicitar sincronización", () => syncDevice(device)); sync.disabled = !device.active || pending(device);
      actions.append(link("Ver detalle", `#equipos/${encodeURIComponent(device.id)}`), sync, button("CSV", () => download(device.id))); $("devices").append(row);
    }
    if (!devices.length) emptyRow("devices", "Todavía no hay equipos registrados.", 6);
    $("device-filter").value = deviceFilter; renderLineOptions();
  }
  function renderCalls(target, calls, recent = false) {
    $(target).replaceChildren();
    for (const call of calls) {
      const row = document.createElement("tr"); cell(row, call.device_name);
      if (!recent) cell(row, call.presentation === 1 && call.number ? call.number : "Privado o desconocido");
      const sim = cell(row, lineName(call)); if (call.phone_account_component_name) sim.title = call.phone_account_component_name;
      if (recent) cell(row, `${types[call.type] || "Otra"} · ${date(call.started_at)}`);
      else { cell(row, types[call.type] || "Otra"); cell(row, date(call.started_at)); }
      cell(row, `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`); $(target).append(row);
    }
    if (!calls.length) emptyRow(target, recent ? "Todavía no hay llamadas recibidas." : "Sin llamadas recibidas para esta selección.", recent ? 4 : 6);
  }
  function renderDetail(data) {
    const device = data.device; currentDetail = device;
    $("detail-name").textContent = device.name; $("detail-id").textContent = device.id;
    $("detail-contact").textContent = date(device.last_seen_at); $("detail-sync").textContent = date(device.last_sync_at);
    $("detail-call-count").textContent = device.call_count; $("detail-status").textContent = status(device);
    $("detail-request").textContent = !device.active ? "Este equipo está revocado. Su historial se conserva y no puede recibir nuevas solicitudes." : pending(device) ? `Solicitud ${device.sync_requested_id} pendiente. Última solicitud completada: ${device.sync_completed_id || "ninguna"}.` : device.sync_completed_id ? `Última solicitud completada: ${device.sync_completed_id}.` : "Todavía no se han solicitado sincronizaciones desde el panel.";
    $("detail-history").disabled = false; $("detail-export").disabled = false; $("detail-sync-request").disabled = !device.active || pending(device);
    $("detail-lines").replaceChildren();
    for (const line of data.lines || []) {
      const item = document.createElement("li"), title = document.createElement("strong"), info = document.createElement("small");
      title.textContent = lineName(line); info.textContent = `Última llamada recibida: ${date(line.last_call_at)}`;
      if (line.phone_account_component_name) item.title = line.phone_account_component_name;
      item.append(title, info); $("detail-lines").append(item);
    }
    if (!$("detail-lines").children.length) { const item = document.createElement("li"); item.textContent = "Todavía no hay cuentas identificadas en las llamadas recibidas."; $("detail-lines").append(item); }
  }
  async function refresh() {
    if (!key) return;
    if (refreshJob && refreshJob.session === session) { refreshJob.pending = true; return; }
    const run = session, job = {session:run, pending:false}, requestedHash = window.location.hash;
    refreshJob = job;
    const valid = () => run === session && refreshJob === job;
    try {
      const devices = await json("/v1/devices", run);
      if (!valid()) return;
      renderDevices(devices);
      if (requestedHash !== window.location.hash) return;
      if (view === "summary") {
        const data = await json("/v1/calls?limit=5", run);
        if (valid() && requestedHash === window.location.hash) renderCalls("recent-calls", data.calls, true);
      } else if (view === "calls") {
        const query = callQuery(deviceFilter), filters = query.toString(), pageOffset = offset, requestedSize = pageSize;
        query.set("offset", String(pageOffset)); query.set("limit", String(requestedSize));
        const data = await json(`/v1/calls?${query}`, run);
        if (!valid() || requestedHash !== window.location.hash || filters !== callQuery(deviceFilter).toString() || pageOffset !== offset || requestedSize !== pageSize) return;
        renderCalls("calls", data.calls);
        $("result-summary").textContent = `${data.total} ${data.total === 1 ? "registro recibido" : "registros recibidos"}`;
        $("page-info").textContent = data.total ? `${offset + 1}–${offset + data.calls.length} de ${data.total} · Página ${Math.floor(offset / pageSize) + 1} de ${Math.ceil(data.total / pageSize)}` : "0 registros";
        $("previous").disabled = offset === 0; $("next").disabled = !data.has_more;
      } else if (view === "detail") {
        const requestedId = detailId;
        try {
          const data = await json(`/v1/devices/${encodeURIComponent(requestedId)}`, run);
          if (valid() && requestedHash === window.location.hash && requestedId === detailId) renderDetail(data);
        } catch (error) {
          if (error !== obsolete && valid() && requestedId === detailId) { resetDetail(); $("detail-name").textContent = "Equipo no disponible"; $("detail-request").textContent = error.message; }
          if (error === obsolete) throw error;
        }
      }
    } finally {
      if (refreshJob === job) { refreshJob = null; if (job.pending && run === session && key) safeRefresh(); }
    }
  }
  async function safeRefresh() {
    const run = session, requestedHash = window.location.hash;
    try { await refresh(); } catch (error) { if (error !== obsolete && run === session && requestedHash === window.location.hash) message(error.message, true); }
  }
  function clearQr() {
    clearTimeout(qrExpiry); qrExpiry = null; $("enrollment-qr").hidden = true; $("enrollment-qr").replaceChildren();
    if (qrUrl) URL.revokeObjectURL(qrUrl); qrUrl = null;
  }
  function closeEnrollment() { qrSerial++; clearQr(); $("enrollment-create").disabled = false; $("enrollment-dialog").close(); $("enrollment-title").textContent = ""; $("enrollment-info").textContent = ""; }
  $("enrollment-form").addEventListener("submit", async event => {
    event.preventDefault(); const run = session, serial = ++qrSerial; $("enrollment-create").disabled = true; message();
    try {
      const response = await api("/v1/enrollments", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name:$("enrollment-name").value.trim()})}, run);
      const data = await response.json();
      if (run !== session || serial !== qrSerial) return;
      clearQr(); $("enrollment-title").textContent = data.name;
      $("enrollment-info").textContent = `${data.server_url} · huella ${data.ca_fingerprint.slice(0,16)} · válido hasta ${date(data.expires_at)}`;
      qrUrl = URL.createObjectURL(new Blob([data.qr_svg], {type:"image/svg+xml"}));
      const image = document.createElement("img"); image.src = qrUrl; image.alt = "Código QR de alta, privado y de un solo uso";
      $("enrollment-qr").append(image); $("enrollment-qr").hidden = false; $("enrollment-dialog").showModal();
      qrExpiry = setTimeout(() => { if (run !== session || serial !== qrSerial) return; clearQr(); $("enrollment-info").textContent = "Este QR venció. Cierra y genera otro."; }, Math.max(0, data.expires_at - Date.now()));
    } catch (error) { if (error !== obsolete && run === session) message(error.message, true); }
    finally { if (run === session && serial === qrSerial) $("enrollment-create").disabled = false; }
  });
  $("enrollment-close").addEventListener("click", closeEnrollment);
  $("enrollment-dialog").addEventListener("close", () => { qrSerial++; clearQr(); $("enrollment-title").textContent = ""; $("enrollment-info").textContent = ""; });
  $("add-device").addEventListener("click", () => { $("enrollment-section").hidden = false; $("enrollment-name").focus(); });
  $("enrollment-cancel").addEventListener("click", () => { closeEnrollment(); $("enrollment-section").hidden = true; $("enrollment-name").value = ""; $("add-device").focus(); });
  $("login-form").addEventListener("submit", async event => {
    event.preventDefault(); const token = $("admin-key").value.trim(); logout(false); key = token; const run = ++session; showRoute(false, false);
    try {
      await refresh(); if (run !== session || !key) return;
      $("login").hidden = true; $("login-header").hidden = true; $("workspace").hidden = false;
      $(headings[view]).focus(); clearInterval(timer); timer = setInterval(safeRefresh, 5000);
    } catch (error) { if (error !== obsolete && run === session) { logout(); message(error.message, true); } }
  });
  $("logout").addEventListener("click", () => logout());
  $("refresh").addEventListener("click", () => { message(); return safeRefresh(); });
  $("device-filter").addEventListener("change", () => { deviceFilter = $("device-filter").value; lineFilter = ""; offset = 0; renderLineOptions(); return safeRefresh(); });
  $("line-filter").addEventListener("change", () => {
    const selected = knownLines.find(line => lineValue(line) === $("line-filter").value);
    lineFilter = selected ? lineValue(selected) : "";
    if (selected) { deviceFilter = selected.device_id; $("device-filter").value = deviceFilter; }
    offset = 0; renderLineOptions(); return safeRefresh();
  });
  $("date-filter-form").addEventListener("submit", event => {
    event.preventDefault();
    try { applyDates(); message(); return safeRefresh(); } catch (error) { message(error.message, true); $("date-from").focus(); }
  });
  $("clear-dates").addEventListener("click", () => { $("date-from").value = ""; $("date-until").value = ""; applyDates(); message(); return safeRefresh(); });
  $("page-size").addEventListener("change", () => {
    const selected = Number($("page-size").value); pageSize = [25, 50, 100, 200].includes(selected) ? selected : 50;
    $("page-size").value = String(pageSize); offset = 0; return safeRefresh();
  });
  $("previous").addEventListener("click", () => { offset = Math.max(0, offset - pageSize); return safeRefresh(); });
  $("next").addEventListener("click", () => { offset += pageSize; return safeRefresh(); });
  async function exportFile(device, withFilters = false) { const run = session; try { await download(device, withFilters); } catch (error) { if (error !== obsolete && run === session) message(error.message, true); } }
  $("export-selected").addEventListener("click", () => exportFile(deviceFilter, true));
  $("export-all").addEventListener("click", () => exportFile(""));
  $("detail-export").addEventListener("click", () => currentDetail && exportFile(currentDetail.id));
  $("detail-history").addEventListener("click", () => {
    if (!currentDetail) return;
    deviceFilter = currentDetail.id; lineFilter = ""; dateFilters = new URLSearchParams(); offset = 0;
    $("date-from").value = ""; $("date-until").value = ""; $("device-filter").value = deviceFilter; renderLineOptions(); return goTo("#llamadas");
  });
  $("detail-sync-request").addEventListener("click", async () => {
    if (!currentDetail || !currentDetail.active || pending(currentDetail)) return;
    const run = session; $("detail-sync-request").disabled = true;
    try { await syncDevice(currentDetail); } catch (error) { if (error !== obsolete && run === session) { message(error.message, true); $("detail-sync-request").disabled = false; } }
  });
  window.addEventListener("hashchange", () => showRoute());
  showRoute(false, false);
})();
