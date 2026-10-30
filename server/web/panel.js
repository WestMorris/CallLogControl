"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let key = "", timer = null, offset = 0, loading = false;
  const date = value => value ? new Date(value).toLocaleString("es", {dateStyle:"short", timeStyle:"short"}) : "Sin dato";
  const types = {1:"Entrante",2:"Saliente",3:"Perdida",4:"Buzón de voz",5:"Rechazada",6:"Bloqueada",7:"Contestada en otro equipo"};
  function message(text = "", error = false) { $("message").textContent = text; $("message").classList.toggle("error", error); }
  function logout() {
    key = ""; clearInterval(timer); timer = null;
    $("workspace").hidden = true; $("logout").hidden = true; $("login").hidden = false;
    $("devices").replaceChildren(); $("calls").replaceChildren(); $("device-filter").replaceChildren(new Option("Todos los equipos", ""));
    $("admin-key").value = "";
  }
  async function api(path, options = {}) {
    const response = await fetch(path, {...options, cache:"no-store", headers:{Authorization:`Bearer ${key}`}});
    if (response.status === 401) { logout(); throw Error("Credencial de administrador incorrecta o sesión sin acceso."); }
    if (!response.ok) throw Error(`El servidor respondió ${response.status}. Intenta de nuevo.`);
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
  async function download(device = "") {
    const response = await api("/v1/export.csv" + (device ? `?device_id=${encodeURIComponent(device)}` : ""));
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement("a"); a.href = url; a.download = device ? `llamadas-${device}.csv` : "llamadas-todos.csv";
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function refresh() {
    if (!key || loading) return;
    loading = true;
    try {
      const selected = $("device-filter").value;
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
      $("device-filter").value = selected;
      const query = new URLSearchParams({offset:String(offset)});
      if ($("device-filter").value) query.set("device_id", $("device-filter").value);
      const data = await (await api(`/v1/calls?${query}`)).json();
      if (!key) return;
      $("calls").replaceChildren();
      for (const call of data.calls) {
        const row = document.createElement("tr");
        cell(row,call.device_name); cell(row,call.presentation === 1 && call.number ? call.number : "Privado o desconocido");
        cell(row,types[call.type] || "Otra"); cell(row,date(call.started_at));
        cell(row,`${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`); $("calls").append(row);
      }
      if (!data.calls.length) { const row = document.createElement("tr"); cell(row,"Sin llamadas recibidas para esta selección.").colSpan = 5; $("calls").append(row); }
      $("result-summary").textContent = `${data.total} ${data.total === 1 ? "registro recibido" : "registros recibidos"}`;
      $("page-info").textContent = data.total ? `${offset + 1}–${offset + data.calls.length} de ${data.total}` : "0 registros";
      $("previous").disabled = offset === 0; $("next").disabled = !data.has_more;
    } finally { loading = false; }
  }
  async function safeRefresh() { try { await refresh(); } catch (error) { message(error.message, true); } }
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
  $("device-filter").addEventListener("change", () => { offset = 0; safeRefresh(); });
  $("previous").addEventListener("click", () => { offset = Math.max(0, offset - 50); safeRefresh(); });
  $("next").addEventListener("click", () => { offset += 50; safeRefresh(); });
  $("export-selected").addEventListener("click", () => download($("device-filter").value).catch(error => message(error.message, true)));
  $("export-all").addEventListener("click", () => download().catch(error => message(error.message, true)));
})();
