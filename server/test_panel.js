"use strict";
// Run with: node server/test_panel.js
process.env.TZ = "America/New_York";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class Element {
  constructor(id = "") { this.id = id; this.value = ""; this.children = []; this.events = {}; this.classList = {toggle() {}}; }
  addEventListener(name, action) { this.events[name] = action; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; if (this.id === "device-filter") this.value = nodes[0].value; }
  add(node) { this.append(node); }
  close() {}
  focus() {}
  click() {}
  remove() {}
  removeAttribute() {}
}
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, new Element(id));
  return elements.get(id);
};
const requests = [];
let blockCalls = false, releaseCalls;
const calls = Array.from({length:125}, (_, index) => ({device_name:"Equipo A", number:"123", presentation:1,
  type:1, started_at:1, duration_seconds:1, phone_account_id:index === 0 ? "chip-a" : index === 1 ? "chip-b" : "",
  line_label:index === 0 ? "SIM 1" : index === 3 ? "<img src=x onerror=alert(1)>" : "",
  phone_account_component_name:index === 0 ? "com.android.phone/TelephonyConnectionService" : ""}));
const response = data => ({ok:true, status:200, json:async () => data, blob:async () => new Blob()});
vm.runInNewContext(fs.readFileSync(`${__dirname}/web/panel.js`, "utf8"), {
  document:{getElementById:element, createElement:() => new Element(), body:new Element()},
  Option:function (text, value) { this.textContent = text; this.value = value; },
  URLSearchParams, URL:{createObjectURL:() => "blob:test", revokeObjectURL() {}}, Date, Blob,
  setInterval:() => 0, clearInterval() {}, setTimeout:() => 0, clearTimeout() {},
  fetch:async path => {
    requests.push(path);
    if (path === "/v1/devices") return response({devices:[{id:"a", name:"Equipo A", active:1, call_count:calls.length}]});
    if (path.startsWith("/v1/calls?")) {
      if (blockCalls) {
        blockCalls = false;
        return new Promise(resolve => { releaseCalls = () => resolve(response({calls:[], total:999, has_more:false})); });
      }
      const query = new URL(path, "http://localhost").searchParams;
      const offset = Number(query.get("offset")), limit = Number(query.get("limit"));
      return response({calls:calls.slice(offset, offset + limit), total:calls.length, has_more:offset + limit < calls.length});
    }
    return response({});
  }
});
const flush = () => new Promise(setImmediate);
async function event(id, name = "click") {
  await element(id).events[name]({preventDefault() {}});
  await flush();
}
const queryOf = path => new URL(path, "http://localhost").searchParams;
const lastCalls = () => requests.filter(path => path.startsWith("/v1/calls?")).at(-1);

(async () => {
  element("admin-key").value = "test-only-admin-key";
  await event("login-form", "submit");
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
  const deviceCsv = element("devices").children[0].children.at(-1).children.find(node => node.textContent === "CSV");
  await deviceCsv.events.click();
  assert.equal(requests.at(-1), "/v1/export.csv?device_id=a");

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
  await event("refresh");
  element("date-until").value = "2026-11-04";
  await event("date-filter-form", "submit");
  releaseCalls();
  await flush();
  query = queryOf(lastCalls());
  assert.equal(query.has("started_from"), false);
  assert.equal(query.get("started_before"), String(Date.parse("2026-11-05T05:00:00Z")));
  assert.equal(element("result-summary").textContent, "125 registros recibidos", "in-flight refresh must not leave the old filter result visible");

  blockCalls = true;
  await event("refresh");
  element("page-size").value = "200";
  await event("page-size", "change");
  releaseCalls();
  await flush();
  assert.equal(queryOf(lastCalls()).get("limit"), "200");
  assert.equal(element("calls").children.length, 125, "in-flight refresh must not render the old page size");
  assert.equal(element("page-info").textContent, "1–125 de 125 · Página 1 de 1");
  assert.equal(element("next").disabled, true);
  console.log("Panel: SIM labels, safe text, page sizes, navigation, dates, DST, exports and in-flight refresh passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
