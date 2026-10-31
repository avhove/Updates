// Offline DOM regression tests. All responses and machines are in memory: no browser or host access.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const root = resolve(__dirname, "..");
const read = (file) => readFileSync(resolve(root, "fleetdeck/static", file), "utf8");
const now = new Date().toISOString();
const flush = () => new Promise((done) => setImmediate(done));

function machine(id, options = {}) {
  const parent = options.parent || id;
  return {
    target: { id, name: id, platform: "proxmox", source: "demo", parent: options.guest ? parent : null,
      kind: options.guest ? "vm" : "host", status: "running", updatable: true, check_only: false,
      can_snapshot: !!options.guest, can_backup: !options.guest, ...options.target },
    check: { os: "Debian", packages: [], notes: [], checked_at: now, ...options.check },
    hidden: false, blocked: null, active_job: null, ...options.view,
  };
}

async function dashboard({ containers = true, dockhandChecks = false, scheduledContainers = false, targets = [], rememberedView = "machines", schedule = null, mobile = false, management = {} } = {}) {
  const { window, document } = parseHTML(read("index.html"));
  const calls = [], errors = [], storage = new Map([["dashboardView", JSON.stringify(rememberedView)]]);
  let activeElement = document.body;
  Object.defineProperty(document, "activeElement", { get: () => activeElement });
  window.HTMLElement.prototype.focus = function () { activeElement = this; };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ right: 900, bottom: 200, top: 175 });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // Linkedom exposes select.value as read-only; model the browser's selected-option behavior.
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return this.querySelector('option[selected]')?.getAttribute('value') || this.querySelector('option')?.getAttribute('value') || ''; },
    set(value) { for (const option of this.querySelectorAll('option')) { if (option.getAttribute('value') === String(value)) option.setAttribute('selected',''); else option.removeAttribute('selected'); } },
  });
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; };
  const data = { targets, errors: {}, settings: { dockhand_poll_seconds: targets.some(v => v.dockhand) ? 300 : null, containers_visible: containers, dockhand_checks_allowed: dockhandChecks, scheduled_container_checks: scheduledContainers, snapshot_before_upgrade: true } };
  const mobileQuery = { matches: mobile, addEventListener: (event, callback) => { mobileQuery.onChange = callback; } };
  const sandbox = {
    window, document, URL, innerWidth: 1200, innerHeight: 800,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: () => 1, clearTimeout: () => {},
    console: { error: (err) => errors.push(err) },
    alert: (text) => errors.push(text), confirm: () => true,
    fetch: async (path, options = {}) => {
      calls.push({ path, ...options });
      let body;
      if (path.startsWith("/api/targets")) body = data;
      else if (path === "/api/jobs") body = [];
      else if (path === "/api/schedule") body = schedule || { check_every: null };
      else if (path.startsWith("/api/setup/docker-management") && !options.method) {
        const id = decodeURIComponent(path.split("target_id=")[1]);
        const v = data.targets.find(v => v.target.id === id);
        body = management[id] || { revision: 'a'.repeat(64), writable: true, mode: v?.dockhand ? 'dockhand' : v?.docker_settings?.mode || 'managed',
          url: v?.dockhand ? 'https://dockhand.example' : '', token_configured: !!v?.dockhand, poll_seconds: 300,
          allow_checks: !!v?.dockhand, environment_id: v?.dockhand ? 1 : null, shared_hosts: v?.dockhand ? 1 : 0, can_restart: true };
      }
      else if (path === "/api/setup/docker-management" && options.method === 'PUT') {
        const value = JSON.parse(options.body);
        management[value.target_id] = { ...value, revision: 'b'.repeat(64), writable: true, token_configured: true, shared_hosts: 1, can_restart: true, restart_pending: true };
        delete management[value.target_id].token;
        body = { saved: true, restart_pending: true, can_restart: true };
      }
      else if (path === "/api/setup/apply") body = { restarting: true };
      else if (path === "/api/docker-settings") body = { docker_settings: JSON.parse(options.body) };
      else if (path === "/api/actions") body = { jobs: [], rejected: {} };
      else if (path === "/api/dockhand/check") body = { started: true };
      else if (path === "/api/monitor-only") body = { monitor_only: [] };
      else if (path === "/api/update-command") body = { update_command: JSON.parse(options.body).command };
      else if (path === "/api/session") body = { login: false };
      else throw new Error(`Unexpected request: ${path}`);
      return { ok: true, json: async () => body };
    },
    location: { hostname: "localhost", protocol: "http:", pathname: "/" },
    matchMedia: (query) => query === "(max-width: 1119px)" ? mobileQuery : { matches: false }, addEventListener: window.addEventListener.bind(window),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(read("format.js"), context);
  vm.runInContext(read("tools.js"), context);
  vm.runInContext(read("theme.js"), context);
  window.dispatchEvent(new window.Event("DOMContentLoaded"));
  vm.runInContext(read("containers.js"), context);
  vm.runInContext(read("app.js"), context);
  vm.runInContext("globalThis.ui = {state, render, load, openMachineMenu, setView}", context);
  await flush();
  assert.deepEqual(errors, [], "dashboard starts without runtime errors");
  const click = (selector) => {
    const el = document.querySelector(selector);
    assert.ok(el, `Missing control ${selector}`);
    el.dispatchEvent(new window.Event("click", { bubbles: true }));
    return el;
  };
  const informationTrigger = id => {
    const panel = document.querySelector('#machine-actions');
    if (panel.hidden || !panel.querySelector(`[data-machine-info="${id}"]`)) click(`[data-machine-menu="${id}"]`);
    return panel.querySelector(`[data-machine-info="${id}"]`);
  };
  return { ...sandbox.ui, document, window, calls, errors, click, informationTrigger, data, setMobile(value) { mobileQuery.matches = value; mobileQuery.onChange?.(); } };
}

test("mobile cards preserve package details, information and confirmation without bulk selection", async () => {
  const node = machine("pve");
  const guest = machine("web", { guest: true, parent: "pve", target: { backup: { last: now, in_job: true, count: 1 } }, check: {
    os: "Debian GNU/Linux 13", reboot_required: true, packages: [
      { name: "openssl", current: "1", available: "2", security: true },
      { name: "curl", current: "1", available: "2" },
    ],
  } });
  const ui = await dashboard({ mobile: true, targets: [node, guest] });
  const doc = ui.document;
  assert.equal(doc.querySelectorAll('.mc-card').length, 2);
  assert.equal(doc.querySelectorAll('[data-select]').length, 0);
  assert.equal(doc.querySelector('[data-machine-row="web"] .mc-status-group .mc-check-time').textContent, "Checked just now");
  assert.equal(doc.querySelector('[data-machine-row="web"] [data-machine-info]'), null);
  assert.equal(doc.querySelector('[data-machine-row="pve"] [data-machine-info]'), null);
  assert.equal(doc.querySelector('[data-machine-row="pve"] .mc-footer'), null, "healthy cards do not reserve an empty action footer");
  assert.equal(doc.querySelectorAll('[data-machine-row="pve"] [data-machine-menu]').length, 1);
  assert.ok(doc.querySelector('[data-machine-row="pve"] .mc-utility-row [data-machine-menu]'));
  assert.equal(doc.querySelector('[data-machine-row="pve"] .mc-check-line [data-machine-menu]'), null);
  assert.ok(doc.querySelector('[data-machine-row="web"] .mc-footer [data-act="upgrade"]'));
  assert.ok(doc.querySelector('[data-machine-row="web"] .mc-reboot [aria-label="Reboot required"]'));
  ui.click('[data-machine-row="web"] [data-toggle]');
  assert.match(doc.querySelector('#packages-web').textContent, /openssl/);
  assert.equal(ui.calls.some(call => call.path === '/api/actions'), false);
  ui.informationTrigger('web'); ui.click('[data-machine-info="web"]');
  assert.match(doc.querySelector('#machine-information').textContent, /Covered by a backup job/);
  ui.click('[data-machine-row="web"] [data-act="upgrade"]');
  assert.equal(doc.querySelector('#confirm').open, true);
  assert.equal(doc.querySelector('#confirm-snapshot').checked, true);
  doc.querySelector('#confirm').close();
  ui.setMobile(false);
  assert.equal(doc.querySelectorAll('.mc-card').length, 0);
  assert.ok(doc.querySelector('[data-select="web"]'));
  ui.state.selected.add('web');ui.render();
  ui.setMobile(true);
  assert.equal(ui.state.selected.size, 0);
  assert.equal(doc.querySelector('#bulk-toolbar').hidden, true);
});

test("absolute dates use year-month-day and 24-hour local time on dashboard and setup", () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read("format.js"), sandbox);
  const format = sandbox.window.FleetdeckDates.dateTime;
  assert.equal(format(new Date(2026, 0, 2, 0, 5, 9).toISOString()), "2026-01-02 00:05:09");
  assert.equal(format(new Date(2026, 9, 29, 17, 29, 35).toISOString()), "2026-10-29 17:29:35");
  assert.equal(format(new Date(2026, 11, 31, 23, 59, 59).toISOString()), "2026-12-31 23:59:59");
  for (const value of [null, "", "invalid"]) assert.equal(format(value), "Unknown date");
  for (const file of ["index.html", "setup.html"]) {
    const html = read(file);
    assert.ok(html.indexOf('/static/format.js') < html.indexOf(`/static/${file === "index.html" ? "app" : "setup"}.js`));
    assert.ok(html.indexOf('/static/tools.js') < html.indexOf(`/static/${file === "index.html" ? "app" : "setup"}.js`));
  }
  for (const file of ["app.js", "setup.js", "tools.js"]) assert.doesNotMatch(read(file), /\.toLocale(?:Date|Time)?String\(/);
});

test("dashboard retains the shared backup dialog and passphrase checks", async () => {
  const ui = await dashboard();
  const doc = ui.document;
  ui.click('#backup');
  assert.equal(doc.querySelector('#backup-dialog').open, true);
  doc.querySelector('#backup-pass').value = 'short';
  await doc.querySelector('#backup-download').onclick();
  assert.match(doc.querySelector('#backup-msg').textContent, /at least 12/);
  doc.querySelector('#restore-ack').checked = true;
  ui.click('#backup');
  assert.equal(doc.querySelector('#restore-ack').checked, false);
  assert.equal(doc.querySelector('#restore-go').disabled, true);
  assert.equal(ui.calls.some(call => call.path === '/api/backup'), false);
});

test("native Docker is available without a global switch and discovered hosts appear automatically", async () => {
  const pending = machine("pve1", { check: { packages: [{ name: "curl", available: "2" }], docker_installed: true } });
  const ui = await dashboard({ targets: [pending, machine("pve2")], rememberedView: "containers" });
  assert.equal(ui.document.querySelector(".view-tabs").hidden, false);
  assert.equal("docker_enabled" in ui.state.settings, false);
  assert.ok(ui.document.querySelector('[data-machine-row="pve1"].container-row'));
  assert.equal(ui.document.querySelector('[data-machine-row="pve2"].container-row'), null);
  ui.click('#view-machines'); ui.click('[data-machine-menu="pve1"]');
  assert.match(ui.document.querySelector('#machine-actions').textContent, /Docker management/);
  assert.equal(ui.calls.some(call => call.method === 'POST'), false);
});

test("host panels and guest rows keep stable order across inventory refreshes", async () => {
  const ui = await dashboard({ targets: [machine("pve2"), machine("guest2", { guest: true, parent: "pve1" }), machine("pve1"), machine("guest1", { guest: true, parent: "pve1" })] });
  const labels = () => [...ui.document.querySelectorAll("#groups .group-head")].map((el) => el.textContent.trim());
  assert.deepEqual(labels(), ["Proxmox pve1", "Proxmox pve2"]);
  const names = [...ui.document.querySelectorAll("#groups [data-machine-menu]")].map((el) => el.dataset.machineMenu);
  assert.deepEqual(names, ["pve1", "guest1", "guest2", "pve2"]);
  assert.equal(ui.document.querySelector('[data-machine-row="pve1"]').classList.contains("has-guests"), true);
  assert.equal(ui.document.querySelector('[data-machine-row="guest1"]').classList.contains("first-guest"), true);
  assert.equal(ui.document.querySelector('[data-machine-row="guest2"]').classList.contains("last-guest"), true);
  const trigger = ui.click('[data-machine-menu="pve1"]');
  ui.state.targets.reverse();
  ui.render();
  assert.deepEqual(labels(), ["Proxmox pve1", "Proxmox pve2"]);
  assert.ok(ui.document.querySelector('[data-machine-menu="pve1"]') === trigger, "polling preserves the menu trigger");
  assert.equal(ui.document.querySelector("#machine-actions").hidden, false);
  ui.document.dispatchEvent(Object.assign(new ui.window.Event("keydown"), { key: "Escape" }));
  assert.equal(ui.document.querySelector("#machine-actions").hidden, true);
  assert.ok(ui.document.activeElement === trigger, "Escape restores focus to the menu trigger");
});

test("bulk actions appear only after selection; updates still require confirmation", async () => {
  const ui = await dashboard({ targets: [machine("guest", { guest: true, parent: "pve1", check: { packages: [{ name: '<img src=x onerror="alert(1)">', current: "1", available: "2" }] } }),
    machine("monitor", { target: { check_only: true } })] });
  const doc = ui.document;
  assert.equal(doc.querySelector("#bulk-toolbar").hidden, true);
  assert.equal(doc.querySelector('[data-select="monitor"]').disabled, true);
  const checkbox = doc.querySelector('[data-select="guest"]');
  checkbox.checked = true;
  checkbox.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  assert.equal(doc.querySelector("#bulk-toolbar").hidden, false);
  assert.equal(doc.querySelector('[data-machine-row="guest"]').classList.contains("is-selected"), true);
  ui.click('[data-toggle="guest"]');
  assert.equal(doc.querySelector(".pkgs img"), null);
  assert.match(doc.querySelector(".pkgs").textContent, /<img src=x/);
  assert.equal(doc.querySelector(".pkgs td[colspan]").getAttribute("colspan"), "7");
  ui.click('[data-act="upgrade"]');
  assert.equal(doc.querySelector("#confirm").open, true);
  assert.equal(doc.querySelector("#confirm-snapshot-row").hidden, false);
  assert.equal(ui.calls.some((call) => call.path === "/api/actions"), false);
  ui.click("#clear-selected");
  assert.equal(doc.querySelector("#bulk-toolbar").hidden, true);
  assert.deepEqual(ui.errors, []);
});

test("update columns separate security, packages and phased updates with only relevant actions", async () => {
  const ui = await dashboard({
    schedule: { check_every: 21600, next_run: new Date(Date.now() + 2 * 3600 * 1000).toISOString(), notify_targets: 1 },
    targets: [
      machine("pve", { target: { can_backup: true }, check: { reboot_required: true, packages: [
        { name: "openssl", current: "1", available: "2", security: true },
        { name: "systemd", current: "1", available: "2" },
        { name: "tzdata", current: "1", available: "2", phased: true },
        { name: "libsystemd0", current: "1", available: "2", phased: true, phased_dependency: true },
      ] } }),
      machine("phased", { guest: true, parent: "pve", check: { reboot_required: false, packages: [
        { name: "firmware", current: "1", available: "2", phased: true },
      ] } }),
      machine("failed", { guest: true, parent: "pve", check: { error: "timeout", packages: [] } }),
      machine("offline", { guest: true, parent: "pve", target: { status: "stopped", updatable: false, note: "not running" } }),
      machine("current", { guest: true, parent: "pve", check: { reboot_required: false, packages: [] } }),
    ],
  });
  const doc = ui.document;
  const headers = [...doc.querySelectorAll(".machine-table > thead .column-headings th")].map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["", "Machine", "Scope", "Status", "Updates", "Checked", "Actions"]);
  assert.equal(doc.querySelectorAll(".machine-table > thead > tr").length, 1);
  assert.equal(doc.querySelectorAll(".machine-table > colgroup > col").length, 7);
  assert.equal(doc.querySelector(".row-actions-heading").textContent, "Actions");
  assert.match(read("style.css"), /\.more-heading, \.dashboard-page td\.more-cell \{ padding-inline: 4px; text-align: center; \}/);
  assert.equal(doc.querySelector('[data-machine-row="pve"] .type-chip').textContent.trim(), "Node");
  assert.equal(doc.querySelector('[data-machine-row="pve"] .update-action-cell [data-act="upgrade"] span').textContent, "Update");
  assert.ok(doc.querySelector('[data-machine-row="pve"] .updates-available .ui-icon'));
  assert.equal(doc.querySelector('[data-machine-row="pve"] [data-label="Reboot"] [data-act="reboot"]'), null);
  assert.ok(doc.querySelector('[data-machine-row="pve"] .reboot-status .ui-icon'));
  assert.equal(doc.querySelector('[data-machine-row="phased"] [data-act="upgrade"]'), null);
  assert.equal(doc.querySelector('[data-machine-row="phased"] .update-metric.phased').textContent.trim(), "1");
  assert.match(doc.querySelector('[data-machine-row="phased"] .update-status-cell').textContent, /Up to date/);
  assert.equal(doc.querySelector('[data-machine-row="failed"] .update-action-cell [data-act="check"] span').textContent, "Retry");
  assert.equal(doc.querySelector('[data-machine-row="offline"] .update-metric'), null);
  assert.match(doc.querySelector('[data-machine-row="offline"] .update-status-cell').textContent, /Not running/);
  assert.ok(doc.querySelector('[data-machine-row="offline"] .update-status-cell .ui-icon'));
  assert.equal(doc.querySelector('[data-machine-row="offline"] .update-status-cell .bad'), null);
  assert.equal(doc.querySelector('[data-machine-row="current"] .update-action-cell .primary-action button'), null);
  assert.match(doc.querySelector('[data-machine-row="current"] .update-status-cell').textContent, /Up to date/);
  assert.equal(doc.querySelectorAll(".update-metric:empty").length, 0);
  assert.match(doc.querySelector("#summary").textContent, /1Machine needing OS updates/);
  assert.match(doc.querySelector("#schedule-status").textContent, /Next check in 2 h/);

  ui.click('[data-machine-row="pve"] .update-metric.security');
  assert.deepEqual([...doc.querySelectorAll("#packages-pve .package-type")].map((el) => el.textContent.trim()), ["Security"]);
  ui.click('[data-machine-menu="pve"]');
  assert.match(doc.querySelector("#machine-actions").textContent, /Reboot/);
  assert.match(doc.querySelector("#machine-actions").textContent, /Check OS updates/);
  assert.match(doc.querySelector("#machine-actions").textContent, /Back up configuration/);
  assert.equal(doc.querySelectorAll("#machine-actions .ui-icon").length >= 3, true);
  assert.equal(doc.querySelector("#machine-actions .menu-caption").textContent.trim(), "pve");
  assert.match(doc.querySelector("#machine-actions").textContent, /Update command…/);
  assert.deepEqual(ui.errors, []);
});

test("compact OS metrics and status open one package list without selection or actions", async () => {
  const ui = await dashboard({ targets: [
    machine("pending", { check: { packages: [{ name: "curl", current: "1", available: "2" }] } }),
    machine("current"), machine("unchecked", { view: { check: null } }),
  ] });
  const doc = ui.document;
  const row = doc.querySelector('[data-machine-row="pending"]');
  assert.equal(row.querySelectorAll(".update-list-hit").length, 1);
  assert.equal(row.querySelector(".update-metric.security"), null);
  assert.equal(doc.querySelector('[data-machine-row="current"] .update-list-hit'), null);
  const status = ui.click('[data-machine-row="pending"] .os-status-hit');
  assert.equal(doc.querySelectorAll("#packages-pending").length, 1);
  assert.match(doc.querySelector("#packages-pending").textContent, /curl/);
  assert.equal(doc.querySelector('[data-machine-row="pending"] .os-status-hit').getAttribute("aria-expanded"), "true");
  assert.equal(ui.state.selected.size, 0);
  assert.equal(ui.calls.some(call => call.method === "POST"), false);
  ui.click('[data-machine-row="pending"] .update-list-hit');
  assert.ok(doc.querySelector("#packages-pending"));
  ui.click('[data-machine-row="pending"] .update-list-hit');
  assert.equal(doc.querySelector("#packages-pending"), null);
  assert.ok(status.getAttribute("aria-controls"));
  assert.ok(doc.querySelector('[data-machine-row="unchecked"] .update-status-cell .ui-icon'));
  assert.deepEqual(ui.errors, []);
});

test("last-known results stay visible without stale update or reboot actions", async () => {
  const last = { checked_at: new Date(Date.now() - 3 * 3600000).toISOString(), reboot_required: true,
    packages: [{ name: '<script>unsafe</script>', current: "1", available: "2", security: true },
      { name: "systemd", current: "1", available: "2", phased: true }] };
  const ui = await dashboard({ targets: [
    machine("failed", { check: { error: "agent <script>unavailable</script>", last_successful: last } }),
    machine("offline", { target: { status: "stopped", updatable: false }, check: last }),
    machine("reboot", { check: { reboot_required: true } }),
    machine("both", { target: { backup: { last: new Date(Date.now() - 14 * 86400000).toISOString(), in_job: true } }, check: { os: "Debian GNU/Linux 13 (trixie)", reboot_required: true, packages: [{ name: "curl", available: "2" }] } }),
    machine("scheduled", { guest: true, target: { backup: { in_job: true, last: null } } }),
  ] });
  const doc = ui.document;
  for (const id of ["failed", "offline"]) {
    const row = doc.querySelector(`[data-machine-row="${id}"]`);
    assert.equal(row.querySelectorAll(".update-metric.stale").length, 2);
    assert.equal(row.querySelector('[data-act="upgrade"]'), null);
    assert.equal(row.querySelector('[data-act="reboot"]'), null);
    assert.equal(row.querySelector(".reboot-status"), null);
    assert.equal(row.querySelector("[data-select]").disabled, true);
  }
  ui.click('[data-machine-row="failed"] .update-metric.security');
  assert.match(doc.querySelector("#packages-failed").textContent, /Last known · 3 h ago/);
  assert.equal(doc.querySelector("#packages-failed script"), null);
  ui.informationTrigger('failed'); ui.click('[data-machine-info=\"failed\"]');
  assert.match(doc.querySelector("#machine-information").textContent, /agent <script>unavailable/);
  assert.equal(doc.querySelector("#machine-information script"), null);
  assert.match(doc.querySelector("#summary").textContent, /2Machines needing OS recheck/);
  assert.equal(doc.querySelectorAll('[data-machine-row="both"] .update-action-cell .primary-action button').length, 1);
  assert.ok(doc.querySelector('[data-machine-row="both"] [data-act="upgrade"]'));
  assert.ok(doc.querySelector('[data-machine-row="both"] .reboot-status'));
  assert.equal(doc.querySelector('[data-machine-row="both"] .backup-cell').textContent.trim(), "2 w ago");
  assert.equal(doc.querySelector('[data-machine-row="both"] .machine-os').textContent, "Debian 13");
  assert.equal(doc.querySelector('[data-machine-row="both"] .machine-os').getAttribute("title"), "Debian GNU/Linux 13 (trixie)");
  ui.click('[data-machine-menu="both"]');
  assert.ok(doc.querySelector('#machine-actions [data-act="reboot"]'));
  ui.click('[data-machine-row="reboot"] [data-act="reboot"]');
  assert.equal(doc.querySelector("#confirm").open, true);
  assert.equal(ui.calls.some((call) => call.path === "/api/actions"), false);
  const scheduled = doc.querySelector('[data-machine-row="scheduled"]');
  assert.equal(scheduled.querySelector(".backup-cell").textContent, "—");
  assert.ok(scheduled.querySelector(".backup-job"));
  assert.ok(scheduled.querySelector(".machine-os"));
  for (const table of doc.querySelectorAll(".machine-table")) {
    const columns = table.querySelectorAll("colgroup col").length;
    let carried = 0;
    for (const row of table.querySelectorAll(":scope > thead > tr")) {
      const span = [...row.children].reduce((n, cell) => n + Number(cell.getAttribute("colspan") || 1), 0);
      assert.equal(span + carried, columns, "merged headers span the same columns as the body");
      carried = [...row.children].filter(cell => cell.getAttribute("rowspan") === "2").length;
    }
    for (const row of table.querySelectorAll(":scope > tbody > tr")) {
      const span = [...row.children].reduce((n, cell) => n + Number(cell.getAttribute("colspan") || 1), 0);
      assert.equal(span, columns, "rows and detail panels span the same columns");
    }
  }
  assert.deepEqual(ui.errors, []);
});

test("KPI filters keep parent context, align all groups and clear selections outside the filter", async () => {
  const sec = machine("sec", { guest: true, parent: "pve", check: { packages: [{ name: "ssl", available: "2", security: true }] } });
  const ordinary = machine("ordinary", { target: { platform: "ssh" }, check: { packages: [{ name: "curl", available: "2" }] } });
  const ui = await dashboard({ targets: [machine("pve", { target: { backup: { last: now } } }), sec, ordinary,
    machine("failed", { guest: true, parent: "pve", check: { error: "agent unavailable" } }),
    machine("restart", { target: { platform: "ssh" }, check: { reboot_required: true } }),
  ] });
  const doc = ui.document;
  const tables = [...doc.querySelectorAll(".machine-table")];
  assert.equal(tables.length, 2);
  assert.equal(tables[0].querySelector("colgroup").innerHTML, tables[1].querySelector("colgroup").innerHTML);
  assert.ok(tables.every((t) => t.classList.contains("has-backup")));
  const check = doc.querySelector('[data-select="ordinary"]'); check.checked = true;
  check.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  ui.click('[data-kpi="security"]');
  assert.equal(ui.state.selected.size, 0);
  assert.deepEqual([...doc.querySelectorAll("[data-machine-row]")].map((r) => r.dataset.machineRow), ["pve", "sec"]);
  assert.ok(doc.querySelector('[data-machine-row="pve"]').classList.contains("is-context"));
  assert.equal(doc.querySelector('[data-select="pve"]').disabled, true);
  assert.equal(doc.querySelector('[data-kpi="security"]').getAttribute("aria-pressed"), "true");
  assert.match(doc.querySelector("#filter-status").textContent, /1 matching machine/);
  assert.match(doc.querySelector('[data-kpi="updates"]').textContent, /2Machines needing OS updates/);
  ui.click('[data-kpi="recheck"]');
  assert.deepEqual([...doc.querySelectorAll("[data-machine-row]")].map((r) => r.dataset.machineRow), ["pve", "failed"]);
  ui.click('[data-kpi="reboot"]');
  assert.deepEqual([...doc.querySelectorAll("[data-machine-row]")].map((r) => r.dataset.machineRow), ["restart"]);
  ui.click('[data-kpi="reboot"]');
  assert.equal(doc.querySelectorAll("[data-machine-row]").length, 5);
  assert.equal(doc.querySelector("#filter-status").hidden, true);
  ui.click('[data-kpi="security"]');
  const box = doc.querySelector('[data-select="sec"]'); box.checked = true;
  box.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  sec.check.packages[0].security = false;
  await ui.load(); ui.render();
  assert.equal(ui.state.selected.size, 0);
  assert.match(doc.querySelector("#groups").textContent, /No matching machines/);
  assert.deepEqual(ui.errors, []);
});

test("update and security KPIs include last-known results without enabling stale actions", async () => {
  const regular = [{ name: "curl", available: "2" }];
  const security = [{ name: "openssl", available: "2", security: true }];
  const ui = await dashboard({ targets: [
    machine("pve"),
    machine("offline", { guest: true, parent: "pve", target: { status: "stopped", updatable: false }, check: { packages: regular } }),
    machine("failed", { guest: true, parent: "pve", check: { error: "agent unavailable", last_successful: { checked_at: now, packages: security } } }),
    machine("ready", { guest: true, parent: "pve", check: { packages: regular } }),
    machine("phased", { check: { packages: [{ name: "systemd", available: "2", phased: true }] } }),
    machine("hidden", { check: { packages: security }, view: { hidden: true } }),
  ] });
  const doc = ui.document;
  assert.match(doc.querySelector('[data-kpi="updates"]').textContent, /3Machines needing OS updates/);
  assert.match(doc.querySelector('[data-kpi="security"]').textContent, /1Machine with OS security updates/);
  assert.match(doc.querySelector('[data-kpi="recheck"]').textContent, /2Machines needing OS recheck/);
  ui.click('[data-kpi="updates"]');
  assert.deepEqual([...doc.querySelectorAll('[data-machine-row]')].map((r) => r.dataset.machineRow), ["pve", "failed", "offline", "ready"]);
  assert.equal(doc.querySelectorAll('[data-act="upgrade"]').length, 1);
  for (const id of ["failed", "offline"]) assert.equal(doc.querySelector(`[data-select="${id}"]`).disabled, true);
  ui.click('[data-kpi="security"]');
  assert.deepEqual([...doc.querySelectorAll('[data-machine-row]')].map((r) => r.dataset.machineRow), ["pve", "failed"]);
  assert.equal(doc.querySelector('[data-act="upgrade"]'), null);
  assert.ok(doc.querySelector('[data-machine-row="failed"] [data-act="check"]'));
  assert.deepEqual(ui.errors, []);
});

test("update confirmation gives each package type its own icon and preserves notes", async () => {
  const ui = await dashboard({ targets: [machine("mixed", { check: { packages: [
    { name: "openssl", security: true, available: "2" },
    { name: "curl", available: "2" },
    { name: "systemd", phased: true, available: "2" },
  ] }, target: { no_reboot: "<b>Keep running</b>" } }), machine("ordinary", { check: { packages: [{ name: "curl", available: "2" }] } })] });
  ui.state.selected.add('mixed');ui.state.selected.add('ordinary');ui.render();
  ui.click('#update-selected');
  const summaries = ui.document.querySelectorAll('.confirm-machine-detail');
  assert.deepEqual([...summaries[0].querySelectorAll('.confirm-update-type')].map(el => el.textContent), ['1 security', '1 package', '1 phased, waiting']);
  for (const summary of summaries) for (const type of summary.querySelectorAll('.confirm-update-type')) assert.equal(type.querySelectorAll('svg').length, 1);
  assert.equal(summaries[1].querySelectorAll('.confirm-update-type').length, 1);
  assert.match(summaries[0].querySelector('.confirm-detail-note').textContent, /<b>Keep running<\/b>/);
  assert.equal(summaries[0].querySelector('b'), null);
  assert.equal(ui.calls.some(call => call.path === '/api/actions'), false);
});

test("update confirmation follows snapshot settings, resets reboot and submits selected choices", async () => {
  const ui = await dashboard({ targets: [machine("vm", { guest: true, parent: "pve", check: { packages: [{ name: "curl", available: "2" }] } }),
    machine("host", { target: { platform: "ssh" }, check: { packages: [{ name: "curl", available: "2" }] } })] });
  const doc = ui.document, dialog = doc.querySelector("#confirm");
  ui.click('[data-machine-row="vm"] [data-act="upgrade"]');
  assert.equal(doc.querySelector("#confirm-title").textContent, "Update machine?");
  assert.equal(doc.querySelector("#confirm-snapshot").checked, true);
  assert.equal(doc.querySelector("#confirm-reboot").checked, false);
  assert.equal(doc.querySelector("#confirm-snapshot-row").hidden, false);
  assert.match(doc.querySelector("#confirm-list").textContent, /vmVM1 package/);
  dialog.returnValue = "ok"; dialog.dispatchEvent(new ui.window.Event("close")); await flush();
  let request = ui.calls.filter((c) => c.path === "/api/actions").at(-1);
  assert.equal(JSON.parse(request.body).snapshot_first, true);
  assert.equal(JSON.parse(request.body).reboot_if_required, false);
  ui.click('[data-machine-row="vm"] [data-act="upgrade"]');
  doc.querySelector("#confirm-snapshot").checked = true;
  const reboot = doc.querySelector("#confirm-reboot"); reboot.checked = true;
  reboot.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  assert.equal(doc.querySelector("#confirm-reboot-note").hidden, false);
  dialog.returnValue = "ok"; dialog.dispatchEvent(new ui.window.Event("close")); await flush();
  request = ui.calls.filter((c) => c.path === "/api/actions").at(-1);
  assert.equal(JSON.parse(request.body).snapshot_first, true);
  assert.equal(JSON.parse(request.body).reboot_if_required, true);
  ui.click('[data-machine-row="host"] [data-act="upgrade"]');
  assert.equal(doc.querySelector("#confirm-snapshot").checked, false);
  assert.equal(doc.querySelector("#confirm-reboot").checked, false);
  assert.equal(doc.querySelector("#confirm-snapshot-row").hidden, true);
  assert.equal(doc.querySelector("#confirm-reboot-note").hidden, true);
  const count = ui.calls.filter((c) => c.path === "/api/actions").length;
  dialog.returnValue = "cancel"; dialog.dispatchEvent(new ui.window.Event("close")); await flush();
  assert.equal(ui.calls.filter((c) => c.path === "/api/actions").length, count);
  for (const id of ["vm", "host"]) {
    const box = doc.querySelector(`[data-select="${id}"]`); box.checked = true;
    box.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  }
  ui.click("#update-selected");
  assert.equal(doc.querySelector("#confirm-title").textContent, "Update 2 machines?");
  assert.equal(doc.querySelectorAll("#confirm-list .confirm-machine").length, 2);
  assert.equal(doc.querySelector("#confirm-snapshot").checked, true);
  assert.equal(doc.querySelector("#confirm-reboot").checked, false);
  assert.equal(doc.querySelector("#confirm-ok").textContent, "Update 2 machines");
  assert.deepEqual(ui.errors, []);
});

test("machine backup context uses neutral information popovers", async () => {
  const unsafeBackupNote = 'Not configured <img src=x onerror="alert(1)">';
  const guestBackupNote = "Some storage details need attention";
  const ui = await dashboard({ targets: [
    machine("pve", {
      target: { backup: { last: null, not_set_up: true, note: unsafeBackupNote } },
      check: { notes: ["Repositories (from PVE): No-Subscription", "Repository refresh needs attention"] },
    }),
    machine("guest", {
      guest: true,
      parent: "pve",
      target: { backup: { last: new Date(Date.now() - 3600 * 1000).toISOString(), storage: "backup", count: 2, in_job: true, note: guestBackupNote } },
    }),
    machine("unscheduled", {
      guest: true,
      parent: "pve",
      target: { backup: { last: null, stale: true, in_job: false, note: "No matching backup job" } },
    }),
    machine("standalone", {
      target: { platform: "ssh", kind: "host", parent: null, backup: { last: null, not_set_up: true, note: "Configure a host backup first" } },
      check: { notes: ["Repository refresh needs attention"] },
    }),
  ] });
  const doc = ui.document;
  const node = doc.querySelector('[data-machine-row="pve"]');
  const guest = doc.querySelector('[data-machine-row="guest"]');
  const unscheduled = doc.querySelector('[data-machine-row="unscheduled"]');
  const standalone = doc.querySelector('[data-machine-row="standalone"]');
  assert.equal(node.querySelector(".backup-cell").textContent.trim(), "");
  assert.equal(node.querySelector(".backup-job-cell").textContent.trim(), "");
  assert.match(guest.querySelector(".backup-cell").textContent, /h ago/);
  assert.equal(guest.querySelector(".backup-cell").hasAttribute("title"), false);
  assert.equal(guest.querySelector(".backup-job").getAttribute("aria-label"), "Covered by a backup job");
  assert.equal(unscheduled.querySelector(".backup-missing").getAttribute("aria-label"), "No backup found");
  assert.equal(unscheduled.querySelector(".backup-job-cell").textContent.trim(), "");
  assert.equal(standalone.querySelector(".backup-missing").getAttribute("aria-label"), "No backup found");
  assert.equal(standalone.querySelector(".backup-job-cell").textContent.trim(), "");
  assert.equal(guest.closest("table").querySelector("th.section-start:nth-last-child(2)").textContent, "Backup");
  const css = read("style.css");
  assert.match(css, /\.backup-job \{ width: 28px; min-height: 28px; justify-content: center; \}/);
  assert.match(css, /\.backup-job-heading, \.dashboard-page \.backup-job-cell \{ padding-inline: 5px; text-align: center; \}/);
  assert.ok(ui.informationTrigger('standalone').querySelector('.repo-note'));
  assert.equal(node.querySelector(".repo-note"), null);
  assert.equal(node.querySelector(".last-check").querySelector(".ui-icon"), null);
  assert.equal(node.querySelector('[data-machine-info]'), null);

  const trigger = ui.informationTrigger('pve');
  assert.ok(trigger);
  assert.equal(trigger.classList.contains("warn"), false);
  assert.equal(trigger.classList.contains("bad"), false);
  assert.equal(trigger.hasAttribute("title"), false);
  ui.informationTrigger('pve'); ui.click('[data-machine-info=\"pve\"]');

  const panel = doc.querySelector("#machine-information");
  assert.equal(panel.hidden, false);
  assert.ok(doc.activeElement === panel, "opening the popover moves focus to its content");
  assert.deepEqual([...panel.querySelectorAll("h3")].map((el) => el.textContent), ["Updates", "Backup", "Repositories"]);
  assert.match(panel.textContent, /Not configured <img src=x onerror="alert\(1\)">/);
  assert.match(panel.textContent, /Repositories \(from PVE\): No-Subscription/);
  assert.equal(panel.querySelector("img"), null, "information remains escaped");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");

  doc.dispatchEvent(Object.assign(new ui.window.Event("keydown"), { key: "Escape" }));
  assert.equal(panel.hidden, true);
  assert.ok(doc.activeElement === node.querySelector("[data-machine-menu]"), "Escape returns focus to the visible More button");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  const guestTrigger = ui.informationTrigger('guest');
  assert.ok(guestTrigger);
  ui.informationTrigger('guest'); ui.click('[data-machine-info=\"guest\"]');
  assert.equal(panel.querySelector("#machine-information-title").textContent, "Machine information");
  assert.deepEqual([...panel.querySelectorAll("h3")].map((el) => el.textContent), ["Updates", "Backup"]);
  assert.match(panel.textContent, /Some storage details need attention/);
  assert.match(panel.textContent, /2 backups found/);
  assert.match(panel.textContent, /Covered by a backup job/);

  const unscheduledTrigger = ui.informationTrigger('unscheduled');
  assert.ok(unscheduledTrigger);
  ui.informationTrigger('unscheduled'); ui.click('[data-machine-info=\"unscheduled\"]');
  assert.match(panel.textContent, /No matching backup job/);
  assert.match(panel.textContent, /No backup job covers this machine/);

  const standaloneTrigger = ui.informationTrigger('standalone');
  assert.ok(standaloneTrigger);
  ui.informationTrigger('standalone'); ui.click('[data-machine-info=\"standalone\"]');
  assert.equal(panel.querySelector("#machine-information-title").textContent, "Machine information");
  assert.deepEqual([...panel.querySelectorAll("h3")].map((el) => el.textContent), ["Updates", "Backup", "Repositories"]);
  assert.match(panel.textContent, /Configure a host backup first/);
  assert.deepEqual(ui.errors, []);
});

test("dashboard menu uses the compact simple list and preserves hidden-view state", async () => {
  const ui = await dashboard({
    schedule: { check_every: 21600, notify_targets: 1 },
    targets: [machine("visible"), machine("hidden", { view: { hidden: true } })],
  });
  const doc = ui.document;
  const summary = doc.querySelector("#dashboard-menu > summary");
  assert.ok(summary.querySelector(".ui-icon"));
  assert.doesNotMatch(summary.textContent, /⋯|…/);
  assert.equal(summary.getAttribute("aria-label"), "More options");
  assert.deepEqual(
    [...doc.querySelectorAll(".dashboard-menu-item")].map((el) => el.textContent.trim().replace(/\s+/g, " ")),
    ["Machines", "Settings", "Refresh inventory", "Check OS updates", "Check container updates", "Show hidden machines1", "Back up & restore", "Test notifications"],
  );
  const toggle = doc.querySelector("#show-hidden");
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(doc.querySelector('[data-machine-row="hidden"]'), null);
  ui.click("#show-hidden");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.ok(doc.querySelector('[data-machine-row="hidden"]'));
  assert.deepEqual(ui.errors, []);
});

test("cluster hierarchy uses the approved compact continuous tree geometry", () => {
  const css = read("style.css");
  assert.match(css, /--tree-line: 2px; --guest-indent: 26px; --guest-branch: 18px; --guest-curve: 11px;/);
  assert.match(css, /tr\.guest\.last-guest \.machine-cell::after \{ bottom: calc\(50% \+ var\(--guest-curve\)\); \}/);
  assert.match(css, /th\.update-heading, \.dashboard-page td\.update-metric-cell \{ padding-inline: 5px; text-align: center; \}/);
  assert.match(css, /\.dot\.off \{ background: var\(--bad\); box-shadow: 0 0 0 3px color-mix\(in srgb, var\(--bad\) 20%, transparent\); \}/);
});

test("optional Docker status is separate, honest about failed checks, and never auto-pulls", async () => {
  const stacks = { docker: "yes", compose: "v2", checked_at: now, stacks: [
    { name: "unreachable", state: "running", error: "registry unavailable", services: [], update_available: true },
  ] };
  const ui = await dashboard({ targets: [machine("docker-vm", { target: { backup: { last: now, storage: "/backup", count: 1, stale: false } }, check: { docker_installed: true }, view: { stacks } }), machine("plain", { check: { docker_installed: false } })] });
  assert.equal(ui.document.querySelector(".view-tabs").hidden, false);
  const dockerTable = ui.document.querySelector('[data-machine-row="docker-vm"]').closest("table");
  assert.equal(dockerTable.classList.contains("has-backup"), true);
  assert.equal(dockerTable.classList.contains("has-containers"), true);
  assert.equal(dockerTable.querySelectorAll("colgroup > col").length, 8);
  assert.equal(ui.document.querySelectorAll('.container-indicator[data-open-docker][data-container-filter="updates"]').length, 1);
  ui.click('[data-open-docker="docker-vm"]');
  assert.equal(ui.document.querySelector("#groups").hidden, false);
  assert.match(ui.document.querySelector(".container-detail").textContent, /Stack image check failed/);
  assert.equal(ui.document.querySelector('.container-status-hit[data-open-docker="docker-vm"]').getAttribute('aria-expanded'), 'true');
  assert.equal(ui.document.querySelectorAll("[data-stack]").length, 0);
  assert.equal(ui.calls.some((call) => call.path === "/api/actions"), false);
  ui.click("[data-fetch-docker]");
  assert.match(ui.document.querySelector("#confirm-text").textContent, /Downloads \(pulls\)/);
  assert.equal(ui.calls.some((call) => call.path === "/api/actions"), false);
});

test("favicon and clickable Fleetdeck logo are present", async () => {
  const ui = await dashboard();
  assert.equal(ui.document.querySelector('link[rel="icon"]').getAttribute("href"), "/static/favicon.svg");
  assert.equal(ui.document.querySelector("h1 a").getAttribute("href"), "/");
  assert.equal(ui.document.querySelector("h1 a").getAttribute("aria-label"), "Fleetdeck dashboard");
});

test("Dockhand works with native Docker disabled and expands escaped standalone status without writes", async () => {
  const target = machine("docker", { view: {
    docker_settings: { mode: "external", manager_name: "Dockhand", manager_url: "https://dockhand.example" },
    dockhand: { synced_at: now, stale: false, error: null, containers: [
      { name: '<script>bad</script>', image: 'example/image:latest', state: 'running', stack: null, status: 'update', checked_at: now },
      { name: 'web', image: 'web:latest', state: 'running', stack: 'media', status: 'unknown' },
      { name: 'last', image: 'test:latest', state: 'running', stack: 'Zeta', status: 'unknown' },
      { name: 'alpha-b', image: 'test:latest', state: 'running', stack: 'alpha', status: 'unknown' },
      { name: 'alpha-a', image: 'test:latest', state: 'running', stack: 'alpha', status: 'unknown' },
    ] },
  } });
  for (const mobile of [false, true]) {
    const ui = await dashboard({ containers: true, targets: [target], mobile });
    assert.equal(ui.document.querySelector('.view-tabs').hidden, false);
    const hit = ui.document.querySelector('.container-indicator[data-open-docker="docker"]');
    assert.match(hit.textContent, /1/);
    assert.match(hit.getAttribute('aria-label'), /externally by Dockhand/);
    assert.equal(ui.document.querySelectorAll('[data-stack]').length, 0);
    ui.click('[data-open-docker="docker"]');
    const detail = ui.document.querySelector(mobile ? '.mc-container-panel' : '.container-detail');
    assert.equal(detail.querySelectorAll('.dockhand-table').length, 1);
    assert.deepEqual([...detail.querySelectorAll('thead th')].map(c => c.textContent), ['Container', 'Stack', 'Image', 'Status', 'Last checked']);
    assert.deepEqual([...detail.querySelectorAll('td[data-label="Stack"]')].map(c => c.textContent), ['alpha', 'alpha', 'media', 'Standalone', 'Zeta']);
    assert.deepEqual([...detail.querySelectorAll('.dockhand-name')].slice(0, 2).map(c => c.firstChild.textContent), ['alpha-a', 'alpha-b']);
    assert.match(detail.textContent, /Check result unavailable/);
    assert.equal(detail.querySelector('script'), null);
    assert.equal(ui.calls.some(c => c.path === '/api/actions'), false);
    ui.click('[data-open-docker="docker"]');
    assert.equal(ui.document.querySelector(mobile ? '.mc-container-panel' : '.container-detail'), null);
    assert.deepEqual(ui.errors, []);
  }
});

test("native Docker counts services, distinguishes missing Compose coverage and keeps Update label", async () => {
  const stacks = { docker: 'yes', compose: 'v2', checked_at: now, stacks: [
    { name: 'media', state: 'running', update_available: true, services: [
      { name: 'web', status: 'running', outdated: true }, { name: 'worker', status: 'running', outdated: true },
    ] },
  ] };
  const ui = await dashboard({ targets: [
    machine('native', { view: { stacks }, check: { packages: [{ name: 'curl', current: '1', available: '2' }] } }),
    machine('empty', { view: { stacks: { ...stacks, stacks: [] } } }),
  ] });
  assert.match(ui.document.querySelector('.container-indicator[data-open-docker="native"]').textContent, /2/);
  assert.match(ui.document.querySelector('.container-indicator[data-open-docker="empty"]').textContent, /—/);
  ui.click('[data-open-docker="empty"]');
  assert.match(ui.document.querySelector('.container-detail').textContent, /Standalone containers are not checked/);
  assert.equal(ui.document.querySelectorAll('.scope-cell').length, 4);
  assert.equal(ui.document.querySelector('[data-act="upgrade"]').textContent, 'Update');
  ui.click('[data-act="upgrade"]');
  assert.match(ui.document.querySelector('#confirm-text').textContent, /Container images are managed separately/);
  assert.equal(ui.calls.some(c => c.path === '/api/actions'), false);
});

test("a failed Dockhand sync shows unknown while retaining last-known results", async () => {
  const ui = await dashboard({ containers: true, targets: [machine('stale', { view: {
    docker_settings: { mode: 'external', manager_name: 'Dockhand', manager_url: 'https://dockhand.example' },
    dockhand: { synced_at: now, stale: true, error: 'Dockhand status unavailable', containers: [
      { name: 'old', image: 'old:latest', state: 'running', status: 'update', stack: null, checked_at: now },
    ] },
  } })] });
  assert.match(ui.document.querySelector('.container-indicator[data-open-docker="stale"]').textContent, /1/);
  ui.click('[data-open-docker="stale"]');
  assert.match(ui.document.querySelector('.container-detail').textContent, /last-known results/);
  assert.match(ui.document.querySelector('.container-detail').textContent, /old:latest/);
  assert.equal(ui.calls.some(c => c.path === '/api/actions'), false);
});

test("Dockhand checks require opt-in and confirmation, then use only the mapped check endpoint", async () => {
  const target = machine('dockhand-check', { view: {
    docker_settings: { mode: 'external', manager_name: 'Dockhand', manager_url: 'https://dockhand.example' },
    dockhand: { synced_at: now, stale: false, containers: [
      { name: 'web', image: 'web:latest', state: 'running', stack: null, status: 'unknown' },
    ] },
  } });
  const off = await dashboard({ containers: true, targets: [target] });
  off.click('[data-open-docker="dockhand-check"]');
  assert.equal(off.document.querySelector('[data-dockhand-check]').disabled, true);
  assert.equal(off.calls.some(c => c.path === '/api/dockhand/check'), false);
  const ui = await dashboard({ containers: true, dockhandChecks: true, targets: [target] });
  ui.click('[data-open-docker="dockhand-check"]');
  ui.click('.container-detail [data-dockhand-check]');
  assert.equal(ui.document.querySelector('#confirm').open, true);
  assert.match(ui.document.querySelector('#confirm-text').textContent, /not restarted/);
  assert.equal(ui.calls.some(c => c.path === '/api/dockhand/check'), false);
  const dialog = ui.document.querySelector('#confirm');
  dialog.returnValue = 'cancel'; dialog.dispatchEvent(new ui.window.Event('close')); await flush();
  assert.equal(ui.calls.some(c => c.path === '/api/dockhand/check'), false);
  ui.click('.container-detail [data-dockhand-check]');
  dialog.returnValue = 'ok'; dialog.dispatchEvent(new ui.window.Event('close')); await flush();
  const writes = ui.calls.filter(c => c.path === '/api/dockhand/check');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.deepEqual(JSON.parse(writes[0].body), { target_id: 'dockhand-check' });
  assert.equal(ui.calls.some(c => c.path === '/api/actions'), false);
  target.dockhand.checking = true;
  ui.render();
  assert.equal(ui.document.querySelector('[data-dockhand-check]').disabled, true);
  assert.match(ui.document.querySelector('.container-detail').textContent, /Checking container images/);
  target.dockhand.checking = false;
  target.dockhand.last_check_at = now;
  target.dockhand.containers[0].status = 'current';
  ui.render();
  assert.match(ui.document.querySelector('.container-indicator[data-open-docker]').textContent, /0/);
  assert.match(ui.document.querySelector('.container-detail').textContent, /Up to date/);
  target.dockhand.containers[0].status = 'failed';
  ui.render();
  assert.match(ui.document.querySelector('.container-detail').textContent, /Check failed/);
  assert.match(ui.document.querySelector('.container-indicator[data-open-docker]').textContent, /—/);
  assert.deepEqual(ui.errors, []);
});


test("configuration monitor-only policy remains read-only on both layouts", async () => {
  for (const mobile of [false, true]) {
    const target = machine("appliance", { target: { monitor_only: true }, view: { monitor_only: true }, check: {
      packages: [{ name: "curl", current: "1", available: "2" }], reboot_required: true,
    } });
    const ui = await dashboard({ targets: [target], mobile });
    const row = ui.document.querySelector('[data-machine-row="appliance"]');
    const badge = row.querySelector('.monitor-policy[aria-label="Monitor only"]');
    assert.ok(badge);
    assert.equal(badge.previousElementSibling.classList.contains(mobile ? "machine-os" : "type-chip"), true);
    assert.equal(badge.nextElementSibling, null);
    assert.equal(badge.textContent.trim(), "");
    ui.informationTrigger('appliance'); ui.click('[data-machine-info=\"appliance\"]');
    assert.match(ui.document.querySelector('#machine-information').textContent, /Update policy is managed in configuration/);
    assert.equal(row.querySelector('[data-act="upgrade"]'), null);
    assert.ok(row.querySelector('[data-act="reboot"]'));
    if (!mobile) assert.ok(row.querySelector('[data-select]').disabled);
    ui.click('[data-machine-menu="appliance"]');
    assert.equal(ui.document.querySelector('[data-monitor]').disabled, true);
    assert.equal(ui.calls.some(c => c.path === '/api/monitor-only'), false);
  }
});

test("one header and independent scope rows share machine identity and backup context", async () => {
  for (const backup of [false, true]) for (const containers of [false, true]) {
    const ui = await dashboard({ docker: containers, containers, targets: [machine('containers-production-primary', {
      target: backup ? { backup: { last: now, in_job: true } } : {},
      check: { os: 'Ubuntu 24.04.1 LTS', community_script: 'demo-app', docker_installed: containers },
      view: { runs_dashboard: true },
    })] });
    const table = ui.document.querySelector('.machine-table');
    const row = table.querySelector('.machine-row'), second = table.querySelector('.container-row');
    assert.equal(row.querySelector('.machine-name').textContent, 'containers-production-primary');
    assert.ok(row.querySelector('.machine-identity .type-chip'));
    assert.match(row.querySelector('.machine-identity').textContent, /dashboard.*helper script/);
    assert.equal(row.querySelector('.machine-meta').textContent, 'Ubuntu 24.04.1');
    assert.equal(row.querySelector('.machine-meta').children.length, 1);
    assert.equal(table.querySelectorAll('thead tr').length, 1);
    assert.deepEqual([...table.querySelectorAll('thead th')].map(h => h.textContent), ['', 'Machine', 'Scope', 'Status', 'Updates', 'Checked', ...(backup ? ['Backup'] : []), 'Actions']);
    assert.equal(row.querySelector('.machine-cell').getAttribute('rowspan'), containers ? '2' : null);
    assert.equal(row.querySelector('.last-check').getAttribute('data-label'), 'OS checked');
    assert.ok(row.querySelector('.update-action-cell').classList.contains('section-start'));
    if (backup) assert.equal(row.querySelector('.backup-cell').getAttribute('rowspan'), containers ? '2' : null);
    if (containers) {
      assert.ok(second.querySelector('.containers-cell'));
      assert.equal(second.querySelector('.container-check').getAttribute('data-label'), 'Containers checked');
      assert.equal(second.querySelector('.machine-cell'), null);
      assert.equal(second.querySelector('.backup-cell'), null);
      assert.equal(second.querySelector('[data-act="upgrade"]'), null);
    } else assert.equal(second, null);
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  }
});

test("Dockhand explains read-only sync, saved history and explicit fresh checks in its details", async () => {
  for (const mobile of [false, true]) {
    const dh = { manager_url: 'https://dockhand.example', synced_at: now, stale: false,
      scheduled_check_at: now, scheduled_status: 'success', scheduled_checked: 2, scheduled_errors: 1,
      history_error: 'History warning <script>not HTML</script>', containers: [
        { name: 'web', image: 'web:latest', state: 'running', status: 'current', checked_at: now, source: 'dockhand_schedule' },
      ] };
    const ui = await dashboard({ containers: true, mobile, targets: [machine('docker', { view: {
      dockhand: dh, docker_settings: { mode: 'external', manager_name: 'Dockhand' },
    } })] });
    ui.click('[data-open-docker="docker"]');
    const panel = ui.document.querySelector(mobile ? '.mc-container-panel' : '.container-detail');
    assert.match(panel.textContent, /Dockhand’s own schedule is unchanged/);
    assert.match(panel.textContent, /Refresh inventory and dashboard polling only read saved reports/);
    assert.match(panel.textContent, /saved across Fleetdeck restarts/);
    assert.match(panel.textContent, /Completed with 1 error/);
    assert.match(panel.textContent, /Unknown means no reliable result/);
    assert.equal(panel.querySelector('script'), null);
    assert.equal(panel.querySelector('[data-label="Last checked"]').title, 'From Dockhand scheduled-check history');
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
    assert.equal(panel.querySelector('[data-dockhand-check]').disabled, true);
  }
});

test("Refresh inventory stays read-only even when fresh Dockhand checks are enabled", async () => {
  for (const allowed of [false, true]) {
    const ui = await dashboard({ containers: true, dockhandChecks: allowed, targets: [machine('mapped', { view: {
      dockhand: { manager_url: 'https://dockhand.example', stale: false, containers: [] },
    } })] });
    assert.equal(ui.document.querySelector('#refresh span').textContent, 'Refresh inventory');
    assert.equal(ui.document.querySelector('#check-all').getAttribute('aria-label'), 'Check all');
    assert.equal(ui.document.querySelector('#check-all span').textContent, 'Check all');
    const before = ui.calls.filter(c => c.path === '/api/targets?refresh=true').length;
    await Promise.all([ui.document.querySelector('#refresh').onclick(), ui.document.querySelector('#refresh').onclick()]);
    assert.equal(ui.calls.filter(c => c.path === '/api/targets?refresh=true').length, before + 1);
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
    assert.equal(ui.document.querySelector('#refresh').disabled, false);
  }
});

test("top Check all checks OS and Dockhand; row Update remains OS only", async () => {
  const target = machine('docker', { check: { packages: [{ name: 'curl', current: '1', available: '2' }] }, view: {
    dockhand: { manager_url: 'https://dockhand.example', stale: false, containers: [] },
  } });
  const ui = await dashboard({ containers: true, dockhandChecks: true, targets: [target] });
  await ui.document.querySelector('#check-all').onclick();
  const os = ui.calls.filter(c => c.path === '/api/actions');
  const docker = ui.calls.filter(c => c.path === '/api/dockhand/check');
  assert.equal(os.length, 1);
  assert.equal(JSON.parse(os[0].body).action, 'check');
  assert.equal(docker.length, 1);
  assert.deepEqual(JSON.parse(docker[0].body), { target_id: 'docker' });
  assert.equal(ui.document.querySelector('#check-all').disabled, false);
  ui.calls.length = 0;
  ui.click('[data-act="upgrade"]');
  const dialog = ui.document.querySelector('#confirm');
  dialog.returnValue = 'ok'; dialog.dispatchEvent(new ui.window.Event('close')); await flush();
  assert.equal(ui.calls.some(c => c.path === '/api/dockhand/check'), false);
  assert.equal(JSON.parse(ui.calls.find(c => c.path === '/api/actions').body).action, 'upgrade');
});

test("menu OS and container checks have separate scopes and preserve opt-in", async () => {
  for (const allowed of [false, true]) {
    const ui = await dashboard({ containers: true, dockhandChecks: allowed, targets: [machine('docker', { view: {
      dockhand: { manager_url: 'https://dockhand.example', stale: false, containers: [] },
    } })] });
    assert.equal(ui.document.querySelector('#check-containers').hidden, false);
    assert.equal(ui.document.querySelector('#check-containers').disabled, !allowed);
    await ui.document.querySelector('#check-os').onclick();
    assert.equal(ui.calls.filter(c => c.path === '/api/actions').length, 1);
    assert.equal(ui.calls.some(c => c.path === '/api/dockhand/check'), false);
    ui.calls.length = 0;
    await ui.document.querySelector('#check-containers').onclick();
    assert.equal(ui.calls.some(c => c.path === '/api/actions'), false);
    assert.equal(ui.calls.filter(c => c.path === '/api/dockhand/check').length, allowed ? 1 : 0);
  }
});

test("a newer confirmed manual check remains usable when schedule history is unavailable", async () => {
  const ui = await dashboard({ containers: true, targets: [machine('docker', { view: {
    docker_settings: { mode: 'external', manager_name: 'Dockhand' },
    dockhand: { manager_url: 'https://dockhand.example', stale: false, history_error: 'Read access unavailable',
      last_check_at: now, scheduled_status: 'failed', scheduled_check_at: '2026-01-01T00:00:00Z', containers: [
        { name: 'web', image: 'web:latest', state: 'running', status: 'current', checked_at: now, source: 'fleetdeck_button' },
      ] },
  } })] });
  assert.match(ui.document.querySelector('.container-indicator[data-open-docker]').textContent, /0/);
  assert.doesNotMatch(ui.document.querySelector('.container-indicator[data-open-docker]').textContent, /\?/);
});

test("per-machine menu separates OS and Dockhand checks and targets only the selected machine", async () => {
  for (const mobile of [false, true]) {
    const target = id => machine(id, { view: { dockhand: { manager_url: 'https://dockhand.example', stale: false, containers: [] } } });
    const ui = await dashboard({ containers: true, dockhandChecks: true, mobile, targets: [target('docker-a'), target('docker-b')] });
    const open = () => ui.click('[data-machine-menu="docker-a"]');
    open();
    assert.match(ui.document.querySelector('#machine-actions').textContent, /Check OS updates.*Check container updates/);
    ui.click('#machine-actions [data-act="check"]'); await flush();
    let writes = ui.calls.filter(c => c.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/api/actions');
    assert.deepEqual(JSON.parse(writes[0].body).target_ids, ['docker-a']);
    ui.calls.length = 0;
    open(); ui.click('#machine-actions [data-act="dockhand"]');
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
    const dialog = ui.document.querySelector('#confirm');
    dialog.returnValue = 'cancel'; dialog.dispatchEvent(new ui.window.Event('close')); await flush();
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
    open(); ui.click('#machine-actions [data-act="dockhand"]');
    dialog.returnValue = 'ok'; dialog.dispatchEvent(new ui.window.Event('close')); await flush();
    writes = ui.calls.filter(c => c.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/api/dockhand/check');
    assert.deepEqual(JSON.parse(writes[0].body), { target_id: 'docker-a' });
    ui.data.settings.dockhand_checks_allowed = false;
    open(); assert.equal(ui.document.querySelector('#machine-actions [data-act="dockhand"]').disabled, true);
    ui.click('[data-machine-menu="docker-a"]');
    ui.data.settings.dockhand_checks_allowed = true;
    ui.state.targets.find(v => v.target.id === 'docker-a').dockhand.checking = true;
    open(); assert.equal(ui.document.querySelector('#machine-actions [data-act="dockhand"]').disabled, true);
    assert.deepEqual(ui.errors, []);
  }
});

test("native container menu keeps its pull confirmation and disappears when Docker is disabled", async () => {
  for (const docker of [false, true]) {
    const ui = await dashboard({ targets: [machine('native', { check: { docker_installed: true }, view: { docker_settings: { mode: docker ? "managed" : "disabled" } } })] });
    ui.click('[data-machine-menu="native"]');
    const check = ui.document.querySelector('#machine-actions [data-act="stacks"]');
    if (!docker) { assert.equal(check, null); continue; }
    assert.equal(check.textContent, 'Check container updates');
    ui.click('#machine-actions [data-act="stacks"]');
    assert.equal(ui.document.querySelector('#confirm').open, true);
    assert.match(ui.document.querySelector('#confirm-text').textContent, /pull|download/i);
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  }
});

test("compound container indicators preserve updates, version advisories, coverage and failures independently", async () => {
  const rows = [
    { name: 'both', stack: 'app', image: 'example/app:1', state: 'running', status: 'update', image_update: true, newer_version: '2', advisory: true, checked_at: now },
    { name: 'failed-known', image: 'example/known:1', state: 'running', status: 'failed', image_update: true, newer_version: '2', check_issue: 'rate_limit', reported_at: '2026-01-01T00:00:00Z', checked_at: now },
    { name: 'local', image: 'fleetdeck-local:ui-v1', state: 'running', status: 'local', checked_at: now },
    { name: 'excluded', image: 'example/excluded:1', state: 'running', status: 'excluded' },
    { name: 'replacement', image: 'example/new:1', state: 'running', status: 'unknown' },
    { name: 'held', image: 'example/held:1', state: 'running', status: 'deferred', image_update: false, deferred_hours: 6, checked_at: now },
    { name: 'pinned', image: 'example/pinned:1@sha256:demo', state: 'running', status: 'advisory', image_update: false, pinned_digest: true, checked_at: now },
  ];
  for (const mobile of [false, true]) {
    const ui = await dashboard({ containers: true, mobile, targets: [machine('mixed', { view: {
      dockhand: { synced_at: now, stale: false, containers: rows }, docker_settings: { mode: 'external', manager_name: 'Dockhand' },
    } })] });
    const badge = filter => ui.document.querySelector(`.container-indicator[data-open-docker="mixed"][data-container-filter="${filter}"]`);
    assert.equal(badge('updates').textContent, '2');
    assert.equal(badge('review').textContent, '4');
    assert.equal(badge('coverage').textContent, '3');
    assert.equal(badge('failures').textContent, '1');
    ui.click('[data-open-docker="mixed"][data-container-filter="review"]');
    const selector = mobile ? '.mc-container-panel' : '.container-detail';
    let panel = ui.document.querySelector(selector);
    assert.equal(panel.querySelectorAll('.container-results-table tbody tr').length, 4);
    assert.match(panel.textContent, /Newer version: 2/);
    assert.match(panel.textContent, /Pinned digest moved/);
    assert.match(panel.textContent, /6 h cooldown/);
    assert.equal(panel.querySelector('.container-help').hasAttribute('open'), false);
    ui.click(`${selector} [data-container-view-filter="failures"]`);
    panel = ui.document.querySelector(selector);
    assert.equal(panel.querySelectorAll('.container-results-table tbody tr').length, 1);
    assert.match(panel.textContent, /Image update reported.*last known/);
    assert.match(panel.textContent, /registry rate limit/);
    ui.click(`${selector} [data-container-view-filter="coverage"]`);
    panel = ui.document.querySelector(selector);
    assert.equal(panel.querySelectorAll('.container-results-table tbody tr').length, 3);
    assert.match(panel.textContent, /no registry comparison/);
    assert.match(panel.textContent, /Excluded by policy/);
    assert.match(panel.textContent, /Check result unavailable/);
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  }
});

test("local-only and offline cases keep coverage and connection separate from counts", async () => {
  const ui = await dashboard({ containers: true, targets: [
    machine('healthy-local', { view: { dockhand: { stale: false, containers: [
      { name: 'good', image: 'good:latest', status: 'current', checked_at: now },
      { name: 'local', image: 'local:1', status: 'local', checked_at: now },
    ] } } }),
    machine('unreachable', { view: { dockhand: { stale: true, error: 'Cannot connect', containers: [] } } }),
    machine('checking', { view: { dockhand: { checking: true, stale: false, containers: [
      { name: 'old', image: 'old:1', status: 'update', checked_at: now },
    ] } } }),
  ] });
  assert.equal(ui.document.querySelector('.container-indicator[data-open-docker="healthy-local"][data-container-filter="updates"]').textContent, '0');
  assert.equal(ui.document.querySelector('.container-indicator[data-open-docker="healthy-local"][data-container-filter="coverage"]').textContent, '1');
  assert.match(ui.document.querySelector('.container-indicator[data-open-docker="unreachable"]').textContent, /—/);
  assert.ok(ui.document.querySelector('.container-indicator[data-open-docker="checking"] .update-metric'));
  ui.click('[data-open-docker="checking"]');
  assert.match(ui.document.querySelector('.container-detail').textContent, /Previous results remain last-known/);
});

test("mixed-provider bulk checks require native pull confirmation and preserve each provider scope", async () => {
  const stacks = { docker: 'yes', compose: 'v2', checked_at: now, stacks: [
    { name: 'app', state: 'running', update_available: true, services: [
      { name: 'web', image: 'example/web:1', status: 'running', outdated: true },
    ] },
  ] };
  const targets = [machine('native', { check: { docker_installed: true }, view: { stacks } }),
    machine('external', { view: { dockhand: { stale: false, containers: [] }, docker_settings: { mode: 'external' } } })];
  const ui = await dashboard({ containers: true, dockhandChecks: true, targets });
  assert.equal(ui.document.querySelector('#check-containers').disabled, false);
  await ui.document.querySelector('#check-containers').onclick();
  assert.match(ui.document.querySelector('#confirm-text').textContent, /download \(pull\).*Dockhand/i);
  assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  const dialog = ui.document.querySelector('#confirm');
  dialog.returnValue = 'cancel'; dialog.dispatchEvent(new ui.window.Event('close')); await flush();
  assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  await ui.document.querySelector('#check-containers').onclick();
  dialog.returnValue = 'ok'; dialog.dispatchEvent(new ui.window.Event('close')); await flush();
  const native = ui.calls.find(c => c.path === '/api/actions');
  assert.equal(JSON.parse(native.body).action, 'stacks');
  assert.deepEqual(JSON.parse(native.body).target_ids, ['native']);
  const external = ui.calls.find(c => c.path === '/api/dockhand/check');
  assert.deepEqual(JSON.parse(external.body), { target_id: 'external' });
  ui.click('[data-open-docker="native"]');
  const detail = ui.document.querySelector('.container-detail');
  assert.match(detail.textContent, /Fleetdeck native/);
  assert.match(detail.textContent, /Standalone containers are outside/);
  assert.match(detail.textContent, /newer-version-tag advisories are not provided/);
  assert.ok(detail.querySelector('[data-stack="app"]'));
  assert.equal(detail.querySelector('[data-dockhand-check]'), null);
});


test("shared native details keep monitor, check-only and dashboard deployment guards", async () => {
  const stack = { name: 'app', state: 'running', update_available: true, services: [
    { name: 'web', image: 'web:1', status: 'running', outdated: true },
  ] };
  for (const variant of ['monitor', 'check-only', 'dashboard', 'blocked']) {
    const target = machine('native', { target: { check_only: variant === 'check-only' },
      check: { docker_installed: true }, view: {
        monitor_only: variant === 'monitor', blocked: variant === 'blocked' ? 'Host busy' : null,
        docker_settings: { mode: variant === 'monitor' ? 'monitor' : 'managed' },
        stacks: { docker: 'yes', compose: 'v2', checked_at: now, stacks: [{ ...stack, is_dashboard: variant === 'dashboard' }] },
      } });
    const ui = await dashboard({ containers: true, targets: [target] });
    ui.click('[data-open-docker="native"]');
    const panel = ui.document.querySelector('.container-detail');
    const deploy = panel.querySelector('[data-stack="app"]');
    assert.ok(!deploy || deploy.disabled, variant);
    if (variant === 'dashboard') assert.match(panel.textContent, /Update externally/);
    if (variant === 'check-only') assert.equal(panel.querySelector('[data-act="stacks"]').disabled, true);
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  }
});

test("OS and container rows own their timestamps and actions; syncing never counts as checking", async () => {
  const osAt = new Date(Date.now() - 300000).toISOString(), containerAt = new Date(Date.now() - 7200000).toISOString();
  const target = machine('apps', { target: { backup: { last: now, in_job: true } }, check: {
    checked_at: osAt, packages: [{ name: 'curl', current: '1', available: '2' }],
  }, view: { docker_settings: { mode: 'external', manager_name: 'Dockhand', manager_url: 'https://dockhand.example' },
    dockhand: { synced_at: now, last_check_at: now, stale: false, containers: [
      { name: 'web', image: 'web:1', status: 'update', checked_at: containerAt },
    ] } } });
  for (const mobile of [false, true]) {
    const ui = await dashboard({ containers: true, dockhandChecks: true, mobile, targets: [target] });
    const os = ui.document.querySelector(mobile ? '.mc-os-scope' : '.scope-os');
    const containers = ui.document.querySelector(mobile ? '.mc-containers' : '.container-row');
    assert.match(os.textContent, /5 min ago/);
    assert.doesNotMatch(os.textContent, /2 h ago/);
    assert.match(containers.textContent, /2 h ago/);
    assert.doesNotMatch(containers.textContent, /just now/);
    assert.ok(os.querySelector('[data-act="upgrade"]'));
    assert.equal(containers.querySelector('[data-act="upgrade"]'), null);
    assert.equal(containers.querySelector('a').getAttribute('href'), 'https://dockhand.example');
    ui.click('[data-machine-menu="apps"][data-menu-scope="containers"]');
    const menu = ui.document.querySelector('#machine-actions');
    assert.ok(menu.querySelector('[data-act="dockhand"]'));
    assert.equal(menu.querySelector('[data-act="check"]'), null);
    assert.equal(menu.querySelector('[data-act="upgrade"]'), null);
    ui.click('[data-machine-menu="apps"][data-menu-scope="machine"]');
    assert.ok(menu.querySelector('[data-act="check"]'));
    assert.ok(menu.querySelector('[data-act="dockhand"]'));
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  }
});

test("container check ages use result ranges and preserve coverage, attempts and unavailable states", async () => {
  const fresh = new Date(Date.now() - 300000).toISOString(), old = new Date(Date.now() - 7200000).toISOString();
  const ui = await dashboard({ containers: true, targets: [
    machine('mixed', { view: { dockhand: { synced_at: now, stale: false, containers: [
      { name: 'new', status: 'current', checked_at: fresh }, { name: 'old', status: 'failed', checked_at: old },
      { name: 'local', status: 'local', checked_at: now }, { name: 'excluded', status: 'excluded', checked_at: now },
      { name: 'unmatched', status: 'unknown' },
    ] } } }),
    machine('empty', { view: { dockhand: { synced_at: now, last_check_at: now, stale: false, containers: [] } } }),
    machine('local-only', { view: { dockhand: { synced_at: now, stale: false, containers: [{ name: 'local', status: 'local' }] } } }),
  ] });
  const mixed = ui.document.querySelector('[data-container-row="mixed"]');
  assert.match(mixed.querySelector('.container-check').textContent, /5 min ago – 2 h ago/);
  assert.match(mixed.querySelector('.container-check').textContent, /1 attempt.*1 unchecked/);
  assert.doesNotMatch(mixed.querySelector('.container-check').textContent, /just now/);
  assert.match(mixed.querySelector('.container-status-cell').textContent, /Partial results/);
  assert.equal(ui.document.querySelector('[data-container-row="empty"] .container-check').textContent, 'Not checked');
  assert.equal(ui.document.querySelector('[data-container-row="local-only"] .container-check').textContent, 'Not applicable');
});

test("rowspan accounting holds with both detail panels open and container KPI preserves parent context", async () => {
  const parent = machine('pve');
  const child = machine('apps', { guest: true, parent: 'pve', target: { backup: { last: now, in_job: true } },
    check: { packages: [{ name: 'curl', current: '1', available: '2' }] },
    view: { dockhand: { stale: false, containers: [{ name: 'web', status: 'update', checked_at: now }] } } });
  const ui = await dashboard({ containers: true, targets: [parent, child, machine('other')] });
  ui.click('[data-kpi="containers"]');
  assert.deepEqual([...ui.document.querySelectorAll('[data-machine-row]')].map(r => r.dataset.machineRow), ['apps']);
  ui.setView('all');
  ui.click('[data-machine-row="apps"] .update-list-hit');
  ui.click('.container-indicator[data-open-docker="apps"]');
  const group = ui.document.querySelector('[data-machine-group="apps"]');
  const table = group.closest('table'), columns = table.querySelectorAll(':scope > colgroup > col').length;
  const rows = [...group.children];
  assert.equal(rows.length, 4);
  let carried = 0;
  rows.forEach(row => {
    assert.equal([...row.children].reduce((n,c) => n + Number(c.getAttribute('colspan') || 1), 0) + carried, columns);
    carried = [...row.children].filter(c => c.getAttribute('rowspan') === '2').length;
  });
  assert.equal(group.querySelectorAll('.machine-cell').length, 1);
  assert.equal(group.querySelectorAll('.backup-cell').length, 1);
  assert.equal(ui.calls.some(c => c.method === 'POST'), false);
});

test("native container jobs do not replace OS status and keep install guards intact", async () => {
  const ui = await dashboard({ targets: [machine('native', { check: { docker_installed: true }, view: {
    active_job: { action: 'stacks' }, stacks: { docker: 'yes', checked_at: now, stacks: [] },
  } })] });
  assert.match(ui.document.querySelector('.scope-os .update-status-cell').textContent, /Up to date/);
  assert.doesNotMatch(ui.document.querySelector('.scope-os .update-status-cell').textContent, /Docker|Checking/);
  assert.match(ui.document.querySelector('.container-status-cell').textContent, /Checking containers/);
  assert.equal(ui.document.querySelector('.scope-os [data-act="upgrade"]'), null);
});

test("All, Machines and Containers share layout while rendering only their own scope and details", async () => {
  for (const mobile of [false, true]) {
    const ui = await dashboard({ containers: true, mobile, targets: [machine('plain'), machine('apps', {
      check: { packages: [{ name: 'curl', current: '1', available: '2' }] },
      view: { dockhand: { stale: false, containers: [{ name: 'web', image: 'web:1', status: 'update', checked_at: now }] } },
    })] });
    const doc = ui.document, os = mobile ? '.mc-os-scope' : '.scope-os', containers = mobile ? '.mc-containers' : '.container-row';
    const pkgs = mobile ? '.mc-package-panel' : '.pkgs', details = mobile ? '.mc-container-panel' : '.container-detail';
    assert.equal(doc.querySelector('#view-all').getAttribute('aria-pressed'), 'true');
    assert.equal(doc.querySelectorAll(os).length, 2);
    assert.equal(doc.querySelectorAll(containers).length, 1);
    ui.click('[data-machine-row="apps"] .update-list-hit');
    ui.click('.container-indicator[data-open-docker="apps"]');
    assert.ok(doc.querySelector(pkgs));
    assert.ok(doc.querySelector(details));
    ui.click('#view-machines');
    assert.equal(doc.querySelectorAll(os).length, 2);
    assert.equal(doc.querySelectorAll(containers).length, 0);
    assert.ok(doc.querySelector(pkgs));
    assert.equal(doc.querySelector(details), null);
    if (!mobile) { ui.state.selected.add('apps'); ui.render(); }
    ui.click('#view-containers');
    assert.equal(doc.querySelectorAll(os).length, 0);
    assert.equal(doc.querySelectorAll(containers).length, 1);
    assert.equal(doc.querySelector(pkgs), null);
    assert.ok(doc.querySelector(details));
    assert.equal(doc.querySelector('#groups [data-act="upgrade"]'), null);
    assert.equal(doc.querySelector('#groups [data-select]'), null);
    assert.equal(doc.querySelector('#bulk-toolbar').hidden, true);
    assert.equal(ui.state.selected.size, 0);
    assert.deepEqual([...doc.querySelectorAll('[data-machine-row]')].map(r => r.dataset.machineRow), ['apps']);
    ui.click('#view-machines');
    assert.ok(ui.informationTrigger('apps'));
    if (!mobile) assert.equal(doc.querySelector('.machine-cell').hasAttribute('rowspan'), false);
    ui.click('#view-all');
    assert.equal(doc.querySelectorAll(os).length, 2);
    assert.equal(doc.querySelectorAll(containers).length, 1);
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  }
});

test("switching to Containers clears incompatible OS filters and keeps exact provider actions", async () => {
  const ui = await dashboard({ containers: true, targets: [machine('os-only', {
    check: { packages: [{ name: 'curl', current: '1', available: '2' }] },
  }), machine('containers-only', { view: { dockhand: { stale: false, containers: [] } } })] });
  ui.click('[data-kpi="updates"]');
  assert.equal(ui.state.view, 'machines');
  ui.click('#view-containers');
  assert.equal(ui.state.filter, null);
  assert.ok(ui.document.querySelector('[data-container-row="containers-only"]'));
  assert.equal(ui.document.querySelector('[data-machine-row="os-only"]'), null);
  ui.click('#view-machines');
  assert.equal(ui.document.querySelectorAll('.scope-os').length, 2);
  assert.equal(ui.document.querySelector('.container-row'), null);
});

test("container help shows actual settings and the effective outcome for scheduled and manual checks", async () => {
  const cases = [
    { scheduled: false, allowed: true, interval: 21600, outcome: /scheduled rounds will not request container checks/ },
    { scheduled: true, allowed: true, interval: 21600, outcome: /fresh Dockhand checks every 6 h/ },
    { scheduled: true, allowed: false, interval: 21600, outcome: /Dockhand check permission is disabled/ },
    { scheduled: true, allowed: true, interval: null, outcome: /schedule is off/ },
    { scheduled: false, allowed: false, interval: null, outcome: /Manual fresh checks are disabled/ },
  ];
  for (const mobile of [false, true]) for (const item of cases) {
    const ui = await dashboard({ containers: true, mobile, dockhandChecks: item.allowed,
      scheduledContainers: item.scheduled, schedule: { check_every: item.interval }, targets: [machine('mapped', {
        view: { dockhand: { stale: false, containers: [] } },
      })] });
    ui.click('[data-open-docker="mapped"]');
    const panel = ui.document.querySelector(mobile ? '.mc-container-panel' : '.container-detail');
    const box = panel.querySelector('.container-check-settings');
    const values = Object.fromEntries([...box.querySelectorAll('dl > div')].map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]));
    assert.deepEqual(values, { 'Container provider': 'Dockhand', 'Fleetdeck scheduled container checks': item.scheduled ? 'On' : 'Off',
      'Manual container checks': item.allowed ? 'Enabled' : 'Disabled', 'Fleetdeck check interval': item.interval ? 'Every 6 h' : 'Scheduling off', 'Read saved Dockhand reports': 'Every 5 min' });
    assert.match(box.querySelector('.container-check-outcome').textContent, item.outcome);
    assert.match(box.textContent, /Dockhand’s own schedule is unchanged/);
    assert.match(panel.querySelector('.container-help').textContent, /schedule.check_docker: true/);
    assert.match(panel.querySelector('.container-help').textContent, /provider, connection and fresh-check permission/);
    assert.equal(panel.querySelector('.container-help a').getAttribute('href'), '/settings');
    assert.equal(panel.querySelector('.container-help').hasAttribute('open'), false);
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
    // Inventory refresh/re-render must update the displayed configuration, not retain fixed copy.
    ui.data.settings.dockhand_checks_allowed = !item.allowed;
    ui.render();
    assert.match(ui.document.querySelector('.container-check-outcome').textContent, item.allowed ? /Manual fresh checks are disabled/ : /Manual fresh checks are enabled/);
  }
});

test("native container guidance describes pulls and host policies without Dockhand configuration instructions", async () => {
  for (const checkOnly of [false, true]) {
    const ui = await dashboard({ containers: true, scheduledContainers: true,
      schedule: { check_every: 3600 }, targets: [machine('native', { target: { check_only: checkOnly },
        check: { docker_installed: true }, view: { docker_settings: { mode: 'monitor' } },
      })] });
    ui.click('[data-open-docker="native"]');
    const panel = ui.document.querySelector('.container-detail');
    const box = panel.querySelector('.container-check-settings');
    assert.match(box.textContent, /Fleetdeck native Docker · monitor only/);
    assert.match(box.textContent, /Every 1 h/);
    assert.match(box.querySelector('.container-check-outcome').textContent, checkOnly ? /native checks are disabled/ : /fresh Compose image checks every 1 h/);
    const help = panel.querySelector('.container-help');
    assert.match(help.textContent, /confirm image downloads/);
    assert.match(help.textContent, /Update stack recreates affected running services/);
    assert.doesNotMatch(help.textContent, /dockhand.allow_checks/);
    assert.equal(panel.querySelector('[data-stack]'), null);
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  }
});

test("update metrics keep a stable order and the top legend follows the selected scope", async () => {
  for (const mobile of [false, true]) {
    const ui = await dashboard({ containers: true, mobile, targets: [
      machine('security', { check: { packages: [{ name: 'ssl', security: true, available: '2' }] } }),
      machine('packages', { check: { packages: [{ name: 'curl', available: '2' }] } }),
      machine('phased', { check: { packages: [{ name: 'app', phased: true, available: '2' }] } }),
      machine('reboot', { check: { reboot_required: true } }),
      machine('docker', { view: { dockhand: { stale: false, containers: [{ name: 'web', status: 'update' }] } } }),
    ] });
    const doc = ui.document;
    for (const [id, index] of [['security',0],['packages',1],['phased',2],['reboot',3]]) {
      const metrics = doc.querySelector(`[data-machine-row="${id}"] .os-metrics`);
      assert.equal(metrics.children.length, 4);
      assert.equal(metrics.children[index].classList.contains('metric-slot-empty'), false);
      assert.equal(metrics.querySelectorAll('.metric-slot-empty').length, 3);
    }
    const metrics = doc.querySelector('.container-indicators');
    assert.equal(metrics.children.length,4);
    assert.equal(metrics.children[0].dataset.containerFilter,'updates');
    assert.equal(metrics.children[1].dataset.metricSlot,'review');
    assert.equal(metrics.children[2].dataset.metricSlot,'coverage');
    assert.equal(metrics.children[3].dataset.metricSlot,'failures');
    assert.equal(doc.querySelector('#view-containers').textContent, 'Containers');
    assert.match(doc.querySelector('#updates-legend').textContent,/OS.*Security.*Packages.*Phased.*Reboot.*Containers.*Image updates.*Review.*Coverage gaps.*Failed checks/);
    ui.click('#view-containers');
    assert.equal(doc.querySelector('#updates-legend').querySelectorAll('.updates-legend-group').length,1);
    assert.equal(doc.querySelector('#updates-legend strong').textContent,'Containers');
    ui.click('#view-machines');
    assert.equal(doc.querySelector('#updates-legend strong').textContent,'OS');
    assert.equal(ui.calls.some(c=>c.method==='POST'),false);
  }
});

test("runtime dots precede escaped container names independently of update-check results", async () => {
  const ui = await dashboard({ containers:true, targets:[machine('docker',{view:{dockhand:{stale:false,containers:[
    {name:'web<script>unsafe</script>',image:'web:1',state:'running',status:'unknown'},
    {name:'worker',image:'worker:1',state:'running',status:'failed'},
    {name:'paused',image:'app:1',state:'paused',status:'current'},
    {name:'stopped',image:'app:1',state:'exited',status:'current'},
  ]}}})] });
  ui.click('[data-open-docker="docker"]');
  const panel=ui.document.querySelector('.container-detail');
  const rows=[...panel.querySelectorAll('.container-results-table tbody tr')];
  const web=rows.find(r=>r.querySelector('.container-name-line').textContent.startsWith('web'));
  assert.ok(web.querySelector('.container-name-line').firstElementChild.classList.contains('running'));
  assert.match(web.textContent,/Check result unavailable/);
  assert.doesNotMatch(web.textContent,/new, unchecked or replaced/);
  assert.match(web.querySelector('.container-result span').getAttribute('title'),/Request a fresh check/);
  assert.equal(panel.querySelector('script'),null);
  const worker=rows.find(r=>r.querySelector('.container-name-line').textContent==='worker');
  assert.ok(worker.querySelector('.container-runtime-dot.running'));
  assert.match(worker.textContent,/Check failed/);
  assert.ok(panel.querySelector('.container-runtime-dot.paused'));
  assert.ok(panel.querySelector('.container-runtime-dot.stopped'));
  assert.equal(ui.calls.some(c=>c.method==='POST'),false);
});

test("upstream own updater stays in OS menus and escaped confirmation alongside Dockhand", async () => {
  for (const mobile of [false, true]) {
    const command = 'omv-upgrade --note "<unsafe>"';
    const target = machine('nas', { guest: true, view: { update_command: command,
      dockhand: { synced_at: now, stale: false, containers: [] } },
      check: { packages: [{ name: 'curl', available: '2' }] } });
    const ui = await dashboard({ targets: [target], containers: true, mobile });
    assert.match(ui.document.querySelector('[data-machine-row="nas"]').textContent, /own updater/);
    ui.click('[data-machine-row="nas"] [data-machine-menu]');
    ui.click('[data-cmd="nas"]');
    assert.equal(ui.document.querySelector('#cmd-dialog').open, true);
    assert.equal(ui.document.querySelector('#cmd-command').value, command);
    ui.document.querySelector('#cmd-dialog').close();
    ui.click('[data-machine-row="nas"] [data-act="upgrade"]');
    assert.match(ui.document.querySelector('#confirm-list').textContent, /omv-upgrade/);
    assert.equal(ui.document.querySelector('#confirm-list unsafe'), null);
    assert.equal(ui.calls.some(c => c.path === '/api/actions' || c.path === '/api/dockhand/check'), false);
  }
});

test("upstream monitor menu blocks deployments without changing native or Dockhand permissions", async () => {
  const target = machine('monitor-menu', { check: { packages: [{ name: 'curl', available: '2' }] } });
  const ui = await dashboard({ targets: [target] });
  ui.click('[data-machine-menu="monitor-menu"]');
  ui.click('[data-monitor="1"]'); await flush();
  assert.equal(target.monitor_only, true);
  assert.equal(ui.document.querySelector('[data-act="upgrade"]'), null);
  assert.equal("docker_enabled" in ui.state.settings, false);
  ui.click('[data-machine-menu="monitor-menu"]');
  ui.click('[data-monitor="0"]'); await flush();
  assert.equal(target.monitor_only, false);
  assert.ok(ui.document.querySelector('[data-act="upgrade"]'));
  assert.equal(ui.calls.filter(c => c.path === '/api/monitor-only').length, 2);
  assert.equal(ui.calls.some(c => c.path === '/api/actions' || c.path === '/api/dockhand/check'), false);
});

test("snapshot defaults follow settings and command configuration cannot be edited in the dialog", async () => {
  const target = machine('configured', { guest: true, target: { update_command: 'omv-upgrade' },
    view: { update_command: 'omv-upgrade' }, check: { packages: [{ name: 'curl', available: '2' }] } });
  const ui = await dashboard({ targets: [target] });
  ui.data.settings.snapshot_before_upgrade = false;
  ui.click('[data-act="upgrade"]');
  assert.equal(ui.document.querySelector('#confirm-snapshot').checked, false);
  ui.document.querySelector('#confirm').close();
  ui.click('[data-machine-menu="configured"]'); ui.click('[data-cmd="configured"]');
  assert.equal(ui.document.querySelector('#cmd-command').disabled, true);
  assert.equal(ui.document.querySelector('#cmd-save').disabled, true);
  assert.equal(ui.document.querySelector('#cmd-config').hidden, false);
});

test("OS metrics filter packages while status restores all types on desktop and mobile", async () => {
  for (const mobile of [false, true]) {
    const ui = await dashboard({ mobile, targets: [machine('filter-os', { check: { packages: [
      { name: 'security-fix', available: '2', security: true },
      { name: 'regular-fix', available: '2' },
      { name: 'phased-fix', available: '2', phased: true },
      { name: 'waiting', available: '2', phased: true, phased_dependency: true },
    ] } })] });
    const names = () => [...ui.document.querySelectorAll('.packages-table .package-name')].map(el => el.textContent);
    for (const [filter, expected] of [['security', ['security-fix']], ['package', ['regular-fix']], ['phased', ['phased-fix', 'waiting']]]) {
      ui.click(`[data-package-filter="${filter}"]`);
      assert.deepEqual(names(), expected);
    }
    ui.click('.os-status-hit');
    assert.equal(names().length, 4);
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  }
});

test("container image metric filters updates and status restores all, with current options collapsed", async () => {
  for (const mobile of [false, true]) {
    const ui = await dashboard({ mobile, containers: true, targets: [machine('filter-containers', { view: { dockhand: {
      synced_at: now, containers: [
        { name: 'needs-update', image: 'web:1', status: 'update', checked_at: now },
        { name: 'current', image: 'db:1', status: 'current', checked_at: now },
        { name: 'local', image: 'local:dev', status: 'local' },
      ],
    } } })] });
    ui.click('[data-container-filter="updates"]');
    const panel = () => ui.document.querySelector(mobile ? '.mc-container-panel' : '.container-detail');
    assert.equal(panel().querySelectorAll('.container-results-table tbody tr').length, 1);
    assert.match(panel().textContent, /needs-update/);
    ui.click('.container-status-hit');
    assert.equal(panel().querySelectorAll('.container-results-table tbody tr').length, 3);
    const help = panel().querySelector('.container-help');
    assert.equal(help.querySelector('summary').textContent, 'Current options and how to change them');
    assert.equal(help.hasAttribute('open'), false);
    assert.ok(help.querySelector('.container-check-settings'));
    assert.equal(ui.calls.some(c => c.method === 'POST'), false);
  }
});

test("backup schedule tooltip, monitor badge order and information popup use visible More anchor", async () => {
  const ui = await dashboard({ targets: [machine('info-anchor', { guest: true, target: {
    backup: { last: now, in_job: true }, monitor_only: true,
  }, view: { monitor_only: true } })] });
  assert.match(ui.document.querySelector('.backup-job').getAttribute('title'), /schedule coverage, not that the last backup succeeded/);
  const badge = ui.document.querySelector('.monitor-policy');
  assert.equal(badge.nextElementSibling, null);
  assert.ok(badge.previousElementSibling.classList.contains('type-chip'));
  const more = ui.document.querySelector('[data-machine-menu]');
  more.getBoundingClientRect = () => ({ right: 400, top: 280, bottom: 300 });
  const info = ui.document.querySelector('#machine-information');
  Object.defineProperty(info, 'offsetHeight', { value: 120 });
  Object.defineProperty(info, 'offsetWidth', { value: 260 });
  ui.click('[data-machine-menu]');
  ui.click('[data-machine-info]');
  assert.equal(info.style.top, '306px');
  assert.equal(info.style.left, '140px');
});

test("Boot up is scoped to eligible stopped Proxmox guests and requires explicit confirmation", async () => {
  for (const mobile of [false, true]) {
    const targets = [machine('stopped-vm', { guest: true, target: { can_start: true, status: 'stopped', updatable: false } }),
      machine('offline-node', { target: { can_start: true, status: 'offline', updatable: false } }),
      machine('protected', { guest: true, target: { status: 'stopped', updatable: false } })];
    const ui = await dashboard({ mobile, targets });
    assert.equal(ui.document.querySelectorAll('[data-act="start"]').length, 1);
    ui.click('[data-act="start"]');
    assert.equal(ui.document.querySelector('#confirm').open, true);
    assert.match(ui.document.querySelector('#confirm-text').textContent, /No updates are installed/);
    assert.equal(ui.calls.some(c => c.path === '/api/actions'), false);
    const dialog = ui.document.querySelector('#confirm');
    dialog.returnValue = 'cancel'; dialog.dispatchEvent(new ui.window.Event('close')); await flush();
    assert.equal(ui.calls.some(c => c.path === '/api/actions'), false);
    ui.click('[data-act="start"]');
    dialog.returnValue = 'ok'; dialog.dispatchEvent(new ui.window.Event('close')); await flush();
    const request = ui.calls.find(c => c.path === '/api/actions');
    assert.equal(JSON.parse(request.body).action, 'start');
    assert.deepEqual(JSON.parse(request.body).target_ids, ['stopped-vm']);
  }
});

test("a newly installed native Docker host appears after an ordinary OS result without changing settings", async () => {
  const host = machine('new-docker', { check: { docker_installed: false } });
  const external = machine('external-docker', { view: { dockhand: { containers: [] }, docker_settings: { mode: 'external' } } });
  const ui = await dashboard({ targets: [host, external] });
  ui.setView('all');
  assert.equal(ui.document.querySelectorAll('[data-container-row="new-docker"]').length, 0);
  host.check.docker_installed = true;
  ui.render();
  assert.equal(ui.document.querySelectorAll('[data-container-row="new-docker"]').length, 1);
  ui.click('[data-machine-menu="new-docker"]');
  assert.ok(ui.document.querySelector('#machine-actions [data-act="stacks"]'));
  ui.click('[data-machine-menu="external-docker"]');
  assert.equal(ui.document.querySelectorAll('#machine-actions [data-act="stacks"]').length, 0);
  assert.ok(ui.document.querySelector('#machine-actions [data-act="dockhand"]'));
  assert.equal(ui.calls.some(c => c.method === 'POST'), false);
});

test("Docker management is per machine and Dockhand fields never ask for a target ID or reveal a token", async () => {
  for (const mobile of [false, true]) {
    const ui = await dashboard({ mobile, targets: [machine('mapped', { view: { dockhand: { containers: [] },
      docker_settings: { mode: 'external', manager_name: 'Dockhand', manager_url: 'https://dockhand.example' } } })] });
    ui.click('[data-machine-menu="mapped"]'); ui.click('[data-docker-settings="mapped"]'); await flush();
    const doc = ui.document;
    assert.equal(doc.querySelector('#docker-settings-dialog').open, true);
    assert.equal(doc.querySelector('#docker-mode').value, 'dockhand');
    assert.equal(doc.querySelector('#dockhand-connection-fields').hidden, false);
    assert.equal(doc.querySelector('#dockhand-token').value, '');
    assert.match(doc.querySelector('#dockhand-token').placeholder, /Leave blank/);
    assert.equal(doc.querySelector('#dockhand-environment').value, '1');
    assert.equal(doc.querySelector('#docker-settings-dialog input[name="target_id"]'), null);
    assert.equal(doc.querySelector('#docker-settings-dialog [id*="machine-id"]'), null);
    assert.equal(ui.calls.some(c => c.method === 'POST' || c.method === 'PUT'), false);
  }
});

test("per-machine Dockhand save maps the chosen machine, clears the token and keeps Apply separate", async () => {
  const ui = await dashboard({ targets: [machine('new-provider')] });
  const doc = ui.document;
  ui.click('[data-machine-menu="new-provider"]'); ui.click('[data-docker-settings="new-provider"]'); await flush();
  doc.querySelector('#docker-mode').value = 'dockhand'; doc.querySelector('#docker-mode').onchange();
  doc.querySelector('#dockhand-url').value = 'https://dockhand.example';
  doc.querySelector('#dockhand-token').value = 'entered-test-token';
  doc.querySelector('#dockhand-environment').value = '4';
  doc.querySelector('#dockhand-poll').value = '300';
  doc.querySelector('#dockhand-allow-checks').checked = true;
  await doc.querySelector('#docker-settings-form').onsubmit({ preventDefault() {} }); await flush();
  const request = ui.calls.find(c => c.path === '/api/setup/docker-management' && c.method === 'PUT');
  const saved = JSON.parse(request.body);
  assert.equal(saved.target_id, 'new-provider'); assert.equal(saved.environment_id, 4);
  assert.equal(saved.token, 'entered-test-token'); assert.equal(saved.allow_checks, true);
  assert.equal(doc.querySelector('#dockhand-token').value, '');
  assert.equal(doc.querySelector('#docker-settings-apply').hidden, false);
  assert.match(doc.querySelector('#docker-settings-status').textContent, /Saved.*Apply/);
  assert.equal(ui.calls.some(c => c.path === '/api/setup/apply' || c.path === '/api/dockhand/check' || c.path === '/api/actions'), false);
  await doc.querySelector('#docker-settings-apply').onclick();
  assert.equal(ui.calls.filter(c => c.path === '/api/setup/apply').length, 1);
});

test("native policies save immediately while read-only Dockhand configuration cannot be saved", async () => {
  const ui = await dashboard({ targets: [machine('native-mode')] });
  const doc = ui.document;
  ui.click('[data-machine-menu="native-mode"]'); ui.click('[data-docker-settings="native-mode"]'); await flush();
  doc.querySelector('#docker-mode').value = 'monitor'; doc.querySelector('#docker-mode').onchange();
  await doc.querySelector('#docker-settings-form').onsubmit({ preventDefault() {} });
  assert.equal(ui.calls.filter(c => c.path === '/api/docker-settings' && c.method === 'PUT').length, 1);
  assert.equal(ui.calls.some(c => c.path === '/api/setup/docker-management' && c.method === 'PUT'), false);
  assert.equal(doc.querySelector('#docker-settings-dialog').open, false);
  const locked = await dashboard({ targets: [machine('locked-provider')], management: { 'locked-provider': {
    revision: 'a'.repeat(64), writable: false, mode: 'dockhand', url: 'https://dockhand.example', token_configured: true,
    poll_seconds: 300, environment_id: 2, shared_hosts: 2, allow_checks: false, can_restart: false,
  } } });
  locked.click('[data-machine-menu="locked-provider"]'); locked.click('[data-docker-settings="locked-provider"]'); await flush();
  assert.equal(locked.document.querySelector('#docker-settings-save').disabled, true);
  assert.match(locked.document.querySelector('#docker-settings-status').textContent, /read-only/);
  assert.match(locked.document.querySelector('#dockhand-shared-note').textContent, /all 2 mapped machines/);
});

test("container overview consolidates counts and keeps history inside current options", async () => {
  const ui = await dashboard({ targets: [machine('compact-panel', { view: { dockhand: {
    synced_at: now, last_check_at: now, scheduled_check_at: now, scheduled_status: 'success', scheduled_checked: 2,
    containers: [{ name: 'current-app', image: 'app:1', status: 'current', checked_at: now },
      { name: 'new-app', image: 'new:1', status: 'update', checked_at: now }],
  } } })] });
  ui.click('.container-status-hit');
  const panel = () => ui.document.querySelector('.container-detail');
  assert.equal(panel().querySelectorAll('.container-summary').length, 0);
  assert.equal(panel().querySelectorAll('.container-results-toolbar .container-filters').length, 1);
  assert.equal(panel().querySelectorAll('.container-results-toolbar .container-sync').length, 1);
  assert.ok(panel().querySelector('.container-help .container-schedule-report'));
  assert.ok(panel().querySelector('.container-help [data-docker-settings="compact-panel"]'));
  ui.click('[data-container-view-filter="current"]');
  assert.equal(panel().querySelectorAll('.container-results-table tbody tr').length, 1);
  assert.match(panel().querySelector('.container-results-table').textContent, /current-app/);
  assert.doesNotMatch(panel().querySelector('.container-results-table').textContent, /new-app/);
  assert.equal(ui.calls.some(c => c.method === 'POST'), false);
});

test("container menus omit machine information and provider management and use a distinct details icon", async () => {
  for (const mobile of [false, true]) {
    const ui = await dashboard({ mobile, dockhandChecks: true, targets: [machine('scoped-menu', { view: {
      dockhand: { synced_at: now, containers: [] }, docker_settings: { mode: 'external', manager_name: 'Dockhand' },
    } })] });
    ui.click('[data-machine-menu="scoped-menu"][data-menu-scope="containers"]');
    const menu = ui.document.querySelector('#machine-actions');
    assert.equal(menu.querySelectorAll('[data-machine-info],[data-docker-settings]').length, 0);
    assert.equal(menu.querySelector('[data-monitor]'), null);
    const details = menu.querySelector('[data-open-docker]');
    const check = menu.querySelector('[data-act="dockhand"]');
    assert.match(details.textContent, /View container details/);
    assert.notEqual(details.querySelector('svg').innerHTML, check.querySelector('svg').innerHTML);
    ui.click('[data-machine-menu="scoped-menu"][data-menu-scope="machine"]');
    assert.ok(menu.querySelector('[data-machine-info]'));
    assert.ok(menu.querySelector('[data-docker-settings]'));
  }
});

test("inventory discovery and update configuration use distinct menu icons", async () => {
  const ui = await dashboard({ targets: [machine('menu-icons')] });
  const glyph = selector => ui.document.querySelector(selector).innerHTML;
  assert.notEqual(glyph('#refresh svg'), glyph('#check-os svg'));
  ui.click('[data-machine-menu="menu-icons"][data-menu-scope="machine"]');
  assert.notEqual(glyph('#machine-actions [data-docker-settings] svg'), glyph('#machine-actions [data-cmd] svg'));
});

test("link-only managers have no monitoring controls or cached native update counts", async () => {
  for (const mobile of [false, true]) {
    const target = machine('other-manager', { view: { docker_settings: { mode: 'external', manager_name: 'Test manager', manager_url: 'https://manager.example' },
      stacks: { checked_at: now, docker: 'Docker', stacks: [{ name: 'old', services: [{ name: 'old', image: 'old:latest', status: 'running', outdated: true }] }] } } });
    const ui = await dashboard({ targets: [target], mobile });
    const doc = ui.document;
    assert.doesNotMatch(doc.querySelector('[data-machine-row="other-manager"]').parentNode.textContent, /Not monitored|Not applicable/);
    assert.equal(doc.querySelectorAll('.container-metric-hit').length, 0);
    const managerLink = doc.querySelector('a.docker-status-link');
    assert.equal(managerLink.getAttribute('href'), 'https://manager.example');
    assert.match(managerLink.textContent, /Test manager/);
    ui.click('[data-machine-menu="other-manager"][data-menu-scope="containers"]');
    const menu = doc.querySelector('#machine-actions');
    assert.equal(menu.querySelector('[data-monitor],[data-act],[data-docker-settings],[data-machine-info]'), null);
    assert.match(menu.textContent, /View management details/);
    ui.click('[data-open-docker="other-manager"]');
    assert.doesNotMatch(doc.querySelector('.docker-host').textContent, /Dockhand|old:latest|Monitor only/);
    ui.click('[data-machine-menu="other-manager"][data-menu-scope="machine"]');
    assert.ok(menu.querySelector('[data-monitor]'));
    ui.click('[data-docker-settings="other-manager"]'); await flush();
    assert.doesNotMatch(doc.querySelector('#docker-mode-help').textContent, /Dockhand/);
    assert.match(doc.querySelector('#docker-mode-help').textContent, /Link only/);
    doc.querySelector('#docker-manager-name').value = 'Another manager';
    await doc.querySelector('#docker-settings-form').onsubmit({ preventDefault() {} });
    assert.equal(ui.state.targets[0].docker_settings.manager_name, 'Another manager');
    assert.match(doc.querySelector('a.docker-status-link').textContent, /Another manager/);
    assert.equal(ui.calls.some(c => c.path === '/api/actions' || c.path === '/api/dockhand/check' || c.path === '/api/setup/apply'), false);
  }
});

test("native container menus keep monitor control and external managers without a URL stay neutral", async () => {
  const ui = await dashboard({ targets: [machine('native-monitor', { check: { docker_installed: true } }),
    machine('no-link', { view: { docker_settings: { mode: 'external', manager_name: 'External manager' } } })] });
  ui.click('[data-machine-menu="native-monitor"][data-menu-scope="containers"]');
  assert.ok(ui.document.querySelector('#machine-actions [data-monitor]'));
  assert.ok(ui.document.querySelector('#machine-actions [data-act="stacks"]'));
  const row = ui.document.querySelector('.container-row[data-machine-row="no-link"]') || ui.document.querySelector('[data-machine-row="no-link"]').parentNode.querySelector('.container-row');
  assert.equal(row.querySelector('.scope-actions [data-docker-settings], .scope-actions a'), null);
  assert.match(row.querySelector('.scope-actions').textContent, /External manager/);
});

test("mobile identity puts machine type beside OS while OS and container actions remain separate", async () => {
  const ui = await dashboard({ mobile: true, rememberedView: 'all', targets: [machine('classic-mobile', { guest: true,
    check: { os: 'Debian 13', packages: [{ name: 'curl', current: '1', available: '2' }] },
    view: { dockhand: { synced_at: now, containers: [] } } })] });
  const card = ui.document.querySelector('.mc-card');
  assert.equal(card.querySelector('.machine-main .type-chip'), null);
  assert.match(card.querySelector('.machine-meta').textContent, /VM.*Debian 13/);
  assert.ok(card.querySelector('.mc-os-scope .mc-status-group'));
  assert.ok(card.querySelector('.mc-os-scope .mc-footer [data-act="upgrade"]'));
  assert.ok(card.querySelector('.mc-os-scope [data-menu-scope="machine"]'));
  assert.ok(card.querySelector('.mc-containers [data-menu-scope="containers"]'));
  assert.equal(card.querySelector('.mc-containers [data-act="upgrade"]'), null);
});

test("mobile name width is independent of dashboard and monitor badges", async () => {
  const ui = await dashboard({ mobile: true, targets: [machine('docker-1', { guest: true, view: { runs_dashboard: true, monitor_only: true } })] });
  const card = ui.document.querySelector('.mc-card');
  assert.equal(card.querySelector('.machine-main').textContent, 'docker-1');
  assert.equal(card.querySelector('.machine-main .chip'), null);
  assert.match(card.querySelector('.machine-meta').textContent, /VM.*dashboard/);
  assert.ok(card.querySelector('.machine-meta .monitor-policy'));
});
