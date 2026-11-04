"use strict";
// Run with: node server/test_panel.js
process.env.TZ = "America/New_York";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class Element {
  constructor(id = "", tagName = "div") {
    this.id = id; this.tagName = tagName.toUpperCase(); this.value = ""; this.children = []; this.events = {};
    this.attributes = {}; this.dataset = {}; this.hidden = false; this._text = "";
    const classes = new Set();
    this.classList = {toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); }};
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent || "").join(""); }
  addEventListener(name, action) { this.events[name] = action; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ""; this.children = nodes; if (this.tagName === "SELECT") this.value = nodes[0]?.value || ""; }
  add(node) { this.append(node); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; if (name === "src") delete this.src; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  focus() {}
  click() {}
  remove() {}
}
const elements = new Map();
for (const match of fs.readFileSync(`${__dirname}/web/index.html`, "utf8").matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
  const node = new Element(match[2], match[1]);
  for (const attribute of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attribute[1], attribute[2]);
  node.hidden = /\bhidden(?:\s|>)/.test(match[0]);
  elements.set(node.id, node);
}
const element = id => {
  if (!elements.has(id)) elements.set(id, new Element(id));
  return elements.get(id);
};
const requests = [];
const httpRequests = [], browserEvents = {}, timeouts = new Map(), revokedUrls = [];
let timeoutId = 0, blockCalls = false, releaseCalls, blockDetail = false, releaseDetail, blockEnrollment = false, releaseEnrollment;
let hash = "";
const location = {get hash() { return hash; }, set hash(value) {
  if (hash !== value) { hash = value; queueMicrotask(() => browserEvents.hashchange?.()); }
}};
const history = {replaceState(_state, _title, value) { hash = value; }};
const window = {location, history, addEventListener(name, callback) { browserEvents[name] = callback; }};
const analyticsCalls = {loads:[], resets:0, departures:0};
window.CallLogAnalytics = {mount(root, hooks) {
  assert.equal(root.id, "analytics-root");
  element("analytics-title");
  return {load:async catalog => { assert.equal(hooks.isActive(), true); analyticsCalls.loads.push(catalog); },
    reset:() => { analyticsCalls.resets++; }, deactivate:() => { analyticsCalls.departures++; }};
}};
const component = "com.android.phone/TelephonyConnectionService";
const devices = [
  {id:"a", name:"Equipo A", active:1, call_count:125, last_seen_at:Date.now(), last_sync_at:Date.now(), sync_requested_id:null, sync_completed_id:null},
  {id:"b", name:"Equipo B", active:1, call_count:0, last_seen_at:Date.now()-2*3600000, last_sync_at:null, sync_requested_id:"pending-b", sync_completed_id:null},
  {id:"revoked", name:"Equipo revocado", active:0, call_count:0, last_seen_at:null, last_sync_at:null, sync_requested_id:null, sync_completed_id:null}
];
const lines = [{device_id:"a", device_name:"Equipo A", phone_account_id:"chip-a", phone_account_component_name:component, line_label:"SIM 1"},
  {device_id:"a", device_name:"Equipo A", phone_account_id:"chip-b", phone_account_component_name:component, line_label:"SIM 2"}];
const calls = Array.from({length:125}, (_, index) => ({device_name:"Equipo A", number:"123", presentation:1,
  device_id:"a", type:1, started_at:1, duration_seconds:1, phone_account_id:index === 0 ? "chip-a" : index === 1 ? "chip-b" : "",
  line_label:index === 0 ? "SIM 1" : index === 3 ? "<img src=x onerror=alert(1)>" : "",
  phone_account_component_name:index < 2 ? component : ""}));
const response = data => ({ok:true, status:200, json:async () => data, blob:async () => new Blob()});
const enrollment = name => response({name, server_url:"https://192.168.1.100:8443", ca_fingerprint:"abc123".repeat(12),
  expires_at:Date.now()+300000, qr_svg:"<svg></svg>"});
vm.runInNewContext(fs.readFileSync(`${__dirname}/web/panel.js`, "utf8"), {
  document:{getElementById:id => elements.get(id) || null, createElement:tag => new Element("", tag), body:new Element(), querySelectorAll:selector => {
    if (selector === "nav a") return [...elements.values()].filter(node => node.id.startsWith("nav-"));
    const attribute = selector.match(/^\[([^\]=]+)\]$/)?.[1];
    return attribute ? [...elements.values()].filter(node => node.getAttribute(attribute) !== null) : [];
  }}, window, location, history,
  Option:function (text, value) { this.textContent = text; this.value = value; },
  URLSearchParams, URL:{createObjectURL:() => "blob:test", revokeObjectURL(url) { revokedUrls.push(url); }}, Date, Blob,
  setInterval:() => 0, clearInterval() {}, setTimeout:(callback, delay) => { timeouts.set(++timeoutId, {callback, delay}); return timeoutId; },
  clearTimeout:id => timeouts.delete(id),
  fetch:async (path, options = {}) => {
    requests.push(path);
    httpRequests.push({path, ...options});
    if (path === "/v1/devices") return response({devices, lines});
    if (path.startsWith("/v1/devices/") && !path.endsWith("/sync")) {
      const device = devices.find(item => item.id === decodeURIComponent(path.split("/").at(-1)));
      if (!device) return {ok:false, status:404, json:async () => ({error:"Equipo inexistente"})};
      if (blockDetail) { blockDetail = false; return new Promise(resolve => { releaseDetail = result => resolve(result || response({device, lines})); }); }
      return response({device, lines:lines.filter(line => line.device_id === device.id)});
    }
    if (path.endsWith("/sync")) {
      devices.find(item => item.id === path.split("/").at(-2)).sync_requested_id = "new-pending-request";
      return response({request_id:"new-pending-request"});
    }
    if (path === "/v1/enrollments") {
      const invitation = enrollment(JSON.parse(options.body).name);
      if (blockEnrollment) { blockEnrollment = false; return new Promise(resolve => { releaseEnrollment = () => resolve(invitation); }); }
      return invitation;
    }
    if (path.startsWith("/v1/calls?")) {
      if (blockCalls) {
        blockCalls = false;
        return new Promise(resolve => { releaseCalls = () => resolve(response({calls:[], total:999, has_more:false})); });
      }
      const query = new URL(path, "http://localhost").searchParams;
      const offset = Number(query.get("offset")), limit = Number(query.get("limit"));
      const filtered = calls.filter(call => (!query.has("device_id") || call.device_id === query.get("device_id")) &&
        (!query.has("phone_account_id") || call.phone_account_id === query.get("phone_account_id")) &&
        (!query.has("phone_account_component_name") || call.phone_account_component_name === query.get("phone_account_component_name")));
      return response({calls:filtered.slice(offset, offset + limit), total:filtered.length, has_more:offset + limit < filtered.length});
    }
    return response({});
  }
});
const flush = () => new Promise(setImmediate);
async function event(id, name = "click", wait = true) {
  if (name === "click" && !element(id).events.click && (element(id).href || element(id).getAttribute("href"))) {
    return navigate(element(id).href || element(id).getAttribute("href"));
  }
  assert.equal(typeof element(id).events[name], "function", `missing ${name} handler on #${id}`);
  const result = element(id).events[name]({preventDefault() {}, target:element(id), currentTarget:element(id)});
  if (wait) await result;
  await flush();
}
async function navigate(hash) { location.hash = hash; await flush(); }
const queryOf = path => new URL(path, "http://localhost").searchParams;
const lastCalls = () => requests.filter(path => path.startsWith("/v1/calls?")).at(-1);

let completed = false;
process.on("beforeExit", () => { if (!completed) { console.error("Panel test stopped with an unresolved operation."); process.exitCode = 1; } });
(async () => {
  element("admin-key").value = "test-only-admin-key";
  await event("login-form", "submit");
  assert.equal(element("summary-view").hidden, false);
  assert.equal(element("calls-view").hidden, true);
  assert.equal(queryOf(lastCalls()).get("limit"), "5", "summary requests only global recent calls");
  assert.equal(queryOf(lastCalls()).has("device_id"), false);
  assert.equal(element("call-count").textContent, "125");
  assert.equal(element("recent-contact-count").textContent, "1 de 2");
  assert.equal(element("request-count").textContent, "1");
  assert.equal(element("revoked-count").textContent, "1");
  assert.match(element("attention-list").textContent, /Equipo B/);
  assert.doesNotMatch(element("attention-list").textContent, /Equipo revocado/);
  assert.equal(element("recent-calls").children.length, 5);
  await navigate("#llamadas");
  assert.equal(queryOf(lastCalls()).get("limit"), "50");
  assert.equal(element("calls").children.length, 50);
  assert.equal(element("page-info").textContent, "1–50 de 125 · Página 1 de 3");
  assert.equal(element("previous").disabled, true);
  assert.equal(element("next").disabled, false);
  const simCells = element("calls").children.map(row => row.children[2]);
  assert.equal(simCells[0].textContent, "SIM 1 (chip-a)");
  assert.equal(simCells[0].title, "com.android.phone/TelephonyConnectionService");
  assert.equal(simCells[1].textContent, "chip-b");
  assert.equal(simCells[2].textContent, "No disponible");
  assert.equal(simCells[3].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(simCells[3].children.length, 0, "line labels must remain text, never executable HTML");
  await event("next");
  assert.equal(queryOf(lastCalls()).get("offset"), "50");
  await event("next");
  assert.equal(queryOf(lastCalls()).get("offset"), "100");
  assert.equal(element("calls").children.length, 25);
  assert.equal(element("page-info").textContent, "101–125 de 125 · Página 3 de 3");
  assert.equal(element("next").disabled, true);
  await event("previous");
  assert.equal(queryOf(lastCalls()).get("offset"), "50");
  for (const size of [25, 100, 200, 50]) {
    element("page-size").value = String(size);
    await event("page-size", "change");
    assert.equal(queryOf(lastCalls()).get("limit"), String(size));
    assert.equal(queryOf(lastCalls()).get("offset"), "0", "changing page size resets pagination");
    assert.equal(element("calls").children.length, Math.min(size, calls.length));
  }
  element("page-size").value = "25";
  await event("page-size", "change");
  await event("next");
  assert.equal(queryOf(lastCalls()).get("offset"), "25");
  element("device-filter").value = "a";
  await event("device-filter", "change");
  assert.equal(queryOf(lastCalls()).get("offset"), "0", "changing device resets pagination");
  await event("next");
  element("date-from").value = "2026-03-08";
  element("date-until").value = "2026-03-08";
  await event("date-filter-form", "submit");
  let query = queryOf(lastCalls());
  assert.equal(query.get("device_id"), "a");
  assert.equal(query.get("offset"), "0");
  assert.equal(query.get("started_from"), String(Date.parse("2026-03-08T05:00:00Z")));
  assert.equal(query.get("started_before"), String(Date.parse("2026-03-09T04:00:00Z")));
  assert.equal(Number(query.get("started_before")) - Number(query.get("started_from")), 23 * 3600000);

  element("date-until").value = "2026-03-10";
  await event("export-selected");
  assert.equal(queryOf(requests.at(-1)).get("started_before"), query.get("started_before"), "CSV uses applied dates, not unsubmitted edits");
  assert.equal(queryOf(requests.at(-1)).has("limit"), false, "CSV exports every matching row, independent of page size");
  assert.equal(queryOf(requests.at(-1)).has("offset"), false);
  await event("export-all");
  assert.equal(requests.at(-1), "/v1/export.csv");
  element("date-from").value = "2026-03-11";
  const beforeInvalid = requests.length;
  await event("date-filter-form", "submit");
  assert.equal(requests.length, beforeInvalid);
  assert.match(element("message").textContent, /Desde debe ser anterior/);
  await event("clear-dates");
  query = queryOf(lastCalls());
  assert.equal(query.get("device_id"), "a");
  assert.equal(query.has("started_from"), false);
  assert.equal(query.has("started_before"), false);

  blockCalls = true;
  await event("refresh", "click", false);
  element("date-until").value = "2026-11-04";
  await event("date-filter-form", "submit");
  releaseCalls();
  await flush();
  query = queryOf(lastCalls());
  assert.equal(query.has("started_from"), false);
  assert.equal(query.get("started_before"), String(Date.parse("2026-11-05T05:00:00Z")));
  assert.equal(element("result-summary").textContent, "125 registros recibidos", "in-flight refresh must not leave the old filter result visible");

  blockCalls = true;
  await event("refresh", "click", false);
  element("page-size").value = "200";
  await event("page-size", "change");
  releaseCalls();
  await flush();
  assert.equal(queryOf(lastCalls()).get("limit"), "200");
  assert.equal(element("calls").children.length, 125, "in-flight refresh must not render the old page size");
  assert.equal(element("page-info").textContent, "1–125 de 125 · Página 1 de 1");
  assert.equal(element("next").disabled, true);

  element("device-filter").value = "";
  await event("device-filter", "change");
  const selectedLine = JSON.stringify(["a", component, "chip-a"]);
  element("line-filter").value = selectedLine;
  await event("line-filter", "change");
  query = queryOf(lastCalls());
  assert.equal(element("device-filter").value, "a", "selecting a SIM from all devices must visibly select its owning device");
  assert.equal(query.get("device_id"), "a");
  assert.equal(query.get("phone_account_id"), "chip-a");
  assert.equal(query.get("phone_account_component_name"), component);
  assert.equal(element("calls").children.length, 1);
  await event("export-selected");
  const csvQuery = queryOf(requests.at(-1));
  assert.equal(csvQuery.get("phone_account_id"), "chip-a");
  assert.equal(csvQuery.get("phone_account_component_name"), component);
  assert.equal(csvQuery.get("started_before"), query.get("started_before"));
  assert.equal(csvQuery.has("limit"), false);
  element("line-filter").value = "";
  await event("line-filter", "change");
  assert.equal(queryOf(lastCalls()).get("device_id"), "a", "clearing the SIM keeps its selected device");
  element("line-filter").value = selectedLine;
  await event("line-filter", "change");

  await navigate("#resumen");
  query = queryOf(lastCalls());
  assert.equal(query.get("limit"), "5");
  for (const name of ["device_id", "phone_account_id", "phone_account_component_name", "started_before", "offset"]) {
    assert.equal(query.has(name), false, `summary must not inherit the calls filter ${name}`);
  }
  assert.equal(element("call-count").textContent, "125");
  assert.equal(element("recent-calls").children.length, 5);
  await navigate("#llamadas");
  assert.equal(element("line-filter").value, selectedLine);
  assert.equal(queryOf(lastCalls()).get("phone_account_id"), "chip-a", "hash navigation restores the calls selection");

  await navigate("#equipos/a");
  assert.equal(element("device-detail-view").hidden, false);
  assert.equal(element("detail-name").textContent, "Equipo A");
  assert.match(element("detail-lines").textContent, /SIM 1/);
  assert.match(element("detail-lines").textContent, /SIM 2/);
  await event("detail-export");
  assert.equal(requests.at(-1), "/v1/export.csv?device_id=a", "device CSV always contains its complete history");
  await event("detail-sync-request");
  assert.match(element("detail-status").textContent, /Pendiente/);
  assert.equal(element("detail-sync-request").disabled, true, "a queued request must not be reported as completed");
  await event("detail-history");
  query = queryOf(lastCalls());
  assert.equal(location.hash, "#llamadas");
  assert.equal(query.get("device_id"), "a");
  assert.equal(query.get("offset"), "0");
  assert.equal(query.has("phone_account_id"), false);
  assert.equal(query.has("started_before"), false);
  assert.equal(element("line-filter").value, "");
  assert.equal(element("date-until").value, "");

  element("page-size").value = "25";
  await event("page-size", "change");
  await event("next");
  await navigate("#equipos");
  assert.equal(element("devices-view").hidden, false);
  await navigate("#llamadas");
  assert.equal(queryOf(lastCalls()).get("offset"), "25", "ordinary navigation keeps pagination");
  assert.equal(element("calls-view").hidden, false);
  assert.equal(element("summary-view").hidden, true);

  await navigate("#analitica");
  assert.equal(element("analytics-view").hidden, false);
  assert.equal(element("calls-view").hidden, true);
  assert.equal(element("nav-analytics").getAttribute("aria-current"), "page");
  assert.equal(analyticsCalls.loads.at(-1).devices, devices);
  await navigate("#llamadas");
  assert.equal(analyticsCalls.departures, 1);
  assert.equal(queryOf(lastCalls()).get("offset"), "25", "analytics navigation preserves calls pagination");

  blockDetail = true;
  await navigate("#equipos/a");
  const previousViewResponse = releaseDetail;
  await navigate("#llamadas");
  previousViewResponse({ok:false, status:500, json:async () => ({error:"late detail failure"})});
  await flush();
  assert.equal(element("calls-view").hidden, false);
  assert.doesNotMatch(element("message").textContent, /late detail failure/, "an old detail failure must not appear in the new view");

  await navigate("#equipos");
  await event("add-device");
  assert.equal(element("enrollment-section").hidden, false);
  element("enrollment-name").value = "  Equipo nuevo  ";
  await event("enrollment-form", "submit");
  assert.equal(element("enrollment-dialog").open, true);
  assert.equal(element("enrollment-qr").children.length, 1);
  assert.equal(element("enrollment-qr").children[0].src, "blob:test");
  const inviteRequest = httpRequests.findLast(request => request.path === "/v1/enrollments");
  assert.equal(JSON.parse(inviteRequest.body).name, "Equipo nuevo");
  assert.equal(inviteRequest.headers.Authorization, "Bearer test-only-admin-key");
  const expiry = [...timeouts.values()].find(timer => timer.delay > 1000);
  assert.ok(expiry, "the visible QR needs an expiry timer");
  expiry.callback();
  assert.equal(element("enrollment-qr").children.length, 0);
  assert.match(element("enrollment-info").textContent, /venció/);
  assert.ok(revokedUrls.includes("blob:test"));
  await event("enrollment-close");
  assert.equal(element("enrollment-dialog").open, false);

  blockDetail = true;
  await navigate("#equipos/a");
  assert.equal(typeof releaseDetail, "function");
  await event("logout");
  releaseDetail();
  await flush();
  assert.equal(element("workspace").hidden, true);
  assert.equal(element("login").hidden, false);
  assert.doesNotMatch(element("detail-name").textContent, /Equipo A/);
  assert.doesNotMatch(element("detail-lines").textContent, /SIM [12]/);
  assert.equal(element("devices").children.length, 0);
  assert.equal(element("calls").children.length, 0);
  assert.equal(element("recent-calls").children.length, 0);

  element("admin-key").value = "second-test-admin-key";
  await event("login-form", "submit");
  await navigate("#equipos");
  blockEnrollment = true;
  await event("add-device");
  element("enrollment-name").value = "Equipo de sesión anterior";
  const pendingInvite = element("enrollment-form").events.submit({preventDefault() {}});
  await flush();
  assert.equal(typeof releaseEnrollment, "function");
  assert.equal(element("enrollment-create").disabled, true);
  await event("logout");
  assert.equal(element("enrollment-dialog").open, false);
  assert.equal(element("enrollment-qr").children.length, 0);
  element("admin-key").value = "new-enrollment-session-key";
  await event("login-form", "submit");
  await navigate("#equipos");
  await event("add-device");
  assert.equal(element("enrollment-create").disabled, false, "a previous session's pending invitation must not disable new enrollment");
  element("enrollment-name").value = "Equipo de sesión nueva";
  await event("enrollment-form", "submit");
  assert.equal(element("enrollment-dialog").open, true);
  assert.equal(element("enrollment-title").textContent, "Equipo de sesión nueva");
  const newInvitationInfo = element("enrollment-info").textContent;
  releaseEnrollment();
  await pendingInvite;
  await flush();
  assert.equal(element("enrollment-dialog").open, true, "an old enrollment response cannot close the new session's QR");
  assert.equal(element("enrollment-title").textContent, "Equipo de sesión nueva");
  assert.equal(element("enrollment-info").textContent, newInvitationInfo);
  assert.equal(element("enrollment-create").disabled, false);
  await event("logout");

  element("admin-key").value = "third-test-admin-key";
  await event("login-form", "submit");
  blockDetail = true;
  await navigate("#equipos/a");
  const oldSessionResponse = releaseDetail;
  await event("logout");
  element("admin-key").value = "fourth-test-admin-key";
  await event("login-form", "submit");
  oldSessionResponse({ok:false, status:401, json:async () => ({error:"expired old session"})});
  await flush();
  assert.equal(element("workspace").hidden, false, "an obsolete 401 cannot close a newer authenticated session");
  assert.equal(element("login").hidden, true);
  assert.doesNotMatch(element("message").textContent, /expired old session/);
  await event("logout");

  await navigate("#equipos/no-existe");
  element("admin-key").value = "deep-link-session-key";
  await event("login-form", "submit");
  assert.equal(element("workspace").hidden, false, "an unknown device must not reject valid admin credentials");
  assert.equal(element("login").hidden, true);
  assert.equal(element("device-detail-view").hidden, false);
  assert.match(element("detail-request").textContent, /Equipo inexistente/);
  for (const id of ["detail-history", "detail-export", "detail-sync-request"]) assert.equal(element(id).disabled, true);
  await navigate("#resumen");
  assert.equal(element("summary-view").hidden, false);
  assert.equal(element("recent-calls").children.length, 5);
  await event("logout");
  console.log("Panel: views, detail, hash navigation, SIM filters, pagination, dates/DST, CSV, QR expiry, sync and stale-response isolation passed.");
})().then(() => { completed = true; }).catch(error => { completed = true; console.error(error); process.exitCode = 1; });
