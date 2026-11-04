"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let key = "", timer = null, offset = 0, pageSize = 50, loading = false, refreshPending = false;
  let deviceFilter = "", dateFilters = new URLSearchParams();
  let qrUrl = null, qrExpiry = null;
  const date = value => value ? new Date(value).toLocaleString("es", {dateStyle:"short", timeStyle:"short"}) : "Sin dato";
  const types = {1:"Entrante",2:"Saliente",3:"Perdida",4:"Buzón de voz",5:"Rechazada",6:"Bloqueada",7:"Contestada en otro equipo"};
  function message(text = "", error = false) { $("message").textContent = text; $("message").classList.toggle("error", error); }
  function logout() {
    closeEnrollment();
    key = ""; clearInterval(timer); timer = null;
    $("workspace").hidden = true; $("logout").hidden = true; $("login").hidden = false;
    $("devices").replaceChildren(); $("calls").replaceChildren(); $("device-filter").replaceChildren(new Option("Todos los equipos", ""));
    deviceFilter = ""; dateFilters = new URLSearchParams();
    offset = 0; pageSize = 50; $("page-size").value = "50";
    $("date-from").value = ""; $("date-until").value = "";
    $("admin-key").value = "";
  }
  async function api(path, options = {}) {
    const response = await fetch(path, {...options, cache:"no-store", headers:{...options.headers, Authorization:`Bearer ${key}`}});
    if (response.status === 401) { logout(); throw Error("Credencial de administrador incorrecta o sesión sin acceso."); }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Error(data.error || `El servidor respondió ${response.status}. Intenta de nuevo.`);
    }
    return response;
  }
  function cell(row, value) { const td = document.createElement("td"); td.textContent = value; row.append(td); return td; }
  function button(label, action) {
    const node = document.createElement("button"); node.textContent = label;
    node.addEventListener("click", async () => {
      node.disabled = true;
      try { await action(); } catch (error) { message(error.message, true); }
      finally { node.disabled = false; }
    });
    return node;
  }
  function callQuery(device, withDates = true) {
    const query = new URLSearchParams(withDates ? dateFilters : undefined);
    if (device) query.set("device_id", device);
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
  async function download(device = "", withDates = false) {
    const query = callQuery(device, withDates);
    const response = await api(`/v1/export.csv${query.size ? `?${query}` : ""}`);
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement("a"); a.href = url; a.download = device ? `llamadas-${device}.csv` : "llamadas-todos.csv";
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function refresh() {
    if (!key) return;
    if (loading) { refreshPending = true; return; }
    loading = true;
    try {
      const devices = (await (await api("/v1/devices")).json()).devices;
      if (!key) return;
      $("device-count").textContent = devices.length;
      $("call-count").textContent = devices.reduce((sum, device) => sum + device.call_count, 0);
      $("request-count").textContent = devices.filter(device => device.sync_requested_id !== device.sync_completed_id).length;
      $("devices").replaceChildren();
      $("device-filter").replaceChildren(new Option("Todos los equipos", ""));
      for (const device of devices) {
        $("device-filter").add(new Option(device.name, device.id));
        const row = document.createElement("tr");
        const name = cell(row, device.name); const id = document.createElement("small"); id.textContent = device.id; name.append(id);
        cell(row, device.call_count); cell(row, date(device.last_seen_at)); cell(row, date(device.last_sync_at));
        const pending = device.sync_requested_id !== device.sync_completed_id;
        const badge = document.createElement("span"); badge.className = "badge" + (!device.active ? " inactive" : pending ? " pending" : "");
        badge.textContent = !device.active ? "Revocado" : pending ? "Pendiente" : device.sync_completed_id ? "Completada" : "Sin solicitudes";
        cell(row, "").append(badge);
        const actions = cell(row, ""); actions.className = "actions";
        const sync = button("Solicitar sincronización", async () => {
          await api(`/v1/devices/${encodeURIComponent(device.id)}/sync`, {method:"POST"});
          message(`Solicitud enviada a ${device.name}. Se ejecutará cuando la app contacte al servidor.`);
          await refresh();
        });
        sync.disabled = !device.active || pending;
        actions.append(sync, button("CSV", () => download(device.id)));
        $("devices").append(row);
      }
      if (!devices.length) { const row = document.createElement("tr"); cell(row,"Todavía no hay equipos registrados.").colSpan = 6; $("devices").append(row); }
      $("device-filter").value = deviceFilter;
      const query = callQuery(deviceFilter);
      const filters = query.toString(), pageOffset = offset, requestedSize = pageSize;
      query.set("offset", String(pageOffset));
      query.set("limit", String(requestedSize));
      const data = await (await api(`/v1/calls?${query}`)).json();
      if (!key || filters !== callQuery(deviceFilter).toString() || pageOffset !== offset || requestedSize !== pageSize) return;
      $("calls").replaceChildren();
      for (const call of data.calls) {
        const row = document.createElement("tr");
        cell(row,call.device_name); cell(row,call.presentation === 1 && call.number ? call.number : "Privado o desconocido");
        const line = call.line_label && call.phone_account_id ? `${call.line_label} (${call.phone_account_id})` : call.line_label || call.phone_account_id;
        const sim = cell(row, line || "No disponible");
        if (call.phone_account_component_name) sim.title = call.phone_account_component_name;
        cell(row,types[call.type] || "Otra"); cell(row,date(call.started_at));
        cell(row,`${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`); $("calls").append(row);
      }
      if (!data.calls.length) { const row = document.createElement("tr"); cell(row,"Sin llamadas recibidas para esta selección.").colSpan = 6; $("calls").append(row); }
      $("result-summary").textContent = `${data.total} ${data.total === 1 ? "registro recibido" : "registros recibidos"}`;
      $("page-info").textContent = data.total ? `${offset + 1}–${offset + data.calls.length} de ${data.total} · Página ${Math.floor(offset / pageSize) + 1} de ${Math.ceil(data.total / pageSize)}` : "0 registros";
      $("previous").disabled = offset === 0; $("next").disabled = !data.has_more;
    } finally {
      loading = false;
      if (refreshPending) { refreshPending = false; safeRefresh(); }
    }
  }
  async function safeRefresh() { try { await refresh(); } catch (error) { message(error.message, true); } }
  function clearQr() {
    clearTimeout(qrExpiry); qrExpiry = null;
    $("enrollment-qr").removeAttribute("src");
    if (qrUrl) URL.revokeObjectURL(qrUrl);
    qrUrl = null;
  }
  function closeEnrollment() { clearQr(); $("enrollment-dialog").close(); }
  $("enrollment-form").addEventListener("submit", async event => {
    event.preventDefault(); $("enrollment-create").disabled = true; message();
    try {
      const response = await api("/v1/enrollments", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name:$("enrollment-name").value.trim()})});
      const data = await response.json();
      if (!key) return;
      clearQr();
      $("enrollment-title").textContent = data.name;
      $("enrollment-info").textContent = `${data.server_url} · huella ${data.ca_fingerprint.slice(0,16)} · válido hasta ${date(data.expires_at)}`;
      qrUrl = URL.createObjectURL(new Blob([data.qr_svg], {type:"image/svg+xml"}));
      $("enrollment-qr").src = qrUrl;
      $("enrollment-dialog").showModal();
      qrExpiry = setTimeout(() => { clearQr(); $("enrollment-info").textContent = "Este QR venció. Cierra y genera otro."; }, Math.max(0, data.expires_at - Date.now()));
    } catch (error) { message(error.message, true); }
    finally { $("enrollment-create").disabled = false; }
  });
  $("enrollment-close").addEventListener("click", closeEnrollment);
  $("enrollment-dialog").addEventListener("close", clearQr);
  $("login-form").addEventListener("submit", async event => {
    event.preventDefault(); key = $("admin-key").value.trim(); $("admin-key").value = ""; offset = 0; message();
    try {
      await refresh(); if (!key) return;
      $("login").hidden = true; $("workspace").hidden = false; $("logout").hidden = false;
      clearInterval(timer); timer = setInterval(safeRefresh, 5000);
    } catch (error) { logout(); message(error.message, true); }
  });
  $("logout").addEventListener("click", () => { logout(); message(); });
  $("refresh").addEventListener("click", () => { message(); safeRefresh(); });
  $("device-filter").addEventListener("change", () => { deviceFilter = $("device-filter").value; offset = 0; safeRefresh(); });
  $("date-filter-form").addEventListener("submit", event => {
    event.preventDefault();
    try { applyDates(); message(); safeRefresh(); }
    catch (error) { message(error.message, true); $("date-from").focus(); }
  });
  $("clear-dates").addEventListener("click", () => {
    $("date-from").value = ""; $("date-until").value = "";
    applyDates(); message(); safeRefresh();
  });
  $("page-size").addEventListener("change", () => {
    const selected = Number($("page-size").value);
    pageSize = [25, 50, 100, 200].includes(selected) ? selected : 50;
    $("page-size").value = String(pageSize); offset = 0; safeRefresh();
  });
  $("previous").addEventListener("click", () => { offset = Math.max(0, offset - pageSize); safeRefresh(); });
  $("next").addEventListener("click", () => { offset += pageSize; safeRefresh(); });
  $("export-selected").addEventListener("click", () => download(deviceFilter, true).catch(error => message(error.message, true)));
  $("export-all").addEventListener("click", () => download().catch(error => message(error.message, true)));
})();
